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
  type RetryClock,
  type CheckpointRunner,
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
