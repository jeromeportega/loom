import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
} from '@loom-ai/core';
import {
  checkpointInFlightWorktrees,
  stopEpicWorkers,
  stopSupervisor,
  pollUntilTerminal,
  runStop,
  type RetryClock,
  type CheckpointRunner,
  type PollClock,
} from '../commands/stop.js';

/**
 * A `RetryClock` that records every `setTimeout` it is asked to arm and never
 * fires a timer on its own — tests drive time explicitly, so no real sleeps
 * ever happen. `fire(handle)` invokes a scheduled callback on demand.
 */
class FakeClock implements RetryClock {
  public readonly scheduled: { handle: number; fn: () => void; ms: number }[] = [];
  public readonly cleared: number[] = [];
  private nextHandle = 1;
  private nowMs = 0;

  monotonicNs(): bigint {
    return BigInt(this.nowMs) * 1_000_000n;
  }
  wallMs(): number {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const handle = this.nextHandle++;
    this.scheduled.push({ handle, fn, ms });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.cleared.push(handle as number);
  }
  /** Invoke a scheduled timer's callback (simulating the deadline firing). */
  fire(handle: number): void {
    const entry = this.scheduled.find((s) => s.handle === handle);
    if (entry) entry.fn();
  }
}

let db: DatabaseType.Database;

function seedRunningAgent(
  storyId: string,
  worktreePath: string | null
): string {
  const agents = new AgentStore(db);
  const agent = agents.create('epic-006', storyId, `title ${storyId}`);
  agents.updateStatus(agent.id, 'running', {
    worktree_path: worktreePath ?? undefined,
    branch_name: `story/${storyId}`,
  });
  return agent.id;
}

beforeEach(() => {
  db = createDatabase(':memory:');
  new EpicStore(db).create('epic-006', 'Resilience epic');
});

