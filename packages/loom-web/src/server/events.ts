import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore } from '@loom-ai/core';

/**
 * Server-Sent Events handler for /api/events. Each connection holds its
 * own per-poll snapshot of agent log_tails and emits diffs as new bytes
 * arrive — surfaces live worker stdout to the dashboard without the
 * supervisor and the web server needing to share an in-process event bus.
 *
 * Polling cadence is 500ms by default — matches the Supervisor's tail
 * flush of 1s comfortably without thrashing the DB. SQLite WAL mode
 * (already enabled) handles the concurrent read load.
 *
 * Heartbeat comment every 15s keeps the connection alive through proxies
 * that idle-close streams (corporate HTTPS terminators are the usual
 * culprit; not an issue on localhost, but cheap insurance).
 *
 * Cleanup runs on req.close — the polling interval stops, no leaked
 * timers. Tests verify this.
 */
export interface EventStreamOptions {
  db: Database.Database;
  /** Poll interval in ms. Default 500. */
  pollMs?: number;
}

export function eventStreamHandler(opts: EventStreamOptions) {
  const epicStore = new EpicStore(opts.db);
  const agentStore = new AgentStore(opts.db);
  const pollMs = opts.pollMs ?? 500;

  return (req: Request, res: Response): void => {
    // SSE headers. `X-Accel-Buffering: no` defeats nginx/express's default
    // response buffering so events flush as soon as they're written.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const epoch = `${process.pid}-${Date.now()}`;
    emit(res, 'hello', { epoch });

    // Per-connection snapshots. Diff against these on every poll.
    const epicSnapshots = new Map<string, {
      status: string;
      phase: string | null;
      updated_at: string;
      title: string;
      autonomy_level: string;
      paused_at: string | null;
    }>();
    const agentSnapshots = new Map<string, { status: string; pr_url: string | null; updated_at: string }>();
    const tailSnapshots = new Map<string, string>();

    let closed = false;

    const heartbeat = setInterval(() => {
      if (closed) return;
      // SSE comment line — ignored by the client but keeps the TCP connection warm.
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 15000);

    const tick = (): void => {
      if (closed) return;
      try {
        // ─── Epic changes (incl. planning phase transitions) ─────────────
        const epics = epicStore.list();
        for (const epic of epics) {
          const prev = epicSnapshots.get(epic.id);
          // autonomy_level and paused_at are added by story-003-001 (schema v16).
          // Guard against pre-v16 rows that don't have these columns yet.
          const epicRow = epic as typeof epic & {
            autonomy_level?: string | null;
            paused_at?: string | null;
          };
          const autonomy_level = (epicRow.autonomy_level ?? 'manual') as string;
          const paused_at = epicRow.paused_at ?? null;
          if (
            !prev ||
            prev.status !== epic.status ||
            prev.phase !== (epic.planning_phase ?? null) ||
            prev.title !== epic.title ||
            prev.updated_at !== epic.updated_at ||
            prev.autonomy_level !== autonomy_level ||
            prev.paused_at !== paused_at
          ) {
            // Per-story dedup so the SSE epic-card counts match the REST
            // list endpoint and MCP get_status — a retried story counts once.
            const counts = agentStore.listLatestByEpic(epic.id).reduce(
              (acc, a) => {
                acc.total += 1;
                if (a.status === 'done' || a.status === 'pr_open') acc.done += 1;
                else if (a.status === 'failed') acc.failed += 1;
                else if (a.status === 'blocked') acc.blocked += 1;
                else if (a.status === 'running') acc.running += 1;
                else acc.pending += 1;
                return acc;
              },
              { total: 0, done: 0, failed: 0, blocked: 0, pending: 0, running: 0 }
            );
            emit(res, 'epic', {
              id: epic.id,
              title: epic.title,
              status: epic.status,
              planning_phase: epic.planning_phase ?? null,
              stories: counts,
              updated_at: epic.updated_at,
              archived: epic.archived_at != null,
              // Additive fields per ADR-6 / epic-003 contract §11.
              // Consumers ignore unknown keys; pre-v16 rows default to 'manual'/false.
              autonomy_level,
              paused: paused_at != null,
            });
            epicSnapshots.set(epic.id, {
              status: epic.status,
              phase: epic.planning_phase ?? null,
              updated_at: epic.updated_at,
              title: epic.title,
              autonomy_level,
              paused_at,
            });
          }
        }

        // ─── Agent + log_tail diffs ──────────────────────────────────────
        // Read each epic's agents in turn; emit on any change. The log_tail
        // diff (new bytes since last poll) becomes an 'output' event so
        // the UI can append to a live pane without a full re-render.
        for (const epic of epics) {
          for (const a of agentStore.listByEpic(epic.id)) {
            const prev = agentSnapshots.get(a.id);
            if (
              !prev ||
              prev.status !== a.status ||
              prev.pr_url !== a.pr_url ||
              prev.updated_at !== a.updated_at
            ) {
              emit(res, 'agent', {
                id: a.id,
                story_id: a.story_id,
                story_title: a.story_title,
                status: a.status,
                pr_url: a.pr_url,
                started_at: a.started_at,
                updated_at: a.updated_at,
                review_status: a.review_status,
                review_summary: a.review_summary,
                tokens_total: usageTotal(a),
                cost_usd: a.cost_usd,
                request_count: a.request_count,
                epic_id: epic.id,
              });
              agentSnapshots.set(a.id, {
                status: a.status,
                pr_url: a.pr_url,
                updated_at: a.updated_at,
              });
            }

            const prevTail = tailSnapshots.get(a.id) ?? '';
            const tail = a.log_tail ?? '';
            if (tail.length > prevTail.length && tail.startsWith(prevTail)) {
              // Simple suffix — the supervisor appends to log_tail.
              const chunk = tail.slice(prevTail.length);
              emit(res, 'output', { agent_id: a.id, story_id: a.story_id, chunk });
              tailSnapshots.set(a.id, tail);
            } else if (tail !== prevTail) {
              // Truncation or replacement (final log_tail overwrites the
              // rolling buffer on completion). Emit the whole new tail.
              emit(res, 'output', { agent_id: a.id, story_id: a.story_id, chunk: tail });
              tailSnapshots.set(a.id, tail);
            }
          }
        }
      } catch (err) {
        emit(res, 'error', { message: (err as Error).message });
      }
    };

    // Run one poll immediately so the client gets the current state without
    // waiting for the first interval tick.
    tick();
    const interval = setInterval(tick, pollMs);

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already closed */ }
    };
    req.on('close', close);
    req.on('aborted', close);
    res.on('close', close);
  };
}

function emit(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Connection closed mid-write — handled by the close listener.
  }
}

function usageTotal(a: ReturnType<AgentStore['listByEpic']>[number]): number | null {
  if (
    a.tokens_input == null &&
    a.tokens_output == null &&
    a.tokens_cached == null &&
    a.tokens_cache_creation == null
  ) {
    return null;
  }
  return (
    (a.tokens_input ?? 0) +
    (a.tokens_output ?? 0) +
    (a.tokens_cached ?? 0) +
    (a.tokens_cache_creation ?? 0)
  );
}
