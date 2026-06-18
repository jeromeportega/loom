import type { CommandDescription } from '../describe/schema.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, ControlStore, AgentStore, EpicStore, AuditLog } from '@loom-ai/core';
import type { AgentRecord } from '@loom-ai/core';
import type Database from 'better-sqlite3';

/**
 * Per-worker bound for the stop-time WIP checkpoint. Mirrors the
 * single-source `STOP_CHECKPOINT_TIMEOUT_MS` from the epic-006 resilience
 * constants module (`packages/loom-core/src/orchestrator/resilience/constants.ts`,
 * owned by story-006-003). It is duplicated here only until that module lands
 * and is exported from `@loom-ai/core`; the value is identical (30s) so the
 * swap to the shared import is a one-line, behaviour-preserving change for
 * story-006-010.
 */
const STOP_CHECKPOINT_TIMEOUT_MS = 30_000;

/**
 * Minimal structural mirror of the injectable `RetryClock` from the epic-006
 * resilience module (`packages/loom-core/src/orchestrator/resilience/RetryClock.ts`,
 * owned by story-006-003). Only `setTimeout`/`clearTimeout` are exercised by
 * the stop-time checkpoint bound, but the full shape is declared verbatim so
 * the real exported interface drops in unchanged when 006-003 lands. Tests
 * inject a fake to bound a hung checkpoint with no real sleeps.
 */
