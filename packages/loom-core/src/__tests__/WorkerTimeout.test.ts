import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import {
  WorkerTimeoutGuard,
  type WorkerTimeoutGuardOptions,
} from '../orchestrator/WorkerTimeoutGuard.js';
import { BaseCliWorker } from '../orchestrator/BaseCliWorker.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import { Mulberry32, type RetryClock, type JitterSource } from '../orchestrator/resilience/RetryClock.js';
import { SUSPEND_POLL_MULTIPLE } from '../orchestrator/resilience/constants.js';
import type { Story } from '../types.js';

// ─── WorkerTimeoutGuard — unit tests with injected clocks ────────────────────
//
// Two clocks now feed the guard (epic-006 story-006-005, ADR-4): a MONOTONIC
// clock that backs ALL duration math, and a WALL clock consulted only for
// suspend detection. Tests drive BOTH. `advance()` moves them in lockstep (the
// normal, no-suspend case — wall and monotonic agree). `simulateSuspend()`
// jumps the WALL clock far ahead while the MONOTONIC clock barely moves, which
// is exactly the divergence a real laptop/VM sleep produces. No test ever
// performs a real sleep.

let nowMs = 0;
/** Monotonic nanoseconds. Kept in step with `nowMs` except across a suspend. */
let monoNs = 0n;
const now = (): number => nowMs;
const monotonicNow = (): bigint => monoNs;

/** Advance wall + monotonic together: ordinary elapsed work, no sleep. */
const advance = (sec: number): void => {
  nowMs += sec * 1000;
  monoNs += BigInt(sec * 1000) * 1_000_000n;
};

/**
 * Simulate a machine suspend: the WALL clock leaps forward by `sec` (the agent
 * was away from the keyboard) while the MONOTONIC clock barely advances — the
 * kernel froze it during sleep. `monoSec` defaults to a tiny residual so the
 * monotonic delta stays well under the suspend threshold.
 */
const simulateSuspend = (sec: number, monoSec = 0.05): void => {
  nowMs += sec * 1000;
  monoNs += BigInt(Math.round(monoSec * 1000)) * 1_000_000n;
};

let killCalls: Array<{ pid: number; signal: string }> = [];
const killProcess = (pid: number, signal: NodeJS.Signals): void => {
  killCalls.push({ pid, signal });
};

// Capture the scheduled grace (SIGKILL) callback so we can fire it manually.
let graceFn: (() => void) | null = null;
const fakeSetTimeout = (fn: () => void): unknown => {
  graceFn = fn;
  return 'grace-timer';
};

function makeGuard(
  opts: Partial<ConstructorParameters<typeof WorkerTimeoutGuard>[0]> = {}
): WorkerTimeoutGuard {
  return new WorkerTimeoutGuard({
    stallMs: 12 * 60_000,
    absoluteCapMs: 60 * 60_000,
    getPid: () => 4242,
    now,
    monotonicNow,
    setInterval: () => 'poll-timer',
    clearInterval: () => undefined,
    setTimeout: fakeSetTimeout,
    clearTimeout: () => undefined,
    killProcess,
    ...opts,
  });
}

