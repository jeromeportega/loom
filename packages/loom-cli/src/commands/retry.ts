import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentStore,
  EpicStore,
  AuditLog,
  LeaseStore,
  StoryRetryService,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import type Database from 'better-sqlite3';
import { runRun } from './run.js';

export interface RetryOptions {
  /**
   * Clean retry: discard the prior attempt's worktree + branch (and those of
   * every story stacked on it) so the story re-runs from scratch. Default
   * false — a resume retry keeps the branch and feeds the handoff doc back to
   * the worker. Forwarded to the shared {@link StoryRetryService}.
   */
  clean?: boolean;
  /** Optional explanation recorded with the retry in the audit log. */
  reason?: string;
  /**
   * Bypass the running-state guard. Normally `prepareRetry` rejects a story
   * that is still `running`; setting this to `true` skips that check. Used by
   * `loom stop --and-retry` after the stop has been confirmed terminal, and
   * directly via `loom retry --force`.
   */
  force?: boolean;
  /**
   * Override the project root used by `runRetry` when opening the database and
   * resolving the loom directory. Defaults to `process.cwd()`. Injected by
   * `loom stop --and-retry` so the retry step uses the same project root as the
   * stop step rather than opening a second DB from the real cwd.
   */
  projectRoot?: string;
}

/**
 * Outcome of {@link prepareRetry}: whether the story is ready and, if so, who
 * dispatches it. `dispatch: 'self'` means no live run holds the epic — the
 * caller must build a Supervisor and `run([epicId])`. `dispatch: 'queue'`
 * means a live supervisor already holds the dispatch lease, so the story was
 * only reset-to-ready: that lease-holder re-dispatches it on its next loop and
 * a second supervisor must NOT be started (it would race into the idempotent
 * worktree). Both ready paths also grant a fresh auto-retry budget.
 */
export interface RetryPrep {
  status: 'ready' | 'rejected' | 'error';
  storyId: string;
  epicId?: string;
  /** Only meaningful when status === 'ready'. */
  dispatch?: 'self' | 'queue';
  /** True when the worktree(s) + branch(es) were torn down for a fresh run. */
  cleaned: boolean;
  /** Stories reset to re-run (the target + any cascaded clean dependents). */
  resetStories: string[];
  /** Whether a handoff doc will be fed to the resumed worker (resume retry). */
  willResume: boolean;
  message: string;
}

/**
 * Clears the persisted attempt classification for every recorded attempt of a
 * story — the operator-retry side of the auto-retry budget. A worker that
 * exhausted its bounded infra auto-retries lands `failed` with
 * `attempt_class = 'infra_failure'`; clearing it back to NULL is what "grants a
 * fresh auto-retry budget" means in practice: the next dispatch starts from a
 * clean slate, with the worker's in-process {@link InfraRetryController} budget
 * (already per-spawn) un-shadowed by a stale terminal classification. Done for
 * every historical attempt row so no prior classification lingers on the story.
 */
function resetAutoRetryBudget(agents: AgentStore, storyIds: string[]): void {
  for (const storyId of storyIds) {
    for (const attempt of agents.listHistoryByStory(storyId)) {
      agents.setAttemptClass(attempt.id, null);
    }
  }
}

/**
 * Lease-aware preparation for `loom retry`. Resolves the story's epic, then
 * branches on the dispatch lease:
 *
 *   - **Lease held by a live run (queue path).** The {@link StoryRetryService}
 *     deliberately refuses to prepare while another supervisor holds the epic
 *     (it would race the retry into the same idempotent worktree). So we do the
 *     minimal, race-free reset HERE instead: flip the failed/blocked attempt
 *     back to `pending` and the epic to `in_progress` so the lease-holder
 *     re-dispatches the story on its next loop, and grant a fresh auto-retry
 *     budget. We do NOT self-dispatch and we do NOT tear down worktrees — a
 *     `--clean` teardown while a live run is dispatching the epic would race
 *     it, so clean is downgraded to a soft reset with a note.
 *   - **No live lease (self path).** Delegate the full prepare (resume vs clean
 *     teardown, dependent cascade, epic flip, audit) to the shared
 *     {@link StoryRetryService}, grant a fresh auto-retry budget, and signal the
 *     caller to self-dispatch.
 *
 * Pure over its injected `db` — no Supervisor, no spawning — so it is unit
 * tested directly. {@link runRetry} wires the real DB and dispatch around it.
 */