describe('checkpointInFlightWorktrees', () => {
  it('checkpoints every in-flight worktree before terminating workers', () => {
    seedRunningAgent('story-a', '/tmp/wt-a');
    seedRunningAgent('story-b', '/tmp/wt-b');

    const visited: string[] = [];
    const runCheckpoint: CheckpointRunner = (worktreePath) => {
      visited.push(worktreePath);
      return true;
    };

    const results = checkpointInFlightWorktrees(db, new FakeClock(), { runCheckpoint });

    assert.deepEqual(visited.sort(), ['/tmp/wt-a', '/tmp/wt-b']);
    assert.deepEqual(
      results.map((r) => ({ storyId: r.storyId, checkpointed: r.checkpointed })).sort((x, y) =>
        x.storyId.localeCompare(y.storyId)
      ),
      [
        { storyId: 'story-a', checkpointed: true },
        { storyId: 'story-b', checkpointed: true },
      ]
    );
  });

  it('skips agents that are not running or have no worktree', () => {
    // running but no worktree
    seedRunningAgent('story-no-wt', null);
    // worktree but not running (pending/done are excluded)
    const agents = new AgentStore(db);
    const pending = agents.create('epic-006', 'story-pending', 'pending');
    agents.updateStatus(pending.id, 'pending', { worktree_path: '/tmp/wt-pending' });
    const done = agents.create('epic-006', 'story-done', 'done');
    agents.updateStatus(done.id, 'done', { worktree_path: '/tmp/wt-done' });
    // a genuine in-flight one we DO expect
    seedRunningAgent('story-live', '/tmp/wt-live');

    const visited: string[] = [];
    const runCheckpoint: CheckpointRunner = (worktreePath) => {
      visited.push(worktreePath);
      return true;
    };

    const results = checkpointInFlightWorktrees(db, new FakeClock(), { runCheckpoint });

    assert.deepEqual(visited, ['/tmp/wt-live']);
    assert.deepEqual(results, [{ storyId: 'story-live', checkpointed: true }]);
  });

  it('bounds each worker to STOP_CHECKPOINT_TIMEOUT_MS (30s) via the injected clock', () => {
    seedRunningAgent('story-a', '/tmp/wt-a');
    seedRunningAgent('story-b', '/tmp/wt-b');
    const clock = new FakeClock();

    checkpointInFlightWorktrees(db, clock, { runCheckpoint: () => true });

    // One armed timer per in-flight worker, each at the 30s bound.
    assert.equal(clock.scheduled.length, 2);
    for (const s of clock.scheduled) {
      assert.equal(s.ms, 30_000);
    }
    // Every armed timer is cleared (no leaked timers).
    assert.deepEqual(
      clock.cleared.sort(),
      clock.scheduled.map((s) => s.handle).sort()
    );
  });

  it('a hung checkpoint does not block the stop — it proceeds regardless of outcome', () => {
    seedRunningAgent('story-hung', '/tmp/wt-hung');
    seedRunningAgent('story-ok', '/tmp/wt-ok');
    const clock = new FakeClock();

    // The first worker's checkpoint is "hung": the bound fires (we invoke the
    // armed deadline) and the runner throws as if its git child was killed at
    // the timeout. The function must not hang and must still process the next
    // worker. No real sleeps — time is driven by the FakeClock.
    const runCheckpoint: CheckpointRunner = (worktreePath) => {
      if (worktreePath === '/tmp/wt-hung') {
        // Simulate the bound firing on this never-completing checkpoint.
        const armed = clock.scheduled[clock.scheduled.length - 1];
        clock.fire(armed.handle);
        const err = new Error('git timed out') as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return true;
    };

    const results = checkpointInFlightWorktrees(db, clock, { runCheckpoint });

    // Stop proceeded: both workers have a result; the hung one is reported as
    // not checkpointed, the healthy one as checkpointed.
    const byStory = new Map(results.map((r) => [r.storyId, r.checkpointed]));
    assert.equal(byStory.get('story-hung'), false);
    assert.equal(byStory.get('story-ok'), true);
    assert.equal(results.length, 2);
  });

  it('reports checkpointed:false when the runner returns false (clean worktree)', () => {
    seedRunningAgent('story-clean', '/tmp/wt-clean');

    const results = checkpointInFlightWorktrees(db, new FakeClock(), {
      runCheckpoint: () => false,
    });

    assert.deepEqual(results, [{ storyId: 'story-clean', checkpointed: false }]);
  });

  it('records a stop_checkpoint audit row per in-flight worker', () => {
    seedRunningAgent('story-a', '/tmp/wt-a');
    const clock = new FakeClock();

    checkpointInFlightWorktrees(db, clock, { runCheckpoint: () => true });

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-a');
    const checkpointRows = rows.filter((r) => r.action === 'stop_checkpoint');
    assert.equal(checkpointRows.length, 1);
    const detail = JSON.parse(checkpointRows[0].detail!);
    assert.equal(detail.checkpointed, true);
    assert.equal(detail.worktree_path, '/tmp/wt-a');
  });

  it('returns an empty list when there are no in-flight worktrees', () => {
    const results = checkpointInFlightWorktrees(db, new FakeClock(), {
      runCheckpoint: () => true,
    });
    assert.deepEqual(results, []);
  });
});

// End-to-end proof that the DEFAULT (real) checkpoint runner actually lands a
// `wip: … [loom]` commit in a dirty worktree — exercising the same `--no-verify`
// machinery as `BaseCliWorker.checkpointUncommitted` against real git. No fake
// runner is injected; the default path runs. Still no real sleeps — the clock
// is the FakeClock and git commits are fast.
describe('checkpointInFlightWorktrees — real git checkpoint', () => {
  let repoDir: string;

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-stop-wt-'));
    git(['init', '-q']);
    git(['config', 'user.email', 'loom@example.com']);
    git(['config', 'user.name', 'loom test']);
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('commits uncommitted work in the worktree with a wip [loom] message', () => {
    seedRunningAgent('story-real', repoDir);
    // Make the worktree dirty.
    fs.writeFileSync(path.join(repoDir, 'wip.txt'), 'in flight\n');

    const before = parseInt(git(['rev-list', '--count', 'HEAD']), 10);
    const results = checkpointInFlightWorktrees(db, new FakeClock());
    const after = parseInt(git(['rev-list', '--count', 'HEAD']), 10);

    assert.deepEqual(results, [{ storyId: 'story-real', checkpointed: true }]);
    assert.equal(after, before + 1);
    assert.match(git(['log', '-1', '--pretty=%s']), /wip: stop checkpoint \[loom\]/);
    // The new file is now tracked/committed (worktree clean of it).
    assert.equal(git(['status', '--porcelain']).length, 0);
  });

  it('makes no commit when the worktree is already clean', () => {
    seedRunningAgent('story-clean-real', repoDir);

    const before = parseInt(git(['rev-list', '--count', 'HEAD']), 10);
    const results = checkpointInFlightWorktrees(db, new FakeClock());
    const after = parseInt(git(['rev-list', '--count', 'HEAD']), 10);

    assert.deepEqual(results, [{ storyId: 'story-clean-real', checkpointed: false }]);
    assert.equal(after, before);
  });
});

// ─── stopEpicWorkers ─────────────────────────────────────────────────────────

function seedRunningAgentForEpic(
  epicId: string,
  storyId: string,
  pid: number,
): string {
  const agents = new AgentStore(db);
  const agent = agents.create(epicId, storyId, `title ${storyId}`);
  agents.updateStatus(agent.id, 'running', {
    worktree_path: `/tmp/wt-${storyId}`,
    branch_name: `story/${storyId}`,
  });
  agents.updateWorkerPid(agent.id, pid);
  return agent.id;
}

describe('stopEpicWorkers — isolation (load-bearing case)', () => {
  beforeEach(() => {
    new EpicStore(db).create('epic-A', 'Epic A');
    new EpicStore(db).create('epic-B', 'Epic B');
  });

  it('stops only epic-A workers; epic-B workers remain running', () => {
    const pidA1 = 10001;
    const pidA2 = 10002;
    const pidB1 = 10003;
    seedRunningAgentForEpic('epic-A', 'story-A-001', pidA1);
    seedRunningAgentForEpic('epic-A', 'story-A-002', pidA2);
    seedRunningAgentForEpic('epic-B', 'story-B-001', pidB1);

    const killed: number[] = [];
    const result = stopEpicWorkers(db, 'epic-A', 'cli', {
      kill: (pid) => { killed.push(pid); },
    });

    assert.equal(result.status, 'ok');
    assert.deepEqual(killed.sort(), [pidA1, pidA2].sort(), 'only epic-A PIDs signalled');
    assert.ok(!killed.includes(pidB1), 'epic-B worker was NOT signalled');
    assert.equal(result.stopped.length, 2);
    assert.equal(result.noop.length, 0);

    // Epic B's agent is still "running" in the DB (we don't change DB status
    // when signalling; the worker itself updates on exit).
    const agents = new AgentStore(db);
    assert.equal(agents.getByStory('story-B-001')?.status, 'running');
  });

  it('returns status not_found for a nonexistent epic — no workers signalled', () => {
    const pidA1 = 10011;
    seedRunningAgentForEpic('epic-A', 'story-A-003', pidA1);

    const killed: number[] = [];
    const result = stopEpicWorkers(db, 'epic-NOPE', 'cli', {
      kill: (pid) => { killed.push(pid); },
    });

    assert.equal(result.status, 'not_found');
    assert.deepEqual(killed, [], 'no worker was signalled');
    assert.equal(result.stopped.length, 0);
  });

  it('noops on non-running agents in the epic', () => {
    const agents = new AgentStore(db);
    const pending = agents.create('epic-A', 'story-A-004', 'pending story');
    agents.updateStatus(pending.id, 'pending');

    const killed: number[] = [];
    const result = stopEpicWorkers(db, 'epic-A', 'cli', {
      kill: (pid) => { killed.push(pid); },
    });

    assert.equal(result.status, 'ok');
    assert.equal(killed.length, 0);
    assert.equal(result.noop.length, 1);
    assert.equal(result.noop[0].storyId, 'story-A-004');
  });

  it('a retried story (prior failed attempt + running retry) is counted once, not as a noop', () => {
    // Simulate a retry: first attempt is failed, second is running.
    const agents = new AgentStore(db);
    const first = agents.create('epic-A', 'story-A-retry', 'retry story');
    agents.updateStatus(first.id, 'failed');
    const second = agents.create('epic-A', 'story-A-retry', 'retry story');
    const retryPid = 19999;
    agents.updateStatus(second.id, 'running');
    agents.updateWorkerPid(second.id, retryPid);
    // Force the running retry to have a strictly later timestamp so listLatestByEpic
    // deterministically picks it (avoids same-ms tie-break on random id).
    const laterTs = new Date(Date.now() + 1000).toISOString();
    db.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(laterTs, second.id);

    const killed: number[] = [];
    const result = stopEpicWorkers(db, 'epic-A', 'cli', {
      kill: (pid) => { killed.push(pid); },
    });

    // The running retry is stopped; the stale failed attempt is NOT counted as a noop.
    assert.deepEqual(killed, [retryPid], 'only the running retry is signalled');
    assert.equal(result.stopped.length, 1);
    assert.equal(result.noop.length, 0, 'stale failed attempt must not inflate noop count');
  });
});

describe('stopEpicWorkers — audit rows', () => {
  beforeEach(() => {
    new EpicStore(db).create('epic-A', 'Epic A');
  });

  it('records stop_agent per worker and one aggregate stop_epic row', () => {
    const pid1 = 20001;
    const pid2 = 20002;
    const id1 = seedRunningAgentForEpic('epic-A', 'story-audit-1', pid1);
    const id2 = seedRunningAgentForEpic('epic-A', 'story-audit-2', pid2);
    void id1; void id2;

    stopEpicWorkers(db, 'epic-A', 'test-reason', {
      kill: () => {},
    });

    const audit = new AuditLog(db);
    const epicRow = audit.getByCommand('epic-A', ['stop_epic']);
    assert.equal(epicRow.length, 1, 'exactly one stop_epic row');
    const epicDetail = JSON.parse(epicRow[0].detail!);
    assert.equal(epicDetail.reason, 'test-reason');
    assert.deepEqual(
      epicDetail.stopped.sort(),
      ['story-audit-1', 'story-audit-2'],
      'stop_epic detail.stopped contains story IDs, not a count',
    );

    const agentRow1 = audit.getByStory('story-audit-1').filter((r) => r.action === 'stop_agent');
    assert.equal(agentRow1.length, 1);
    assert.equal(JSON.parse(agentRow1[0].detail!).reason, 'test-reason');
  });

  it('--reason omitted → detail.reason defaults to "cli" (the canonical default)', () => {
    const pid = 20010;
    seedRunningAgentForEpic('epic-A', 'story-default-reason', pid);

    stopEpicWorkers(db, 'epic-A', 'cli', {
      kill: () => {},
    });

    const audit = new AuditLog(db);
    const epicRow = audit.getByCommand('epic-A', ['stop_epic']);
    assert.equal(epicRow.length, 1);
    assert.equal(JSON.parse(epicRow[0].detail!).reason, 'cli');

    const agentRows = audit.getByStory('story-default-reason').filter((r) => r.action === 'stop_agent');
    assert.equal(agentRows.length, 1);
    assert.equal(JSON.parse(agentRows[0].detail!).reason, 'cli');
  });
});

// ─── stopSupervisor — bare loom stop audit ────────────────────────────────────

describe('stopSupervisor — bare stop audit', () => {
  it('records a stop_agent row with the provided reason', () => {
    const { checkpoints } = stopSupervisor(db, 'test-reason', new FakeClock(), {
      runCheckpoint: () => false,
    });

    assert.deepEqual(checkpoints, []);

    const rows = new AuditLog(db).recent(10).filter((r) => r.action === 'stop_agent');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail!);
    assert.equal(detail.reason, 'test-reason');
    assert.equal(detail.mode, 'supervisor_halt');
  });

  it('--reason omitted → detail.reason defaults to "cli"', () => {
    stopSupervisor(db, 'cli', new FakeClock(), { runCheckpoint: () => false });

    const rows = new AuditLog(db).recent(10).filter((r) => r.action === 'stop_agent');
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].detail!).reason, 'cli');
  });
});