export interface RetryClock {
  monotonicNs(): bigint;
  wallMs(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A production `RetryClock` backed by the host's real timers/clocks. */
const realClock: RetryClock = {
  monotonicNs: () => process.hrtime.bigint(),
  wallMs: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Runs one worktree's WIP checkpoint, bounded by `timeoutMs`. Reuses the
 * proven `wip: … [loom]` `--no-verify` machinery from
 * `BaseCliWorker.checkpointUncommitted`: it guards on `git status --porcelain`
 * (no empty checkpoints), clears a stale `index.lock`, then `git add -A` and a
 * `--no-verify` wip commit. `--no-verify` is the existing accepted exception
 * documented in `docs/architecture/worker-resilience.md` — the worker is dead
 * (or about to be) and the target repo's pre-commit hooks could reject the
 * commit and lose the exact work we are saving. The bound is enforced by
 * `execFileSync`'s native `timeout`, so a hung git is killed at the bound
 * rather than blocking the stop. Returns true iff a checkpoint commit was made.
 */
export type CheckpointRunner = (worktreePath: string, timeoutMs: number) => boolean;

function gitInWorktree(worktreePath: string, args: string[], timeoutMs: number): string {
  return execFileSync('git', args, {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  }).trim();
}

const realCheckpointRunner: CheckpointRunner = (worktreePath, timeoutMs) => {
  const dirty = gitInWorktree(worktreePath, ['status', '--porcelain'], timeoutMs);
  if (dirty.length === 0) return false;
  // Clear a stale index.lock left by an interrupted git op. In a worktree
  // `<worktree>/.git` is a file, so resolve the real gitdir first.
  try {
    const gitDir = gitInWorktree(worktreePath, ['rev-parse', '--git-dir'], timeoutMs);
    if (gitDir) {
      const resolvedGitDir = path.isAbsolute(gitDir)
        ? gitDir
        : path.join(worktreePath, gitDir);
      const lock = path.join(resolvedGitDir, 'index.lock');
      if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });
    }
  } catch {
    // Best-effort — the add/commit below surfaces any real problem.
  }
  gitInWorktree(worktreePath, ['add', '-A'], timeoutMs);
  gitInWorktree(worktreePath, [
    'commit',
    '--no-verify',
    '-m',
    'wip: stop checkpoint [loom]',
  ], timeoutMs);
  return true;
};

/** Injectable seams for `checkpointInFlightWorktrees` (defaults are real). */
export interface CheckpointDeps {
  /** Performs (and bounds) one worktree's checkpoint. */
  runCheckpoint?: CheckpointRunner;
}

/**
 * Before `loom stop` halts the run, attempts a bounded WIP-commit in every
 * in-flight worktree so a worker about to be terminated leaves a resumable
 * checkpoint instead of discarding its edits.
 *
 * For each running agent that has a worktree, the checkpoint is capped at
 * `STOP_CHECKPOINT_TIMEOUT_MS` per worker via `clock.setTimeout`. The
 * trade-off is deliberate: a hung checkpoint is abandoned at the bound and the
 * stop proceeds regardless of outcome — a stuck git can never block the halt.
 * The clock and the checkpoint runner are injectable so this is unit-tested
 * with no real sleeps.
 */
export function checkpointInFlightWorktrees(
  db: Database.Database,
  clock: RetryClock = realClock,
  deps: CheckpointDeps = {},
): { storyId: string; checkpointed: boolean }[] {
  const runCheckpoint = deps.runCheckpoint ?? realCheckpointRunner;
  const audit = new AuditLog(db);

  // In-flight worktrees: a `running` worker that has materialized its worktree.
  // Queried directly here (rather than via an AgentStore method) because
  // AgentStore is owned by another epic-006 story and must not be extended here.
  const inFlight = db
    .prepare(
      `SELECT * FROM agents
        WHERE status = 'running' AND worktree_path IS NOT NULL
        ORDER BY updated_at ASC`
    )
    .all() as AgentRecord[];

  const results: { storyId: string; checkpointed: boolean }[] = [];
  for (const agent of inFlight) {
    const worktreePath = agent.worktree_path!;
    let abandoned = false;
    // Arm the per-worker bound. If the checkpoint runs past it, we abandon
    // and move on — the synchronous `runCheckpoint` is itself bounded by the
    // same `timeoutMs` (native `execFileSync` timeout) so the in-process call
    // returns; the clock-driven timer is the contract-level guarantee that a
    // hung worker cannot stall the stop.
    const timer = clock.setTimeout(() => {
      abandoned = true;
    }, STOP_CHECKPOINT_TIMEOUT_MS);

    let checkpointed = false;
    try {
      checkpointed = runCheckpoint(worktreePath, STOP_CHECKPOINT_TIMEOUT_MS) && !abandoned;
    } catch {
      // Hung/failed checkpoint (e.g. the bound fired and killed git): abandon
      // it and proceed. Stop must not depend on the checkpoint succeeding.
      checkpointed = false;
    } finally {
      clock.clearTimeout(timer);
    }

    audit.record({
      agent_id: agent.id,
      action: 'stop_checkpoint',
      command: agent.story_id,
      allowed: true,
      detail: { worktree_path: worktreePath, checkpointed },
    });
    results.push({ storyId: agent.story_id, checkpointed });
  }
  return results;
}

/** Injectable kill fn for `stopEpicWorkers` — always sends SIGTERM; overridden in tests. */
export interface StopDeps {
  kill?: (pid: number) => void;
}

export interface StopEpicResult {
  status: 'ok' | 'not_found';
  stopped: { storyId: string; pid: number }[];
  noop: { storyId: string; agentStatus: string }[];
  errors: { storyId: string; message: string }[];
}

/**
 * Core logic for `loom stop --epic <id>`: terminate every running worker of
 * one epic while leaving other epics running. Records `stop_agent` per
 * worker plus one aggregate `stop_epic` row. Injectable `deps.kill` for tests.
 */
export function stopEpicWorkers(
  db: Database.Database,
  epicId: string,
  reason: string,
  deps: StopDeps = {},
): StopEpicResult {
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const epicStore = new EpicStore(db);
  const agentStore = new AgentStore(db);
  const audit = new AuditLog(db);

  const epic = epicStore.get(epicId);
  if (!epic) {
    return { status: 'not_found', stopped: [], noop: [], errors: [] };
  }

  const agents = agentStore.listLatestByEpic(epicId);
  const stopped: { storyId: string; pid: number }[] = [];
  const noop: { storyId: string; agentStatus: string }[] = [];
  const errors: { storyId: string; message: string }[] = [];

  for (const agent of agents) {
    if (agent.status !== 'running') {
      noop.push({ storyId: agent.story_id, agentStatus: agent.status });
      continue;
    }
    if (!agent.worker_pid) {
      errors.push({ storyId: agent.story_id, message: 'running but no worker_pid recorded' });
      continue;
    }
    try {
      kill(agent.worker_pid);
      stopped.push({ storyId: agent.story_id, pid: agent.worker_pid });
      audit.record({
        agent_id: agent.id,
        action: 'stop_agent',
        command: agent.story_id,
        allowed: true,
        detail: { reason, pid: agent.worker_pid, epic_id: epicId },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = code === 'ESRCH' ? 'worker process already gone' : (err as Error).message;
      errors.push({ storyId: agent.story_id, message: msg });
      audit.record({
        agent_id: agent.id,
        action: 'stop_agent',
        command: agent.story_id,
        allowed: true,
        detail: { reason, success: false, error: msg, epic_id: epicId },
      });
    }
  }

  audit.record({
    action: 'stop_epic',
    command: epicId,
    allowed: true,
    detail: {
      reason,
      stopped: stopped.map((s) => s.storyId),
      noop: noop.map((n) => n.storyId),
      errors: errors.map((e) => e.storyId),
    },
  });

  return { status: 'ok', stopped, noop, errors };
}

/**
 * Core logic for bare `loom stop`: checkpoint in-flight worktrees and raise
 * the supervisor stop signal. Exported for testability — `runStop` delegates
 * to this after validating the loom directory.
 */
export function stopSupervisor(
  db: Database.Database,
  reason = 'cli',
  clock: RetryClock = realClock,
  deps: CheckpointDeps = {},
): { checkpoints: { storyId: string; checkpointed: boolean }[] } {
  const checkpoints = checkpointInFlightWorktrees(db, clock, deps);
  new ControlStore(db).setState('stopping');
  new AuditLog(db).record({
    action: 'stop_agent',
    command: 'supervisor',
    allowed: true,
    detail: { reason, mode: 'supervisor_halt' },
  });
  return { checkpoints };
}

export function runStop(storyIds: string[] = [], opts?: { epic?: string; reason?: string }): void {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
  const reason = opts?.reason || 'cli';

  // ─── loom stop --epic <id> ───────────────────────────────────────────────
  if (opts?.epic) {
    const epicId = opts.epic;
    const result = stopEpicWorkers(db, epicId, reason);
    if (result.status === 'not_found') {
      console.error(`  Epic "${epicId}" not found.`);
      process.exit(1);
    }
    const { stopped, noop, errors } = result;
    if (stopped.length === 0) {
      console.log(
        `\n  No running workers in ${epicId} (${noop.length} non-running, ${errors.length} errored).\n`
      );
    } else {
      console.log(`\n  SIGTERM sent to ${stopped.length} worker(s) in ${epicId}.\n`);
    }
    return;
  }

  if (storyIds.length === 0) {
    // No story ids → graceful run-wide halt. Checkpoint every in-flight
    // worktree FIRST (bounded per worker) so a worker the supervisor is about
    // to terminate leaves a resumable wip commit, then raise the stop signal.
    const { checkpoints } = stopSupervisor(db, reason, realClock);
    const saved = checkpoints.filter((c) => c.checkpointed).length;
    console.log('\n  Stop signal sent.');
    if (checkpoints.length > 0) {
      console.log(
        `  Checkpointed ${saved} of ${checkpoints.length} in-flight worktree(s).`
      );
    }
    console.log('  The supervisor will finish in-flight stories and dispatch no more.');
    console.log('  Continue later with `loom run` — completed stories are skipped.\n');
    return;
  }

  // Per-story stop — SIGTERM the specific worker process.
  const agents = new AgentStore(db);
  const audit = new AuditLog(db);
  let stopped = 0;
  for (const storyId of storyIds) {
    const agent = agents.getByStory(storyId);
    if (!agent) {
      console.log(`  (no agent for "${storyId}")`);
      continue;
    }
    if (agent.status !== 'running') {
      console.log(`  ${storyId}: not running (status: ${agent.status})`);
      continue;
    }
    if (!agent.worker_pid) {
      console.log(`  ${storyId}: running, but no worker_pid recorded`);
      continue;
    }
    try {
      process.kill(agent.worker_pid, 'SIGTERM');
      audit.record({
        agent_id: agent.id,
        action: 'stop_agent',
        command: storyId,
        allowed: true,
        detail: { reason, pid: agent.worker_pid },
      });
      console.log(`  ${storyId}: SIGTERM sent (pid ${agent.worker_pid})`);
      stopped++;
    } catch (err) {
      const msg =
        (err as NodeJS.ErrnoException).code === 'ESRCH'
          ? 'worker process already gone'
          : (err as Error).message;
      console.log(`  ${storyId}: could not signal — ${msg}`);
    }
  }
  console.log(`\n  ${stopped} of ${storyIds.length} requested worker(s) stopped.\n`);
}

export const spec: CommandDescription = {
  name: 'stop',
  summary: 'Halt the supervisor or SIGTERM specific worker(s)',
  whenToUse: 'Use to gracefully stop a running loom session. With no args, halts the supervisor after checkpointing in-flight worktrees. With story ids, stops specific workers. Use --epic to stop all workers in one epic.',
  arguments: [
    { name: 'story-ids', type: 'string', required: false, description: 'Story ids to stop individually; omit to halt the whole run' },
  ],
  options: [
    { name: '--epic', type: 'string', description: 'Stop every running worker in this epic only (leaves other epics running)', changesOutputShape: false },
    { name: '--reason', type: 'string', description: 'Explanation recorded in the audit log (defaults to "cli")', changesOutputShape: false },
  ],
  output: { text: 'Confirmation of SIGTERM sent to stopped workers or stop signal raised' },
  examples: [
    { command: 'loom stop', description: 'Halt the supervisor and checkpoint in-flight worktrees' },
    { command: 'loom stop story-001-003', description: 'SIGTERM the worker for story-001-003' },
    { command: 'loom stop --epic epic-001', description: 'Stop all workers in epic-001 only' },
    { command: 'loom stop --reason "Emergency halt"', description: 'Halt with an audit note' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Stop signal raised or SIGTERM sent' },
    { code: 1, meaning: 'loom not initialized or epic not found' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Epic not found'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'retry', 'run'] },
};
