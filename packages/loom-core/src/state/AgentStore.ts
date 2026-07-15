import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { AgentRecord, AgentStatus } from '../types.js';
import type { AttemptClass } from '../orchestrator/resilience/types.js';

/**
 * Random bytes used to suffix every agent id (`agent-<storyId>-<hex>`). The
 * hex length is exactly 2× the byte count. Exported as a single source of
 * truth so callers that match on agent_id shape (e.g.
 * `AuditLog.getByStory`'s length-guarded LIKE) don't silently break if this
 * ever changes.
 */
export const AGENT_ID_RANDOM_BYTES = 4;
export const AGENT_ID_RANDOM_HEX_LEN = AGENT_ID_RANDOM_BYTES * 2;

const TERMINAL_STATUSES = new Set<AgentStatus>(['done', 'failed']);
// 'integrating' is transient — the worker has finished but the rolling
// integrator is folding the story into epic/<id>. It does not occupy a
// worker slot, so it's excluded from ACTIVE_STATUSES (the cap denominator).
const ACTIVE_STATUSES = new Set<AgentStatus>(['running', 'pr_open']);

export class AgentStore {
  constructor(private db: Database.Database) {}

  create(epicId: string, storyId: string, storyTitle?: string): AgentRecord {
    const id = `agent-${storyId}-${crypto.randomBytes(AGENT_ID_RANDOM_BYTES).toString('hex')}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, epicId, storyId, storyTitle ?? null, now);
    return this.get(id)!;
  }

  get(id: string): AgentRecord | undefined {
    return this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as AgentRecord | undefined;
  }

  /** Returns the most recent agent for a story (covers retries).
   *  Tie-break on `id` mirrors `listLatestByEpic`: two attempts written in
   *  the same millisecond return the same row from both APIs, so the status
   *  renderer and downstream callers see a consistent "current" pick. The
   *  winner is the lexicographically larger random-hex suffix —
   *  deterministic but arbitrary; do not treat it as "newest by time." */
  getByStory(storyId: string): AgentRecord | undefined {
    return this.db
      .prepare(
        'SELECT * FROM agents WHERE story_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1'
      )
      .get(storyId) as AgentRecord | undefined;
  }

  listByEpic(epicId: string): AgentRecord[] {
    return this.db
      .prepare('SELECT * FROM agents WHERE epic_id = ? ORDER BY updated_at ASC')
      .all(epicId) as AgentRecord[];
  }

  /**
   * Returns the most recent agent row per story_id for an epic — collapses
   * retry attempts so `loom_get_status` shows one row per story instead of
   * an old `blocked` plus a new `done`. Older attempts are reachable via
   * `listHistoryByStory(storyId)`.
   *
   * Tie-break: when two attempts share the same `updated_at` (same-ms
   * timestamps in tight test loops or bulk updates), pick the one with the
   * lexicographically largest `id`. Agent ids are `agent-<storyId>-<random>`
   * where the random suffix comes from `crypto.randomBytes(4).toString('hex')`
   * — independent of insertion order — so the winner is arbitrary-but-fixed,
   * NOT semantically "newest by time." The point is determinism: the same
   * query always returns the same row, so the status response can't show
   * one story twice. `getByStory` mirrors this ordering so both APIs agree
   * on which row is "current" for a given story.
   */
  listLatestByEpic(epicId: string): AgentRecord[] {
    return this.db
      .prepare(
        `SELECT a.* FROM agents a
         WHERE a.epic_id = ?
           AND a.updated_at = (
             SELECT MAX(updated_at) FROM agents
             WHERE story_id = a.story_id AND epic_id = a.epic_id
           )
           AND a.id = (
             SELECT MAX(id) FROM agents
             WHERE story_id = a.story_id AND epic_id = a.epic_id
               AND updated_at = a.updated_at
           )
         ORDER BY a.updated_at ASC`
      )
      .all(epicId) as AgentRecord[];
  }

  /** All attempts for a story, newest first. Used to render retry history. */
  listHistoryByStory(storyId: string): AgentRecord[] {
    return this.db
      .prepare(
        'SELECT * FROM agents WHERE story_id = ? ORDER BY updated_at DESC'
      )
      .all(storyId) as AgentRecord[];
  }

  /** Used by the supervisor to enforce policy.agents.max_concurrent. */
  countActiveByEpic(epicId: string): number {
    const placeholders = [...ACTIVE_STATUSES].map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM agents WHERE epic_id = ? AND status IN (${placeholders})`
      )
      .get(epicId, ...ACTIVE_STATUSES) as { c: number };
    return row.c;
  }

  /** Convenience for status views and watch loops. Per-story dedup matches
   *  `listLatestByEpic` so a retried story whose old attempt was `blocked`
   *  but whose latest is `done` correctly reports terminal — without the
   *  dedup the watch loop would never finish. */
  allTerminalForEpic(epicId: string): boolean {
    const agents = this.listLatestByEpic(epicId);
    if (agents.length === 0) return false;
    return agents.every((a) => TERMINAL_STATUSES.has(a.status));
  }

  updateStatus(
    id: string,
    status: AgentStatus,
    extra?: Partial<
      Pick<
        AgentRecord,
        'worktree_path' | 'branch_name' | 'pr_url' | 'log_tail' | 'started_at'
      >
    >
  ): void {
    const now = new Date().toISOString();
    const fields: string[] = ['status = ?', 'updated_at = ?'];
    const values: unknown[] = [status, now];

    if (extra?.worktree_path !== undefined) {
      fields.push('worktree_path = ?');
      values.push(extra.worktree_path);
    }
    if (extra?.branch_name !== undefined) {
      fields.push('branch_name = ?');
      values.push(extra.branch_name);
    }
    if (extra?.pr_url !== undefined) {
      fields.push('pr_url = ?');
      values.push(extra.pr_url);
    }
    if (extra?.log_tail !== undefined) {
      fields.push('log_tail = ?');
      values.push(extra.log_tail);
    }
    if (extra?.started_at !== undefined) {
      fields.push('started_at = ?');
      values.push(extra.started_at);
    }
    values.push(id);

    this.db
      .prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  /**
   * Updates the rolling log tail and the durable byte offset together.
   * Used by the Supervisor's flushTails() to persist in-flight worker output.
   * logBytes is the cumulative post-redaction byte length of the on-disk log
   * file; it derives directly from WorkerLogStore.append()'s return value.
   */
  updateLogTail(id: string, logTail: string, logBytes: number = 0): void {
    this.db
      .prepare(
        'UPDATE agents SET log_tail = ?, log_bytes = ?, updated_at = ? WHERE id = ?'
      )
      .run(logTail, logBytes, new Date().toISOString(), id);
  }

  /**
   * Records the OS pid of the running worker subprocess, or clears it on close.
   * Reader processes (e.g. an MCP `loom_stop_agent` call) look this up to send
   * a SIGTERM directly to a specific worker.
   */
  updateWorkerPid(id: string, pid: number | null): void {
    this.db
      .prepare('UPDATE agents SET worker_pid = ?, updated_at = ? WHERE id = ?')
      .run(pid, new Date().toISOString(), id);
  }

  /**
   * Records the outcome of the CodeReviewAgent pass for this agent's story —
   * surfaces in `loom status`, the pi dashboard, and the MCP response so an
   * operator can see review state without opening the audit log.
   */
  setReview(
    id: string,
    status: 'pending' | 'passed' | 'commented' | 'blocked' | 'skipped' | 'errored',
    summary: string
  ): void {
    this.db
      .prepare(
        'UPDATE agents SET review_status = ?, review_summary = ?, updated_at = ? WHERE id = ?'
      )
      .run(status, summary, new Date().toISOString(), id);
  }

  /** Persists worker token usage parsed from stream-json output (Epic 16).
      `request_count` is the per-attempt LLM-request total — the meaningful
      spend signal under the cursor-cli backend (org pricing is per-request,
      not per-token). */
  setUsage(
    id: string,
    usage: {
      tokens_input?: number;
      tokens_output?: number;
      tokens_cached?: number;
      tokens_cache_creation?: number;
      cost_usd?: number;
      request_count?: number;
    }
  ): void {
    this.db
      .prepare(
        `UPDATE agents SET
           tokens_input = ?, tokens_output = ?, tokens_cached = ?,
           tokens_cache_creation = ?, cost_usd = ?, request_count = ?,
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        usage.tokens_input ?? null,
        usage.tokens_output ?? null,
        usage.tokens_cached ?? null,
        usage.tokens_cache_creation ?? null,
        usage.cost_usd ?? null,
        usage.request_count ?? null,
        new Date().toISOString(),
        id
      );
  }

  /**
   * Records how this agent's last attempt was classified (epic-006). Lives on
   * an axis orthogonal to `status` (ADR-1) — pass `null` to clear it (e.g. when
   * a fresh attempt starts). The accompanying `attempt_classified` audit row,
   * which captures the cause/signature, is written separately by the caller
   * via `AuditLog.recordAttemptClassified`.
   */
  setAttemptClass(agentId: string, attemptClass: AttemptClass | null): void {
    this.db
      .prepare(
        'UPDATE agents SET attempt_class = ?, updated_at = ? WHERE id = ?'
      )
      .run(attemptClass, new Date().toISOString(), agentId);
  }

  /**
   * Records the model id this agent executed under (epic-013). Called twice:
   * first at agent creation with the requested policy model, then again when
   * the system/init stream event arrives with the actual executed model.
   * The second call overwrites the first — executed beats requested.
   */
  setModel(id: string, model: string): void {
    this.db
      .prepare('UPDATE agents SET model = ?, updated_at = ? WHERE id = ?')
      .run(model, new Date().toISOString(), id);
  }

  // Throws AgentNotFoundError if agentId is absent.
  incrementReviseRound(agentId: string): void {
    const result = this.db
      .prepare(
        'UPDATE agents SET revise_round = revise_round + 1, updated_at = ? WHERE id = ?'
      )
      .run(new Date().toISOString(), agentId);
    if (result.changes === 0) {
      throw new Error(`AgentNotFoundError: agent '${agentId}' not found`);
    }
  }

  /**
   * Persists the LOOM_PROVIDES trailer parsed from a successful worker's output
   * (epic-095 story-095-004). `json` must be a valid JSON-stringified object.
   * Calling this more than once for the same agent overwrites the prior value.
   */
  setProvidesOutput(agentId: string, json: string): void {
    this.db
      .prepare(
        'UPDATE agents SET provides_output = ?, updated_at = ? WHERE id = ?'
      )
      .run(json, new Date().toISOString(), agentId);
  }

  // Sets the revise-round count to an absolute value (idempotent). Used by the
  // Supervisor to record the actual number of block-and-revise rounds a story's
  // real review loop ran (ReviewOutcome.revisions). No-op if the agent is absent.
  setReviseRound(agentId: string, round: number): void {
    this.db
      .prepare('UPDATE agents SET revise_round = ?, updated_at = ? WHERE id = ?')
      .run(round, new Date().toISOString(), agentId);
  }

  // Returns 0 defensively when agentId is not in the table.
  getReviseRound(agentId: string): number {
    const row = this.db
      .prepare('SELECT revise_round FROM agents WHERE id = ?')
      .get(agentId) as { revise_round: number } | undefined;
    return row?.revise_round ?? 0;
  }
}