describe('WorkerTimeoutGuard', () => {
  beforeEach(() => {
    nowMs = 1_000_000_000_000;
    monoNs = 5_000_000_000n; // arbitrary monotonic origin, independent of wall
    killCalls = [];
    graceFn = null;
  });

  it('does not kill while output keeps arriving (stall resets)', () => {
    const w = makeGuard({ stallMs: 60_000, absoluteCapMs: 0 });
    w.start();
    for (let i = 0; i < 10; i++) {
      advance(59); // just under the stall window each tick
      w.recordActivity();
      assert.equal(w.check(), 'noop');
    }
    assert.equal(killCalls.length, 0, 'a steadily-active worker is never killed');
  });

  it('kills on stall (no output) and reports reason "stall"', () => {
    const reasons: string[] = [];
    const w = makeGuard({ stallMs: 60_000, absoluteCapMs: 0, onKill: (r) => reasons.push(r) });
    w.start();
    advance(59);
    assert.equal(w.check(), 'noop');
    advance(2); // crosses the 60s stall window
    assert.equal(w.check(), 'stall');
    assert.deepEqual(reasons, ['stall']);
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].pid, -4242, 'signals the process GROUP (negative pid)');
    assert.equal(killCalls[0].signal, 'SIGTERM');
  });

  it('kills on the absolute cap even while actively producing output', () => {
    const reasons: string[] = [];
    const w = makeGuard({ stallMs: 0, absoluteCapMs: 120_000, onKill: (r) => reasons.push(r) });
    w.start();
    for (let i = 0; i < 3; i++) {
      advance(50);
      w.recordActivity(); // busy the whole time — only the cap can stop it
    }
    assert.equal(w.check(), 'cap');
    assert.deepEqual(reasons, ['cap']);
  });

  it('escalates SIGTERM -> SIGKILL after the grace window if still alive', () => {
    const w = makeGuard({ stallMs: 30_000, absoluteCapMs: 0 });
    w.start();
    advance(31);
    assert.equal(w.check(), 'stall');
    assert.equal(killCalls[0].signal, 'SIGTERM');
    assert.ok(graceFn, 'a grace escalation was scheduled');
    graceFn!(); // process still "alive" (getPid still returns 4242)
    assert.equal(killCalls.length, 2);
    assert.equal(killCalls[1].signal, 'SIGKILL');
    assert.equal(killCalls[1].pid, -4242);
  });

  it('does not SIGKILL if the process already exited during the grace window', () => {
    let pid: number | undefined = 4242;
    const w = makeGuard({
      stallMs: 30_000,
      absoluteCapMs: 0,
      getPid: () => pid,
    });
    w.start();
    advance(31);
    assert.equal(w.check(), 'stall'); // SIGTERM sent
    pid = undefined; // worker exited cleanly after SIGTERM
    graceFn!();
    assert.equal(killCalls.length, 1, 'no SIGKILL when the worker is already gone');
  });

  it('emits a one-shot near-deadline warning before the cap', () => {
    const warns: Array<{ reason: string }> = [];
    const w = makeGuard({
      stallMs: 0,
      absoluteCapMs: 120_000,
      warnMs: 30_000,
      onWarn: (info) => warns.push(info),
    });
    w.start();
    advance(80);
    assert.equal(w.check(), 'noop'); // 40s remaining, outside warn window
    advance(11); // now 29s remaining, inside the 30s warn window
    assert.equal(w.check(), 'warn');
    advance(5);
    w.check(); // must not re-warn
    assert.equal(warns.length, 1);
    assert.equal(warns[0].reason, 'cap');
  });

  it('terminate() is idempotent and not double-classified', () => {
    const w = makeGuard({ stallMs: 30_000, absoluteCapMs: 0 });
    w.start();
    advance(31);
    assert.equal(w.check(), 'stall');
    assert.equal(w.check(), 'noop', 'already terminating');
    assert.equal(killCalls.length, 1, 'SIGTERM only sent once');
  });

  // ─── Sleep-proofing (story-006-005) ───────────────────────────────────────

  it('measures durations on the MONOTONIC clock, not the wall clock', () => {
    // pollMs 1s ⇒ suspend threshold 6s. Move the WALL clock far (10 minutes)
    // while the MONOTONIC clock barely moves: a wall-only stall computation
    // would fire a stall at 60s of wall time, but monotonic time says no work
    // elapsed — so the guard must NOT kill.
    const w = makeGuard({ stallMs: 60_000, absoluteCapMs: 0, pollMs: 1_000 });
    w.start();
    // One enormous wall jump with no monotonic progress is a suspend (forgiven,
    // re-armed) — assert it is not a kill, which also proves the stall math
    // never ran off the wall clock.
    simulateSuspend(600); // +10min wall, +50ms monotonic
    assert.equal(w.check(), 'noop', 'wall jump alone never kills — durations are monotonic');
    assert.equal(killCalls.length, 0);
  });

  it('detects a suspend when the wall jump exceeds 6× the poll interval', () => {
    const suspends: Array<{ wallJumpMs: number }> = [];
    // pollMs 5s ⇒ threshold 30s. A 40s wall jump with negligible monotonic
    // progress is a suspend; a 25s wall jump (under threshold) is not.
    const w = makeGuard({
      stallMs: 60_000,
      absoluteCapMs: 0,
      pollMs: 5_000,
      onSuspendDetected: (info) => suspends.push(info),
    });
    w.start();
    simulateSuspend(40); // 40s > 30s threshold, monotonic frozen ⇒ suspend
    assert.equal(w.check(), 'noop');
    assert.equal(suspends.length, 1, 'a >6× pollMs wall jump is a suspend');
    assert.equal(suspends[0].wallJumpMs, 40_000);
    assert.equal(killCalls.length, 0, 'a suspend never kills');
  });

  it('does NOT flag a normal long-but-active interval as a suspend', () => {
    const suspends: Array<{ wallJumpMs: number }> = [];
    // 40s of REAL elapsed work (wall and monotonic move together) is past the
    // 30s threshold on the wall axis, but the monotonic axis also moved that
    // far — so it is genuine work, never a suspend.
    const w = makeGuard({
      stallMs: 0,
      absoluteCapMs: 0,
      pollMs: 5_000,
      onSuspendDetected: (info) => suspends.push(info),
    });
    w.start();
    advance(40); // wall AND monotonic +40s
    assert.equal(w.check(), 'noop');
    assert.equal(suspends.length, 0, 'lockstep wall+monotonic progress is real work, not sleep');
  });

  it('re-arms all timers from the resume instant so a slept worker survives', () => {
    const suspends: Array<{ wallJumpMs: number }> = [];
    // stall 60s, cap 5min, pollMs 5s ⇒ threshold 30s. The worker is busy, then
    // the laptop sleeps for an hour. After resume the worker keeps streaming.
    // Neither the stall (silence) nor the absolute cap may count the sleep.
    const w = makeGuard({
      stallMs: 60_000,
      absoluteCapMs: 300_000,
      pollMs: 5_000,
      onSuspendDetected: (info) => suspends.push(info),
    });
    w.start();
    // 50s of real, active work — well within both budgets.
    advance(50);
    w.recordActivity();
    assert.equal(w.check(), 'noop');
    // The machine sleeps for an hour (wall +3600s, monotonic frozen).
    simulateSuspend(3600);
    assert.equal(w.check(), 'noop', 'a suspend re-arms instead of killing');
    assert.equal(suspends.length, 1);
    // After resume the worker resumes streaming. Because the timers re-armed
    // from the resume instant, it now has its FULL stall + cap budget again:
    // 59s of post-resume silence is under the 60s stall window.
    advance(59);
    assert.equal(w.check(), 'noop', 'stall window re-armed from resume, not from before the sleep');
    // And the absolute cap also re-armed: total wall age is >1h but monotonic
    // elapsed-since-resume is only ~109s, far under the 5-min cap.
    assert.equal(killCalls.length, 0, 'the streaming worker is never killed across the sleep');
  });

  it('still kills a worker that stays silent for a full stall window AFTER resume (ADR-4)', () => {
    // ADR-4: a suspend forgives only the slept gap. A worker that resumes and
    // then goes genuinely silent for a full stall window is killed normally.
    const w = makeGuard({ stallMs: 60_000, absoluteCapMs: 0, pollMs: 5_000 });
    w.start();
    advance(30);
    w.recordActivity();
    assert.equal(w.check(), 'noop');
    simulateSuspend(3600); // sleep — forgiven, re-armed
    assert.equal(w.check(), 'noop');
    // Now silent for a full 61s of REAL post-resume time: exceeds the re-armed
    // 60s stall window ⇒ killed.
    advance(61);
    assert.equal(w.check(), 'stall', 'post-resume silence past the stall window is still fatal');
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].signal, 'SIGTERM');
  });
});