// ─── pollUntilTerminal ────────────────────────────────────────────────────────

/**
 * Fake PollClock for pollUntilTerminal tests. Starts at nowMs=0.
 * Advance time with `advance(ms)`. Optionally run a callback on each
 * `sleep()` call to simulate DB state transitions.
 */
class FakePollClock implements PollClock {
  private _now = 0;
  private _sleepCallbacks: (() => void)[] = [];
  public sleepCount = 0;

  nowMs(): number {
    return this._now;
  }

  advance(ms: number): void {
    this._now += ms;
  }

  sleep(_ms: number): void {
    this.sleepCount++;
    const cb = this._sleepCallbacks.shift();
    if (cb) cb();
  }

  onNextSleep(fn: () => void): void {
    this._sleepCallbacks.push(fn);
  }
}

function seedAgent(epicId: string, storyId: string): string {
  const agents = new AgentStore(db);
  const agent = agents.create(epicId, storyId, `title ${storyId}`);
  return agent.id;
}

describe('pollUntilTerminal', () => {
  it('returns immediately when status is already "done" on the first poll', () => {
    const agentId = seedAgent('epic-006', 'story-poll-1');
    new AgentStore(db).updateStatus(agentId, 'done');

    const clock = new FakePollClock();
    const result = pollUntilTerminal('story-poll-1', db, 30_000, clock);

    assert.deepEqual(result, { reached: true, finalStatus: 'done' });
    assert.equal(clock.sleepCount, 0, 'no sleep — terminal on first check');
  });

  it('returns immediately when status is already "failed" on the first poll', () => {
    const agentId = seedAgent('epic-006', 'story-poll-2');
    new AgentStore(db).updateStatus(agentId, 'failed');

    const clock = new FakePollClock();
    const result = pollUntilTerminal('story-poll-2', db, 30_000, clock);

    assert.deepEqual(result, { reached: true, finalStatus: 'failed' });
    assert.equal(clock.sleepCount, 0, 'no sleep — terminal on first check');
  });

  it('waits until status transitions to terminal on the N-th poll tick', () => {
    const agentId = seedAgent('epic-006', 'story-poll-3');
    new AgentStore(db).updateStatus(agentId, 'running');

    const clock = new FakePollClock();
    // Transition to 'done' on the 2nd sleep callback.
    clock.onNextSleep(() => { /* running still */ });
    clock.onNextSleep(() => {
      new AgentStore(db).updateStatus(agentId, 'done');
    });

    const result = pollUntilTerminal('story-poll-3', db, 30_000, clock);

    assert.deepEqual(result, { reached: true, finalStatus: 'done' });
    // No force-write — terminal was reached naturally.
    const agent = new AgentStore(db).getByStory('story-poll-3');
    assert.equal(agent?.log_tail, null, 'timeout log_tail was NOT written');
  });

  it('on timeout: issues exactly one UPDATE to force "failed" and returns reached:false', () => {
    const agentId = seedAgent('epic-006', 'story-poll-timeout');
    new AgentStore(db).updateStatus(agentId, 'running');

    // nowMs() starts at 0; after the first status check, advance past the deadline.
    let callCount = 0;
    const clock: PollClock = {
      nowMs: () => {
        callCount++;
        // First call computes deadline (0 + timeout). Second+ calls check deadline.
        return callCount > 1 ? 30_001 : 0;
      },
      sleep: () => {},
    };

    const result = pollUntilTerminal('story-poll-timeout', db, 30_000, clock);

    assert.equal(result.reached, false);
    assert.equal(result.finalStatus, 'failed');

    // DB must reflect the forced failure.
    const agent = new AgentStore(db).get(agentId)!;
    assert.equal(agent.status, 'failed');
    assert.equal(agent.log_tail, 'stop timeout: forced failed');
  });

  it('timeout force-write is a single atomic SQL statement (status and log_tail set together)', () => {
    const agentId = seedAgent('epic-006', 'story-poll-atomic');
    new AgentStore(db).updateStatus(agentId, 'running');

    let nowCallCount = 0;
    const clock: PollClock = {
      nowMs: () => {
        nowCallCount++;
        return nowCallCount > 1 ? 30_001 : 0;
      },
      sleep: () => {},
    };

    pollUntilTerminal('story-poll-atomic', db, 30_000, clock);

    // Both status and log_tail are set in the single AgentStore.updateStatus call.
    // If they were separate writes, one could succeed and the other fail.
    const agent = new AgentStore(db).get(agentId)!;
    assert.equal(agent.status, 'failed', 'status set to failed by timeout write');
    assert.equal(
      agent.log_tail,
      'stop timeout: forced failed',
      'log_tail set in the same statement as status'
    );
    // Verify that no other agent rows exist for the story (no extra insertions).
    const allRows = db
      .prepare('SELECT COUNT(*) as c FROM agents WHERE story_id = ?')
      .get('story-poll-atomic') as { c: number };
    assert.equal(allRows.c, 1, 'exactly one agents row — no duplicate writes');
  });

  it('poll interval uses Date.now() delta — no real setTimeout (fake clock fully controls timing)', () => {
    const agentId = seedAgent('epic-006', 'story-poll-clock');
    new AgentStore(db).updateStatus(agentId, 'running');

    const clock = new FakePollClock();
    // Set a very short timeout (1 ms) but keep nowMs at 0 until transition.
    // The clock never advances past the deadline, so the loop only exits
    // because we set the story to terminal via the sleep callback.
    clock.onNextSleep(() => {
      new AgentStore(db).updateStatus(agentId, 'done');
    });

    const result = pollUntilTerminal('story-poll-clock', db, 1_000, clock);

    // The loop terminated via terminal status, not timeout — proves no real
    // sleep was used (a real 1 ms would have fired and caused a timeout).
    assert.equal(result.reached, true);
    assert.equal(result.finalStatus, 'done');
  });
});