export function prepareRetry(
  db: Database.Database,
  projectRoot: string,
  storyId: string,
  opts: RetryOptions = {},
  leaseStore?: LeaseStore
): RetryPrep {
  const clean = opts.clean === true;
  const reason = opts.reason ?? 'cli';
  const agents = new AgentStore(db);
  const epics = new EpicStore(db);
  const lease = leaseStore ?? new LeaseStore(db);

  const base = (over: Partial<RetryPrep>): RetryPrep => ({
    status: 'error',
    storyId,
    cleaned: false,
    resetStories: [],
    willResume: false,
    message: '',
    ...over,
  });

  const agent = agents.getByStory(storyId);
  if (!agent) {
    return base({ status: 'error', message: `No agent on record for story "${storyId}".` });
  }
  if (agent.status === 'running' && !opts.force) {
    return base({
      status: 'rejected',
      epicId: agent.epic_id,
      message: `Story "${storyId}" is still running. Stop it first (loom stop ${storyId}), then retry.`,
    });
  }

  const epicId = agent.epic_id;
  const epic = epics.get(epicId);
  if (!epic) {
    return base({ status: 'error', epicId, message: `Epic "${epicId}" not found.` });
  }

  // ─── Queue path: a live supervisor already dispatches this epic. ───────────
  // Reset-to-ready in place and let it pick the story up; never self-dispatch.
  if (lease.heldByOther(epicId)) {
    agents.updateStatus(agent.id, 'pending');
    epics.updateStatus(epicId, 'in_progress');
    resetAutoRetryBudget(agents, [storyId]);

    new AuditLog(db).record({
      agent_id: agent.id,
      action: 'story_retry',
      command: storyId,
      allowed: true,
      detail: {
        epic_id: epicId,
        clean,
        reason,
        reset_stories: [storyId],
        prior_status: agent.status,
        dispatch: 'queue',
        budget_reset: true,
      },
    });

    const holder = lease.holder(epicId);
    const cleanNote = clean
      ? ' (--clean teardown skipped: a live run holds the epic; resetting in place to avoid racing it)'
      : '';
    return base({
      status: 'ready',
      epicId,
      dispatch: 'queue',
      cleaned: false,
      resetStories: [storyId],
      willResume: !clean,
      message:
        `Reset "${storyId}" to ready with a fresh auto-retry budget. A live run` +
        (holder ? ` (pid ${holder.pid} on ${holder.hostname})` : '') +
        ` holds ${epicId}; it will re-dispatch the story.${cleanNote}`,
    });
  }

  // ─── Self path: no live lease — prepare via the shared service + dispatch. ──
  const service = new StoryRetryService({
    projectRoot,
    db,
    clean,
    reason,
    leaseStore: lease,
  });
  const prep = service.prepare(storyId);
  if (prep.status !== 'ready') {
    return base({
      status: prep.status,
      epicId: prep.epicId,
      cleaned: prep.cleaned,
      resetStories: prep.resetStories,
      willResume: prep.willResume,
      message: prep.message,
    });
  }

  resetAutoRetryBudget(agents, prep.resetStories);

  return {
    status: 'ready',
    storyId,
    epicId: prep.epicId,
    dispatch: 'self',
    cleaned: prep.cleaned,
    resetStories: prep.resetStories,
    willResume: prep.willResume,
    message: `${prep.message} Granted a fresh auto-retry budget.`,
  };
}

/**
 * `loom retry <story-id> [--clean]` — reset a failed/blocked story and re-run
 * it, end to end, with no hand-written scripts. Built on the shared
 * {@link StoryRetryService} and made lease-aware: when a live epic dispatch run
 * holds the lease the story is reset-to-ready and that run re-dispatches it
 * (queue path); only when no lease is held does this command build a Supervisor
 * and dispatch the epic itself (self path). Either way the story AND a fresh
 * auto-retry budget are reset.
 */
export async function runRetry(storyId: string, opts: RetryOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const prep = prepareRetry(db, projectRoot, storyId, opts);

  if (prep.status !== 'ready') {
    console.error(`\n  ${prep.message}\n`);
    process.exit(1);
  }

  console.log(`\n  ${prep.message}`);
  if (prep.cleaned && prep.resetStories.length > 1) {
    console.log(`  Reset stories: ${prep.resetStories.join(', ')}`);
  }

  if (prep.dispatch === 'queue') {
    // A live run owns the epic — it re-dispatches the reset story. Starting a
    // second Supervisor here would race it into the same idempotent worktree.
    console.log('  Track with `loom status`.\n');
    return;
  }

  // Self path — no live lease. Build the fully-wired Supervisor (reusing the
  // exact dispatch wiring `loom run` uses) and dispatch just this story's epic.
  await runRun([prep.epicId!]);
}

export const spec: CommandDescription = {
  name: 'retry',
  summary: 'Reset a failed/blocked story and re-dispatch it',
  whenToUse: 'Use when a story has failed or is blocked and you want to re-run it. Lease-aware: attaches to a live run if one exists, otherwise dispatches fresh. Grants a fresh auto-retry budget.',
  arguments: [
    { name: 'story-id', type: 'string', required: true, description: 'Story id to retry (e.g. story-001-003)' },
  ],
  options: [
    { name: '--clean', type: 'boolean', description: 'Tear down the worktree and branch so the story re-runs from scratch instead of resuming', changesOutputShape: false },
    { name: '--force', type: 'boolean', description: 'Bypass the running-state guard and enqueue a retry even if the story is still marked running', changesOutputShape: false },
    { name: '--reason', type: 'string', description: 'Explanation recorded with the retry in the audit log', changesOutputShape: false },
  ],
  output: { text: 'Confirmation of the retry dispatch and the story branch' },
  examples: [
    { command: 'loom retry story-001-003', description: 'Retry a failed story, resuming from the last worktree state' },
    { command: 'loom retry story-001-003 --clean', description: 'Retry from scratch by tearing down the worktree' },
    { command: 'loom retry story-001-003 --force', description: 'Enqueue a retry bypassing the running-state guard' },
    { command: 'loom retry story-001-003 --reason "Fixed flaky dependency"', description: 'Retry with an audit note' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Story re-dispatched successfully' },
    { code: 1, meaning: 'Story not found or loom not initialized' },
  ],
  errors: ['Story not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'stop'] },
};