// ─── checkpoint-on-timeout — integration test over a real git worktree ───────

/**
 * A worker whose subprocess is simulated: it writes an uncommitted file (the
 * "in-flight" work) and reports a timeout, exactly like a real worker SIGTERM'd
 * mid-edit. We assert the partial work is checkpoint-committed, not discarded.
 */
class TimingOutWorker extends BaseCliWorker {
  protected binary(): string {
    return 'true';
  }
  protected agentArgs(): string[] {
    return [];
  }
  protected spawnAgent(
    assignment: WorkerAssignment
  ): Promise<{ code: number | null; output: string; timedOut: boolean; producedOutput: boolean; timeoutReason?: 'stall' | 'cap' }> {
    // Simulate the worker having edited a file but not committed it yet.
    fs.writeFileSync(path.join(assignment.worktreePath, 'in_flight.ts'), 'export const x = 1;\n');
    return Promise.resolve({ code: null, output: 'working...\n', timedOut: true, producedOutput: true, timeoutReason: 'stall' });
  }
}

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let repo: string;
let baseSha: string;

const STORY: Story = {
  id: 'story-001-001',
  title: 'Add something',
  description: 'desc',
  acceptance_criteria: ['works'],
  estimated_complexity: 'small',
  dependencies: [],
};

describe('BaseCliWorker — checkpoint on timeout', () => {
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-timeout-'));
    gitc(['init', '-q'], repo);
    gitc(['config', 'user.email', 'test@loom.dev'], repo);
    gitc(['config', 'user.name', 'Loom Test'], repo);
    gitc(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
    gitc(['add', '.'], repo);
    gitc(['commit', '-q', '-m', 'initial'], repo);
    baseSha = gitc(['rev-parse', 'HEAD'], repo);
    gitc(['checkout', '-q', '-b', 'story/story-001-001'], repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function assignment(): WorkerAssignment {
    return {
      storyId: STORY.id,
      epicId: 'epic-001',
      story: STORY,
      worktreePath: repo,
      branchName: 'story/story-001-001',
      baseSha,
      projectRoot: repo,
      skills: [],
    };
  }

  it('commits in-flight work as a wip checkpoint instead of discarding it', async () => {
    const worker = new TimingOutWorker({ openPr: false });
    const result = await worker.run(assignment());

    assert.equal(result.status, 'failed');
    assert.ok(/timed out/i.test(result.summary), 'summary explains the timeout');
    assert.equal(result.commitCount, 1, 'the in-flight work became one resumable commit');

    // The work is preserved on the branch as a marked wip checkpoint.
    const log = gitc(['log', '--oneline', `${baseSha}..HEAD`], repo);
    assert.ok(/wip: timeout-stall checkpoint \[loom\]/.test(log), `expected wip checkpoint, got: ${log}`);
    const status = gitc(['status', '--porcelain'], repo);
    assert.equal(status, '', 'nothing left uncommitted');
    assert.ok(fs.existsSync(path.join(repo, 'in_flight.ts')), 'the edited file survived');
  });

  it('does not create an empty checkpoint when there is no uncommitted work', async () => {
    // A worker that times out having committed nothing and changed nothing.
    class CleanTimeout extends BaseCliWorker {
      protected binary(): string { return 'true'; }
      protected agentArgs(): string[] { return []; }
      protected spawnAgent(): Promise<{ code: number | null; output: string; timedOut: boolean; producedOutput: boolean }> {
        return Promise.resolve({ code: null, output: '', timedOut: true, producedOutput: false });
      }
    }
    const worker = new CleanTimeout({ openPr: false });
    const result = await worker.run(assignment());
    assert.equal(result.status, 'failed');
    assert.equal(result.commitCount, 0, 'no commits, no empty checkpoint');
    const log = gitc(['log', '--oneline', `${baseSha}..HEAD`], repo);
    assert.equal(log, '', 'no checkpoint commit created');
  });

  // Regression: in production the worker runs inside a `git worktree`, where
  // `<worktree>/.git` is a FILE, not a directory. The naive
  // `<worktree>/.git/index.lock` join never matches the real lock (which lives
  // in `<repo>/.git/worktrees/<id>/index.lock`), so a stale lock would make the
  // checkpoint `git add` silently fail. Verify the checkpoint still lands.
  it('checkpoints inside a real git worktree even with a stale index.lock', async () => {
    const wtPath = path.join(repo, '.loom', 'worktrees', 'story-001-001');
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    // The branch already exists and is checked out in the main repo (beforeEach).
    // Free it (a branch can only be checked out in one worktree) by detaching
    // the main HEAD, then add the story worktree on the branch.
    gitc(['checkout', '-q', '--detach'], repo);
    gitc(['worktree', 'add', wtPath, 'story/story-001-001'], repo);

    // Plant a stale lock in the REAL gitdir for this worktree.
    const realGitDir = gitc(['rev-parse', '--git-dir'], wtPath);
    const resolvedGitDir = path.isAbsolute(realGitDir)
      ? realGitDir
      : path.join(wtPath, realGitDir);
    const lock = path.join(resolvedGitDir, 'index.lock');
    fs.writeFileSync(lock, '');
    assert.ok(fs.existsSync(lock), 'precondition: stale lock present');

    const worker = new TimingOutWorker({ openPr: false });
    const result = await worker.run({
      storyId: STORY.id,
      epicId: 'epic-001',
      story: STORY,
      worktreePath: wtPath,
      branchName: 'story/story-001-001',
      baseSha,
      projectRoot: repo,
      skills: [],
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.commitCount, 1, 'the in-flight work was checkpointed despite the stale lock');
    assert.ok(!fs.existsSync(lock), 'the stale lock was cleared from the real gitdir');
    const log = gitc(['log', '--oneline', `${baseSha}..HEAD`], wtPath);
    assert.ok(/wip: timeout-stall checkpoint \[loom\]/.test(log), `expected wip checkpoint, got: ${log}`);
    assert.equal(gitc(['status', '--porcelain'], wtPath), '', 'nothing left uncommitted');
  });
});

// ─── Suspend → infra-retry routing through BaseCliWorker.run() (story-006-005) ─
//
// Proves the worker-level behaviour the guard's suspend handling exists to
// produce: a streaming worker SURVIVES a machine sleep (no kill, no retry,
// timers re-arm), and a worker that DIES around a sleep is routed through the
// SAME shared infra-retry path story-006-003 built (in-place, budget-free,
// jittered backoff on a fake clock). Every clock — guard wall, guard monotonic,
// guard poll interval, and the retry backoff — is injected; the test performs
// NO real sleeps.

/** A controllable child exposing exactly the surface `spawnAgent` touches. */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private stdinEnded = false;
  stdin: { write(s: string): boolean; end(): void; readonly writableEnded: boolean };

  constructor() {
    super();
    const child = this;
    this.stdin = {
      write: () => true,
      end: () => {
        child.stdinEnded = true;
      },
      get writableEnded(): boolean {
        return child.stdinEnded;
      },
    };
  }
  emitStdout(s: string): void {
    this.stdout.emit('data', Buffer.from(s));
  }
  close(code: number | null): void {
    this.emit('close', code);
  }
}

/**
 * A retry clock whose backoff timers are captured and flushed manually, so the
 * suspend→retry path takes zero real time. Mirrors the FakeRetryClock the
 * story-006-003 tests use.
 */
class FakeRetryClock implements RetryClock {
  readonly scheduledMs: number[] = [];
  private pending: Array<() => void> = [];
  monotonicNs(): bigint {
    return 0n;
  }
  wallMs(): number {
    return 0;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.scheduledMs.push(ms);
    this.pending.push(fn);
    return this.pending.length - 1;
  }
  clearTimeout(handle: unknown): void {
    const i = handle as number;
    if (typeof i === 'number') this.pending[i] = () => undefined;
  }
  flushTimers(): void {
    const fns = this.pending;
    this.pending = [];
    for (const fn of fns) fn();
  }
}

const SUSPEND_STORY: Story = {
  id: 'story-006-005',
  title: 'sleep-proof timers',
  description: 'noop',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'medium',
  dependencies: [],
};

/**
 * Drives a scripted spawn under a guard whose clocks the test fully controls.
 * `guardTick()` invokes the captured poll callback (the guard's `check()`), so
 * a test can `suspendGuard()` (jump the guard's wall clock far past the poll
 * threshold while its monotonic clock holds) and then tick to exercise the
 * suspend branch exactly as the real `setInterval` would.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
abstract class SuspendableWorker extends BaseCliWorker {
  lastChild?: FakeChild;
  spawnCount = 0;
  readonly retryClock = new FakeRetryClock();
  killCount = 0;
  suspendCount = 0;
  private pollFn: (() => void) | null = null;
  private gWallMs = 1_000_000;
  private gMonoNs = 5_000_000_000n;
  private readonly pollMs = 5_000;

  constructor(opts: ConstructorParameters<typeof BaseCliWorker>[0], protected readonly repo: string) {
    super(opts);
  }

  protected binary(): string {
    return 'cursor-agent';
  }
  protected agentArgs(): string[] {
    return [];
  }

  /** Fire the guard's poll callback — the moment `check()` runs. */
  guardTick(): void {
    this.pollFn?.();
  }
  /** Advance both guard clocks together: ordinary elapsed work, no sleep. */
  guardAdvance(sec: number): void {
    this.gWallMs += sec * 1000;
    this.gMonoNs += BigInt(sec * 1000) * 1_000_000n;
  }
  /** Jump the guard's WALL clock far ahead while monotonic barely moves: a sleep. */
  suspendGuard(sec: number): void {
    this.gWallMs += sec * 1000;
    this.gMonoNs += 50_000_000n; // 50ms residual
  }

  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    const guard = new WorkerTimeoutGuard({
      ...opts,
      pollMs: this.pollMs,
      warnMs: 0,
      now: () => this.gWallMs,
      monotonicNow: () => this.gMonoNs,
      // Capture the poll callback instead of arming a real interval.
      setInterval: (fn: () => void) => {
        this.pollFn = fn;
        return 'poll';
      },
      clearInterval: () => {
        this.pollFn = null;
      },
      setTimeout: () => 'grace',
      clearTimeout: () => undefined,
      killProcess: () => {
        this.killCount += 1;
      },
      onSuspendDetected: (info) => {
        this.suspendCount += 1;
        opts.onSuspendDetected?.(info);
      },
    });
    return guard;
  }

  protected createInfraRetrySources(): { clock: RetryClock; jitter: JitterSource } {
    return { clock: this.retryClock, jitter: new Mulberry32(0xabcdef) };
  }

  protected commit(child: FakeChild): void {
    const f = path.join(this.repo, `done-${this.spawnCount}.ts`);
    fs.writeFileSync(f, `export const x = ${this.spawnCount};\n`);
    execFileSync('git', ['add', '-A'], { cwd: this.repo });
    execFileSync('git', ['commit', '-q', '-m', 'work landed'], { cwd: this.repo });
    child.emitStdout('committed\n');
    child.close(0);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('BaseCliWorker — suspend survival + infra-retry routing (story-006-005)', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-suspend-'));
    const g = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo });
    };
    g(['init', '-q']);
    g(['config', 'user.email', 'test@loom.dev']);
    g(['config', 'user.name', 'Loom Test']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'initial']);
    baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    g(['checkout', '-q', '-b', 'story/story-006-005']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function assignment(over: Partial<WorkerAssignment> = {}): WorkerAssignment {
    return {
      storyId: SUSPEND_STORY.id,
      epicId: 'epic-006',
      story: SUSPEND_STORY,
      worktreePath: repo,
      branchName: 'story/story-006-005',
      baseSha,
      projectRoot: repo,
      skills: [],
      stallMs: 60_000,
      absoluteCapMs: 300_000,
      ...over,
    };
  }

  it('a simulated suspend does NOT kill a streaming worker — timers re-arm, story lands', async () => {
    // The worker streams, the laptop sleeps for an hour mid-stream, then the
    // worker resumes streaming and commits. The guard must re-arm (not kill),
    // the run must NOT retry (one spawn), and the story lands `done`.
    class StreamThenSleepThenFinish extends SuspendableWorker {
      protected spawnChild(): ChildProcessWithoutNullStreams {
        const child = new FakeChild();
        this.lastChild = child;
        this.spawnCount += 1;
        queueMicrotask(async () => {
          // Active work, well within budget.
          this.guardAdvance(30);
          child.emitStdout('thinking...\n');
          this.guardTick(); // noop — busy

          // The machine sleeps for an hour. The next poll tick sees the wall
          // jump with no monotonic progress ⇒ suspend ⇒ re-arm, never a kill.
          this.suspendGuard(3600);
          this.guardTick();

          // Resume: more streaming, still under the (re-armed) budgets.
          this.guardAdvance(40);
          child.emitStdout('back to work\n');
          this.guardTick(); // noop — re-armed stall window is fresh

          this.commit(child);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    }

    const worker = new StreamThenSleepThenFinish({ openPr: false }, repo);
    const result = await worker.run(assignment());

    assert.equal(worker.killCount, 0, 'a streaming worker is never killed across the sleep');
    assert.equal(worker.suspendCount, 1, 'the sleep was detected once');
    assert.equal(worker.spawnCount, 1, 'no retry — the worker survived the suspend in place');
    assert.equal(worker.retryClock.scheduledMs.length, 0, 'no infra backoff scheduled');
    assert.equal(result.status, 'done', 'the slept-through worker still completes');
    assert.ok(result.commitCount >= 1, 'the worker committed after resuming');
  });

  it('routes a worker that DIES around a suspend through the shared infra-retry path', async () => {
    // First spawn: detect a suspend, then die silently (no output, null exit) —
    // exactly a session dropped while the machine slept. The suspend routing
    // marks this infra so the story-006-003 controller retries it in-place on
    // the jittered backoff. Second spawn commits.
    class SleepThenDieThenRecover extends SuspendableWorker {
      protected spawnChild(): ChildProcessWithoutNullStreams {
        const child = new FakeChild();
        this.lastChild = child;
        this.spawnCount += 1;
        const attempt = this.spawnCount;
        queueMicrotask(() => {
          if (attempt === 1) {
            this.suspendGuard(3600);
            this.guardTick(); // suspend detected, re-armed
            // The session never came back: silent death, no output, signal kill.
            child.close(null);
          } else {
            this.commit(child);
          }
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      }
    }

    const classified: Array<{ attemptClass: string; signature?: string; retryAttempt: number }> = [];
    const worker = new SleepThenDieThenRecover({ openPr: false }, repo);

    const done = worker.run(assignment({ onAttemptClassified: (i) => classified.push(i) }));
    // Pump the fake backoff clock until run() resolves — each scheduled retry
    // backoff is fired immediately, so no real time passes.
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    for (let i = 0; i < 50 && !settled; i++) {
      worker.retryClock.flushTimers();
      await new Promise((r) => setImmediate(r));
    }
    const result = await done;

    assert.equal(worker.suspendCount, 1, 'the first spawn saw the sleep');
    assert.equal(worker.spawnCount, 2, 'the slept-then-died worker was retried in-place once');
    assert.equal(worker.retryClock.scheduledMs.length, 1, 'exactly one infra backoff scheduled');
    // The dead-around-sleep attempt is classified infra and routed to retry.
    assert.equal(classified[0].attemptClass, 'infra_failure', 'suspend death routed as infra');
    assert.equal(classified[0].retryAttempt, 0);
    assert.equal(result.status, 'done', 'the retry recovered the story');
    assert.ok(result.commitCount >= 1);
  });

  it('the suspend threshold is exactly SUSPEND_POLL_MULTIPLE × pollMs', () => {
    // Lock the contract: 6× the poll interval. A guard with pollMs=5s treats a
    // 31s wall jump (just over 30s) as a suspend and a 29s jump as real work.
    assert.equal(SUSPEND_POLL_MULTIPLE, 6);
    let wall = 0;
    let mono = 0n;
    const suspends: number[] = [];
    const guard = new WorkerTimeoutGuard({
      stallMs: 0,
      absoluteCapMs: 0,
      pollMs: 5_000,
      getPid: () => 1,
      now: () => wall,
      monotonicNow: () => mono,
      setInterval: () => 'poll',
      clearInterval: () => undefined,
      setTimeout: () => 'grace',
      clearTimeout: () => undefined,
      killProcess: () => undefined,
      onSuspendDetected: (info) => suspends.push(info.wallJumpMs),
    });
    guard.start();
    // 29s wall jump, monotonic frozen: under 6×5s ⇒ not a suspend.
    wall += 29_000;
    mono += 50_000_000n;
    assert.equal(guard.check(), 'noop');
    assert.equal(suspends.length, 0, '29s < 30s threshold ⇒ not a suspend');
    // 31s wall jump, monotonic frozen: over threshold ⇒ a suspend.
    wall += 31_000;
    mono += 50_000_000n;
    assert.equal(guard.check(), 'noop');
    assert.deepEqual(suspends, [31_000], '31s > 30s threshold ⇒ suspend with that jump');
  });
});