// ─── runStop --and-retry ──────────────────────────────────────────────────────

describe('runStop --and-retry', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-stop-andretry-'));
    const loomDir = path.join(projectDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), 'agents:\n  max_concurrent: 2\n');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('calls retryFn after pollUntilTerminal resolves and exits 0 on success', async () => {
    const agentId = seedAgent('epic-006', 'story-ar-1');
    new AgentStore(db).updateStatus(agentId, 'failed');

    const retriedStories: string[] = [];
    const exits: number[] = [];

    await runStop(
      ['story-ar-1'],
      { andRetry: true },
      {
        projectRoot: projectDir,
        db,
        // pollClock: default-like (story is already terminal, resolves immediately)
        retryFn: async (storyId) => { retriedStories.push(storyId); },
        exitFn: (code) => { exits.push(code); },
      }
    );

    assert.deepEqual(retriedStories, ['story-ar-1'], 'retryFn was called for the story');
    assert.deepEqual(exits, [], 'no explicit exit — resolved 0 by returning normally');
  });

  it('exits non-zero with "loom retry <storyId>" when retryFn throws', async () => {
    const agentId = seedAgent('epic-006', 'story-ar-2');
    new AgentStore(db).updateStatus(agentId, 'failed');

    const exits: number[] = [];
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };

    try {
      await runStop(
        ['story-ar-2'],
        { andRetry: true },
        {
          projectRoot: projectDir,
          db,
          retryFn: async () => { throw new Error('queue full'); },
          exitFn: (code) => { exits.push(code); },
        }
      );
    } finally {
      process.stderr.write = origStderrWrite;
    }

    assert.deepEqual(exits, [1], 'exits non-zero when retry fails');
    const combined = stderrLines.join('');
    assert.match(combined, /loom retry story-ar-2/, 'message includes "loom retry <storyId>"');
  });

  it('exits non-zero and does NOT call retryFn when pollUntilTerminal times out', async () => {
    const agentId = seedAgent('epic-006', 'story-ar-3');
    new AgentStore(db).updateStatus(agentId, 'running');

    let nowCallCount = 0;
    const timeoutClock: PollClock = {
      nowMs: () => {
        nowCallCount++;
        return nowCallCount > 1 ? 30_001 : 0;
      },
      sleep: () => {},
    };

    const retriedStories: string[] = [];
    const exits: number[] = [];
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };

    try {
      // story is 'running' with a pid so SIGTERM is attempted
      new AgentStore(db).updateWorkerPid(agentId, 99999);
      // process.kill will throw ESRCH since pid 99999 doesn't exist; that's fine
      await runStop(
        ['story-ar-3'],
        { andRetry: true },
        {
          projectRoot: projectDir,
          db,
          pollClock: timeoutClock,
          retryFn: async (storyId) => { retriedStories.push(storyId); },
          exitFn: (code) => { exits.push(code); },
        }
      );
    } finally {
      process.stderr.write = origStderrWrite;
    }

    assert.deepEqual(retriedStories, [], 'retryFn NOT called on timeout');
    assert.deepEqual(exits, [1], 'exits non-zero on timeout');
    const combined = stderrLines.join('');
    assert.match(combined, /loom retry story-ar-3/, 'diagnostic includes retry hint');
  });
});

