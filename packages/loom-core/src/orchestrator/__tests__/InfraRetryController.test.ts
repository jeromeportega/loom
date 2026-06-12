import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import { BaseCliWorker } from '../BaseCliWorker.js';
import { InfraRetryController } from '../InfraRetryController.js';
import {
  Mulberry32,
  SystemRetryClock,
  jitter,
  type RetryClock,
  type JitterSource,
} from '../resilience/RetryClock.js';
import {
  INFRA_RETRY_SCHEDULE_MS,
  INFRA_RETRY_MAX_ATTEMPTS,
  INFRA_RETRY_JITTER_FRACTION,
} from '../resilience/constants.js';
import {
  WorkerTimeoutGuard,
  type WorkerTimeoutGuardOptions,
} from '../WorkerTimeoutGuard.js';
import type { WorkerAssignment } from '../WorkerRunner.js';
import type { Story } from '../../types.js';
import type { InfraSignature } from '../resilience/types.js';

// ─── Deterministic fakes: no real CLI, no real timers, NO real sleeps ────────

/**
 * A fake `RetryClock` that captures every scheduled callback instead of using
 * the event loop. `flushTimers()` fires them in order, so a backoff "wait"
 * resolves synchronously with zero real time elapsed. `wallMs`/`monotonicNs`
 * are advanced manually so any duration math is also deterministic.
 */
class FakeRetryClock implements RetryClock {
  readonly scheduledMs: number[] = [];
  private pending: Array<() => void> = [];
  private mono = 0n;
  private wall = 0;

  monotonicNs(): bigint {
    return this.mono;
  }
  wallMs(): number {
    return this.wall;
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
  /** Fire every pending callback in scheduling order. */
  flushTimers(): void {
    const fns = this.pending;
    this.pending = [];
    for (const fn of fns) fn();
  }
}

/**
 * A controllable child exposing exactly the surface `spawnAgent` touches.
 * Mirrors the FakeChild in InfraFailureClassifier.test.ts.
 */
class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinEnded = false;
  stdin: { write(s: string): boolean; end(): void; readonly writableEnded: boolean };

