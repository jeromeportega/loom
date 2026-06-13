/**
 * Mutation routes — approve / reject / retry / stop / kill.
 *
 * Relocated from index.ts (inline) and made ?project-aware so the inbox
 * view can act on epics/agents in peer project DBs. All mutations resolve
 * the target DB via resolveProjectDb, which validates ?project against
 * ProjectRegistry before opening any file (path-traversal guard).
 *
 * Approve is converged onto the same logic as approveAndDispatch: captures
 * the policy snapshot, transitions planned→approved, writes the audit row,
 * then dispatches `loom run <epic-id>` with the resolved project's cwd.
 *
 * No new mutation semantics are introduced here — inbox actions call THESE
 * routes with ?project=<root>; there are no separate inbox mutation handlers.
 *
 * Owner: story-003-004
 */

import { spawn } from 'node:child_process';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { ControlStore, StoryRetryService, PolicyEngine, reopenOpportunityForRejectedEpic } from '@loom-ai/core';
import type { ResolveProjectDb } from '../resolveProjectDb.js';

export interface MutationDeps {
  db: Database.Database;
  resolveProjectDb: ResolveProjectDb;
  /** Default: cwd. Used as spawn cwd when ?project is absent. */
  projectRoot?: string;
  /**
   * Command used to spawn `loom run <epic-id>`. Default: ['loom'].
   * Tests pass ['true'] to stub the child process.
   */
  loomBin?: readonly string[];
  // Accept all extra RouteDeps keys (structural subtype — index.ts passes more).
  [key: string]: unknown;
}