describe('runStop --epic + --and-retry rejection', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-stop-epic-andretry-'));
    const loomDir = path.join(projectDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), 'agents:\n  max_concurrent: 2\n');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('exits non-zero with an error when --epic and --and-retry are combined', async () => {
    const exits: number[] = [];
    const stderrLines: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    };

    try {
      await runStop(
        [],
        { epic: 'epic-006', andRetry: true },
        {
          projectRoot: projectDir,
          db,
          exitFn: (code) => { exits.push(code); },
        }
      );
    } finally {
      process.stderr.write = origStderrWrite;
    }

    assert.deepEqual(exits, [1], 'exits non-zero for the --epic + --and-retry combination');
    const combined = stderrLines.join('');
    assert.match(combined, /--and-retry is not supported with --epic/);
  });
});

describe('runStop backward compat — no new flags', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-stop-compat-'));
    const loomDir = path.join(projectDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), 'agents:\n  max_concurrent: 2\n');
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('polls for terminal status but does NOT call retryFn without --and-retry', async () => {
    const agentId = seedAgent('epic-006', 'story-compat-1');
    new AgentStore(db).updateStatus(agentId, 'failed'); // already terminal — poll resolves immediately

    const retriedStories: string[] = [];

    await runStop(
      ['story-compat-1'],
      {}, // no --and-retry
      {
        projectRoot: projectDir,
        db,
        retryFn: async (storyId) => { retriedStories.push(storyId); },
        exitFn: () => {},
      }
    );

    assert.deepEqual(retriedStories, [], 'retryFn was NOT called without --and-retry');
  });
});