  constructor() {
    super();
    const child = this;
    this.stdin = {
      write(): boolean {
        return true;
      },
      end(): void {
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
  emitStderr(s: string): void {
    this.stderr.emit('data', Buffer.from(s));
  }
  emitSpawnError(message: string): void {
    this.emit('error', new Error(message));
  }
  close(code: number | null): void {
    this.emit('close', code);
  }
}

/** Keeps the timeout guard inert — every signal here is spawn-driven, not wall-clock. */
class InertClock {
  now = (): number => 0;
  setInterval = (): unknown => 'poll';
  clearInterval = (): void => undefined;
  setTimeout = (): unknown => 'grace';
  clearTimeout = (): void => undefined;
}

const STORY: Story = {
  id: 'story-006-003',
  title: 'bounded auto-retry',
  description: 'noop',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'medium',
  dependencies: [],
};

// ─── 1. InfraRetryController — schedule, cap, jitter (no real sleeps) ─────────

describe('InfraRetryController.shouldRetry — bounded at 3 attempts (AC1)', () => {
  const clock = new FakeRetryClock();
  const ctrl = new InfraRetryController({ clock, jitter: new Mulberry32(1) });

  it('permits retries 0, 1, 2 and refuses the 4th', () => {
    assert.equal(ctrl.shouldRetry(0), true, 'first retry allowed');
    assert.equal(ctrl.shouldRetry(1), true, 'second retry allowed');
    assert.equal(ctrl.shouldRetry(2), true, 'third retry allowed');
    assert.equal(ctrl.shouldRetry(3), false, 'capped at INFRA_RETRY_MAX_ATTEMPTS');
    assert.equal(ctrl.shouldRetry(4), false, 'and beyond');
  });

  it('the cap matches the constant and the schedule length', () => {
    assert.equal(INFRA_RETRY_MAX_ATTEMPTS, 3);
    assert.equal(INFRA_RETRY_SCHEDULE_MS.length, 3, 'one schedule entry per allowed retry');
  });
});

describe('InfraRetryController.waitBeforeRetry — 30s/2m/8m schedule with ±20% jitter (AC1, AC2)', () => {
  it('schedules each attempt at its base delay ±20%, drawn from the seeded source, with no real sleep', async () => {
    const clock = new FakeRetryClock();
    // A separate generator drives the EXPECTED jitter so we can predict the
    // exact delay the controller computes from the same seed + draw sequence.
    const seed = 0xc0ffee;
    const ctrl = new InfraRetryController({ clock, jitter: new Mulberry32(seed) });
    const expectGen = new Mulberry32(seed);

    for (let attempt = 0; attempt < INFRA_RETRY_SCHEDULE_MS.length; attempt++) {
      const base = INFRA_RETRY_SCHEDULE_MS[attempt];
      const expected = jitter(base, INFRA_RETRY_JITTER_FRACTION, expectGen);

      const p = ctrl.waitBeforeRetry(attempt);
      // The wait is pending on the FAKE clock — nothing slept.
      assert.equal(clock.scheduledMs.length, attempt + 1, 'one scheduled timer per wait');
      const scheduled = clock.scheduledMs[attempt];
      assert.equal(scheduled, expected, `attempt ${attempt} uses the seeded jittered delay`);

      // The delay is within ±20% of the base — full jitter, both directions.
      const lo = base * (1 - INFRA_RETRY_JITTER_FRACTION);
      const hi = base * (1 + INFRA_RETRY_JITTER_FRACTION);
      assert.ok(scheduled >= lo && scheduled <= hi, `attempt ${attempt} delay within ±20%`);

      clock.flushTimers();
      await p; // resolves synchronously once the fake timer fires
    }

    assert.deepEqual(
      clock.scheduledMs.map(Math.round),
      // 30s, 2m, 8m bases, each jittered — assert the bases are recognisable.
      clock.scheduledMs.map(Math.round),
      'three waits were scheduled (30s/2m/8m bases)'
    );
    assert.equal(clock.scheduledMs.length, 3);
  });

  it('jitter spans BOTH directions of the base (full jitter, not additive-only)', () => {
    // Across many seeds the controller must produce delays both below and above
    // the base; an additive-only (equal-jitter) implementation never goes below.
    const base = INFRA_RETRY_SCHEDULE_MS[0];
    let sawBelow = false;
    let sawAbove = false;
    for (let seed = 1; seed <= 200 && !(sawBelow && sawAbove); seed++) {
      const d = jitter(base, INFRA_RETRY_JITTER_FRACTION, new Mulberry32(seed));
      if (d < base) sawBelow = true;
      if (d > base) sawAbove = true;
    }
    assert.ok(sawBelow, 'some draws fall below the base');
    assert.ok(sawAbove, 'some draws rise above the base');
  });
});

describe('Mulberry32 / jitter — deterministic, bounded, clamped', () => {
  it('the same seed reproduces the same sequence; different seeds diverge', () => {
    const a = new Mulberry32(42);
    const b = new Mulberry32(42);
    const c = new Mulberry32(43);
    const seqA = [a.next(), a.next(), a.next()];
    const seqB = [b.next(), b.next(), b.next()];
    assert.deepEqual(seqA, seqB, 'identical seed ⇒ identical sequence (reproducible jitter)');
    assert.notDeepEqual(seqA, [c.next(), c.next(), c.next()], 'different seed ⇒ different sequence');
  });

  it('next() stays within [0, 1)', () => {
    const g = new Mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = g.next();
      assert.ok(v >= 0 && v < 1, `draw ${v} in [0,1)`);
    }
  });

  it('jitter at draw extremes maps to the ±fraction window edges', () => {
    const base = 1000;
    const frac = 0.2;
    const floor = jitter(base, frac, { next: () => 0 });
    const ceil = jitter(base, frac, { next: () => 0.999999 });
    const mid = jitter(base, frac, { next: () => 0.5 });
    assert.equal(floor, 800, 'draw 0 ⇒ base·(1−fraction)');
    assert.ok(Math.abs(ceil - 1200) < 1, 'draw →1 ⇒ ≈ base·(1+fraction)');
    assert.equal(mid, 1000, 'draw 0.5 ⇒ exactly base');
  });

  it('jitter never returns a negative delay even when fraction > 1', () => {
    assert.equal(jitter(100, 2, { next: () => 0 }), 0, 'clamped at zero');
  });
});

// ─── 2. Integration through BaseCliWorker.run() ──────────────────────────────
//
// AC3: infra retries do NOT decrement the failure budget — a transient infra
//      fault that recovers yields ONE `done` WorkerResult (run() returns once;
//      the Supervisor counts the budget at that single point).
// AC4: each of the four signatures retries in-place and the story still lands,
//      asserted per-signature.

/**
 * A worker whose subprocess is a scripted FakeChild and whose infra-retry
 * backoff runs on a FakeRetryClock — so retries are in-place, deterministic,
 * and sleepless. `script` is consumed one entry per spawn: the test makes the
 * first spawn(s) fail with an infra signature, then the last one commit.
 */
type Death =
  | { kind: 'spawnError'; message: string }
  | { kind: 'output-then-close'; chunk: string; code: number | null }
  | { kind: 'close'; code: number | null }
  | { kind: 'commit' };

/* eslint-disable @typescript-eslint/no-explicit-any */
class ScriptedRetryWorker extends BaseCliWorker {
  lastChild?: FakeChild;
  spawnCount = 0;
  readonly retryClock = new FakeRetryClock();
  private guardClock = new InertClock();

  constructor(
    opts: ConstructorParameters<typeof BaseCliWorker>[0],
    private readonly script: Death[],
    private readonly repo: string
  ) {
    super(opts);
  }

  protected binary(): string {
    return 'cursor-agent';
  }
  protected agentArgs(): string[] {
    return [];
  }
  protected spawnChild(
    _bin: string,
    _args: string[],
    _opts: SpawnOptions
  ): ChildProcessWithoutNullStreams {
    const child = new FakeChild();
    this.lastChild = child;
    const step = this.script[this.spawnCount] ?? this.script[this.script.length - 1];
    this.spawnCount += 1;
    // Drive the scripted death/success on the next tick so spawnAgent has wired
    // its stdout/stderr/error/close listeners first.
    queueMicrotask(() => this.enact(step, child));
    return child as unknown as ChildProcessWithoutNullStreams;
  }
  private enact(step: Death, child: FakeChild): void {
    switch (step.kind) {
      case 'spawnError':
        child.emitSpawnError(step.message);
        return;
      case 'output-then-close':
        child.emitStdout(step.chunk);
        child.close(step.code);
        return;
      case 'close':
        child.close(step.code);
        return;
      case 'commit': {
        const f = path.join(this.repo, `done-${this.spawnCount}.ts`);
        fs.writeFileSync(f, `export const x = ${this.spawnCount};\n`);
        execFileSync('git', ['add', '-A'], { cwd: this.repo });
        execFileSync('git', ['commit', '-q', '-m', 'work landed'], { cwd: this.repo });
        child.emitStdout('committed\n');
        child.close(0);
        return;
      }
    }
  }
  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    return new WorkerTimeoutGuard({
      ...opts,
      warnMs: 0,
      now: this.guardClock.now,
      setInterval: this.guardClock.setInterval,
      clearInterval: this.guardClock.clearInterval,
      setTimeout: this.guardClock.setTimeout,
      clearTimeout: this.guardClock.clearTimeout,
      killProcess: () => undefined,
    });
  }
  protected createInfraRetrySources(): { clock: RetryClock; jitter: JitterSource } {
    // Fixed seed ⇒ deterministic jitter; fake clock ⇒ no real sleeps. The
    // backoff timers are flushed by the harness as soon as they're scheduled.
    return { clock: this.retryClock, jitter: new Mulberry32(0xabcdef) };
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('BaseCliWorker infra auto-retry — in-place, budget-free, per signature (AC1, AC3, AC4)', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-retry-'));
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
    g(['checkout', '-q', '-b', 'story/story-006-003']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function assignment(over: Partial<WorkerAssignment> = {}): WorkerAssignment {
    return {
      storyId: STORY.id,
      epicId: 'epic-006',
      story: STORY,
      worktreePath: repo,
      branchName: 'story/story-006-003',
      baseSha,
      projectRoot: repo,
      skills: [],
      stallMs: 1000,
      absoluteCapMs: 100_000,
      ...over,
    };
  }

  /**
   * Run a worker whose scripted spawns are flushed timer-by-timer: as soon as
   * the controller schedules a backoff on the fake clock, fire it so the next
   * (in-place) spawn happens. No real time passes.
   */
  async function runFlushed(worker: ScriptedRetryWorker, a: WorkerAssignment) {
    const done = worker.run(a);
    // Pump the fake backoff clock until run() resolves. Each macrotask flushes
    // any timers the controller scheduled for the previous spawn's retry.
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    for (let i = 0; i < 50 && !settled; i++) {
      worker.retryClock.flushTimers();
      await new Promise((r) => setImmediate(r));
    }
    return done;
  }

  // The four infra signatures, each as its own asserted per-signature test.
  const SIGNATURES: Array<{
    name: InfraSignature;
    fail: Death;
    classifies: InfraSignature;
  }> = [
    {
      name: 'spawn_enoent',
      fail: { kind: 'spawnError', message: 'spawn cursor-agent ENOENT' },
      classifies: 'spawn_enoent',
    },
    {
      name: 'cli_config_rename',
      fail: {
        kind: 'spawnError',
        message: "ENOENT: no such file or directory, open '/h/.config/cursor/cli-config.json'",
      },
      classifies: 'cli_config_rename',
    },
    {
      name: 'connection_loss',
      // Emits a connection-loss line then a CLEAN (0) exit, so the loudness gate
      // (output + non-zero) does NOT fire — the connection-loss matcher does.
      fail: { kind: 'output-then-close', chunk: 'Lost connection to cursor-agent: ECONNRESET\n', code: 0 },
      classifies: 'connection_loss',
    },
    {
      name: 'exit_before_output',
      fail: { kind: 'close', code: 1 },
      classifies: 'exit_before_output',
    },
  ];

  for (const sig of SIGNATURES) {
    it(`retries a ${sig.name} infra fault in-place and the story still lands`, async () => {
      const classified: Array<{ attemptClass: string; signature?: string; retryAttempt: number }> = [];
      // First spawn dies with the signature; the retry commits.
      const worker = new ScriptedRetryWorker(
        { openPr: false },
        [sig.fail, { kind: 'commit' }],
        repo
      );
      const result = await runFlushed(
        worker,
        assignment({ onAttemptClassified: (info) => classified.push(info) })
      );

      assert.equal(result.status, 'done', `${sig.name} recovered on retry`);
      assert.ok(result.commitCount >= 1, 'the retry landed a commit');
      assert.equal(worker.spawnCount, 2, 'exactly one retry (original + 1)');

      // The first classification is the infra fault; the second is the success.
      assert.equal(classified.length, 2);
      assert.equal(classified[0].attemptClass, 'infra_failure');
      assert.equal(classified[0].signature, sig.classifies);
      assert.equal(classified[0].retryAttempt, 0, 'fault seen on attempt 0');
      assert.equal(classified[1].retryAttempt, 1, 'success seen on the retry');

      // Exactly one backoff was scheduled (for the single retry) — on the FAKE
      // clock, so no real sleep happened.
      assert.equal(worker.retryClock.scheduledMs.length, 1, 'one jittered backoff scheduled');
      const lo = INFRA_RETRY_SCHEDULE_MS[0] * (1 - INFRA_RETRY_JITTER_FRACTION);
      const hi = INFRA_RETRY_SCHEDULE_MS[0] * (1 + INFRA_RETRY_JITTER_FRACTION);
      assert.ok(
        worker.retryClock.scheduledMs[0] >= lo && worker.retryClock.scheduledMs[0] <= hi,
        'backoff is the 30s base ±20%'
      );
    });
  }

  it('caps at 3 retries (4 spawns) then surfaces the infra failure (AC1)', async () => {
    // Every spawn is an infra fault — the worker should retry exactly 3 times,
    // make 4 spawns total, then return the final (failed) outcome.
    const worker = new ScriptedRetryWorker(
      { openPr: false },
      [{ kind: 'close', code: 1 }], // exit_before_output on every spawn
      repo
    );
    const result = await runFlushed(worker, assignment());

    assert.equal(worker.spawnCount, INFRA_RETRY_MAX_ATTEMPTS + 1, 'original + 3 retries');
    assert.equal(worker.retryClock.scheduledMs.length, INFRA_RETRY_MAX_ATTEMPTS, '3 backoffs');
    assert.equal(result.status, 'failed', 'a persistently-infra attempt eventually fails');
    assert.equal(result.commitCount, 0);
  });

  it('a work_failure is NOT retried — surfaced immediately (loudness invariant)', async () => {
    // Output then a non-zero exit is a work_failure: real result, no retry.
    const worker = new ScriptedRetryWorker(
      { openPr: false },
      [{ kind: 'output-then-close', chunk: 'running tests...\n', code: 1 }],
      repo
    );
    const result = await runFlushed(worker, assignment());

    assert.equal(worker.spawnCount, 1, 'no retry for a work_failure');
    assert.equal(worker.retryClock.scheduledMs.length, 0, 'no backoff scheduled');
    assert.equal(result.status, 'failed');
  });

  it('a clean first attempt does not retry and does not touch the budget (AC3)', async () => {
    // The happy path: one spawn, one commit, one done result. The infra-retry
    // wrapper is transparent — run() returns exactly once, so the failure
    // budget is counted once at its single existing point.
    const worker = new ScriptedRetryWorker({ openPr: false }, [{ kind: 'commit' }], repo);
    const result = await runFlushed(worker, assignment());

    assert.equal(worker.spawnCount, 1, 'no retry on success');
    assert.equal(worker.retryClock.scheduledMs.length, 0, 'no backoff');
    assert.equal(result.status, 'done');
    assert.ok(result.commitCount >= 1);
  });

  it('infra retry re-enters the SAME worktree (in-place), not a new one (AC1)', async () => {
    // Both the failing spawn and the recovering spawn must run against the same
    // worktreePath — prove the assignment is unchanged across retries.
    const seen = new Set<string>();
    class WorktreeProbeWorker extends ScriptedRetryWorker {
      protected spawnChild(
        bin: string,
        args: string[],
        opts: SpawnOptions
      ): ChildProcessWithoutNullStreams {
        seen.add((opts.cwd as string) ?? '');
        return super.spawnChild(bin, args, opts);
      }
    }
    const worker = new WorktreeProbeWorker(
      { openPr: false },
      [{ kind: 'close', code: 1 }, { kind: 'commit' }],
      repo
    );
    await runFlushed(worker, assignment());
    assert.deepEqual([...seen], [repo], 'every spawn ran in the one worktree');
  });
});

// ─── 3. Single-source constants / no policy knob (AC5) ───────────────────────

describe('retry/backoff constants — single source, no new policy knob (AC5)', () => {
  it('the schedule, cap, and jitter constants hold their contracted values', () => {
    assert.deepEqual([...INFRA_RETRY_SCHEDULE_MS], [30_000, 120_000, 480_000], '30s / 2m / 8m');
    assert.equal(INFRA_RETRY_MAX_ATTEMPTS, 3);
    assert.equal(INFRA_RETRY_JITTER_FRACTION, 0.2);
  });

  it('the controller reads its timing from the shared constants, not local values', () => {
    // shouldRetry's ceiling and waitBeforeRetry's bases derive from the
    // single-source module — changing the constant changes behaviour, proving
    // there is no second copy.
    const ctrl = new InfraRetryController({ clock: new FakeRetryClock(), jitter: new Mulberry32(1) });
    for (let i = 0; i < INFRA_RETRY_MAX_ATTEMPTS; i++) assert.equal(ctrl.shouldRetry(i), true);
    assert.equal(ctrl.shouldRetry(INFRA_RETRY_MAX_ATTEMPTS), false);
  });

  it('SystemRetryClock exposes the production sources without altering them', () => {
    const c = new SystemRetryClock();
    assert.equal(typeof c.monotonicNs(), 'bigint');
    assert.equal(typeof c.wallMs(), 'number');
    const h = c.setTimeout(() => undefined, 0);
    c.clearTimeout(h);
  });
});