export function registerMutationRoutes(app: Express, deps: MutationDeps): void {
  // ─── POST /api/epics/:id/approve ────────────────────────────────────────────
  app.post('/api/epics/:id/approve', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      const epic = resolved.epicStore.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      if (epic.status !== 'planned') {
        res.status(409).json({
          error: `epic is ${epic.status}; only planned epics can be approved`,
        });
        return;
      }

      // Best-effort policy snapshot (observability only — never blocks approve).
      try {
        const policy = PolicyEngine.defaultPolicy();
        resolved.epicStore.setPolicySnapshot(epic.id, JSON.stringify(policy));
      } catch {
        // intentionally swallowed
      }

      resolved.epicStore.updateStatus(epic.id, 'approved');
      resolved.auditLog.record({
        action: 'epic_approved',
        command: epic.id,
        detail: { actor: 'human' },
      });

      const dispatch = dispatchSupervisor(epic.id, resolved.cwd, deps);
      if (dispatch.pid != null) {
        resolved.auditLog.record({
          action: 'loom_run_via_web',
          command: epic.id,
          detail: { pid: dispatch.pid },
        });
      }

      res.json({
        status: 'dispatching',
        epic_id: epic.id,
        ...(dispatch.pid != null ? { dispatch_pid: dispatch.pid } : {}),
        ...(dispatch.error ? { dispatch_warning: dispatch.error } : {}),
      });
    } finally {
      resolved.cleanup();
    }
  });

  // ─── POST /api/epics/:id/reject ─────────────────────────────────────────────
  app.post('/api/epics/:id/reject', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      const epic = resolved.epicStore.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      if (epic.status !== 'planned') {
        res.status(409).json({
          error: `epic is ${epic.status}; only planned epics can be rejected`,
        });
        return;
      }
      const reason =
        typeof (req.body as Record<string, unknown>)?.reason === 'string'
          ? (req.body as Record<string, unknown>).reason as string
          : undefined;
      resolved.epicStore.updateStatus(epic.id, 'rejected', reason);
      resolved.auditLog.record({
        action: 'epic_rejected',
        command: epic.id,
        detail: reason ? { reason } : undefined,
      });
      reopenOpportunityForRejectedEpic(resolved.db, epic.id);
      res.json({ status: 'rejected', epic_id: epic.id });
    } finally {
      resolved.cleanup();
    }
  });

  // ─── POST /api/stories/:storyId/retry ──────────────────────────────────────
  app.post('/api/stories/:storyId/retry', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      const storyId = req.params.storyId;
      const clean = (req.body as Record<string, unknown>)?.clean === true;
      const reason =
        typeof (req.body as Record<string, unknown>)?.reason === 'string'
          ? (req.body as Record<string, unknown>).reason as string
          : undefined;

      const retry = new StoryRetryService({
        projectRoot: resolved.project_root,
        db: resolved.db,
        clean,
        reason,
      });
      const prep = retry.prepare(storyId);
      if (prep.status === 'error') {
        res.status(404).json({ error: prep.message });
        return;
      }
      if (prep.status === 'rejected') {
        res.status(409).json({ error: prep.message });
        return;
      }

      resolved.auditLog.record({
        action: 'story_retry_via_web',
        command: storyId,
        detail: { epic_id: prep.epicId, clean, reset_stories: prep.resetStories },
      });
      const dispatch = dispatchSupervisor(prep.epicId!, resolved.cwd, deps);
      if (dispatch.pid != null) {
        resolved.auditLog.record({
          action: 'loom_run_via_web',
          command: prep.epicId!,
          detail: { pid: dispatch.pid, retry_of: storyId },
        });
      }

      res.json({
        status: 'dispatching',
        story_id: storyId,
        epic_id: prep.epicId,
        clean,
        will_resume: prep.willResume,
        reset_stories: prep.resetStories,
        ...(dispatch.pid != null ? { dispatch_pid: dispatch.pid } : {}),
        ...(dispatch.error ? { dispatch_warning: dispatch.error } : {}),
      });
    } finally {
      resolved.cleanup();
    }
  });

  // ─── POST /api/stop ─────────────────────────────────────────────────────────
  app.post('/api/stop', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      new ControlStore(resolved.db).setState('stopping');
      resolved.auditLog.record({ action: 'loom_stop_via_web' });
      res.json({ status: 'stopping' });
    } finally {
      resolved.cleanup();
    }
  });

  // ─── POST /api/epics/:id/resume — restart a checkpoint-paused epic ─────────
  // Clears paused_at / paused_after_story and re-dispatches the supervisor.
  // Only meaningful when the epic isPaused(); other statuses are rejected.
  app.post('/api/epics/:id/resume', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      const epic = resolved.epicStore.get(req.params.id);
      if (!epic) {
        res.status(404).json({ error: 'epic not found' });
        return;
      }
      const row = epic as typeof epic & { paused_at?: string | null };
      if (row.paused_at == null) {
        res.status(409).json({ error: 'epic is not paused; nothing to resume' });
        return;
      }
      resolved.epicStore.resume(epic.id);
      resolved.auditLog.record({
        action: 'epic_resumed',
        command: epic.id,
        detail: { actor: 'human' },
      });

      const dispatch = dispatchSupervisor(epic.id, resolved.cwd, deps);
      if (dispatch.pid != null) {
        resolved.auditLog.record({
          action: 'loom_run_via_web',
          command: epic.id,
          detail: { pid: dispatch.pid },
        });
      }

      res.json({
        status: 'dispatching',
        epic_id: epic.id,
        ...(dispatch.pid != null ? { dispatch_pid: dispatch.pid } : {}),
        ...(dispatch.error ? { dispatch_warning: dispatch.error } : {}),
      });
    } finally {
      resolved.cleanup();
    }
  });

  // ─── POST /api/agents/:id/kill ──────────────────────────────────────────────
  app.post('/api/agents/:id/kill', (req, res) => {
    let resolved;
    try {
      resolved = deps.resolveProjectDb(req);
    } catch (err) {
      const code = (err as Error & { statusCode?: number }).statusCode ?? 400;
      res.status(code).json({ error: (err as Error).message });
      return;
    }
    try {
      const agent = resolved.agentStore.get(req.params.id);
      if (!agent) {
        res.status(404).json({ error: 'agent not found' });
        return;
      }
      const pid = agent.worker_pid;
      if (pid == null) {
        res.status(409).json({ error: 'agent has no running worker (worker_pid is null)' });
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
        resolved.auditLog.record({
          agent_id: agent.id,
          action: 'loom_kill_via_web',
          command: agent.story_id,
          detail: { pid },
        });
        res.json({ status: 'killed', pid, story_id: agent.story_id });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          res.status(409).json({ error: 'worker process already exited', pid });
          return;
        }
        res.status(500).json({ error: (err as Error).message });
      }
    } finally {
      resolved.cleanup();
    }
  });
}

function dispatchSupervisor(
  epicId: string,
  cwd: string,
  deps: MutationDeps
): { pid?: number; error?: string } {
  const argv: readonly string[] = deps.loomBin ?? ['loom'];
  const [cmd, ...prefixArgs] = argv;
  if (!cmd) return { error: 'loomBin was empty' };
  try {
    const child = spawn(cmd, [...prefixArgs, 'run', epicId], {
      cwd,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { pid: child.pid };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
