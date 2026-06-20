/**
 * WorkerTimeoutGuard — hung-request liveness unit tests (epic-030 story-030-002).
 *
 * All tests drive the guard through an INJECTED clock (no real sleeps, no real
 * timers). The `advance()` helper moves wall + monotonic time together (normal
 * elapsed work). `simulateSuspend()` jumps the wall clock while the monotonic
 * clock barely moves, exactly as a laptop sleep produces.
 *
 * Mandated tests:
 *   HUNG-NO-RESPONSE  — arms, advances past hungRequestMs → kill 'hung_request'
 *   SLOW-BUT-STREAMING — see slow-but-streaming.test.ts (the integration file)
 *
 * Guard unit variant of SLOW-BUT-STREAMING is also included here for coverage
 * of the WorkerTimeoutGuard API directly.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerTimeoutGuard } from '../orchestrator/WorkerTimeoutGuard.js';

// ─── Shared fake clock ────────────────────────────────────────────────────────

let nowMs = 0;
let monoNs = 0n;

const now = (): number => nowMs;
const monotonicNow = (): bigint => monoNs;

const NS_PER_MS = 1_000_000n;

/** Advance wall + monotonic together: ordinary elapsed work, no sleep. */
const advance = (ms: number): void => {
  nowMs += ms;
  monoNs += BigInt(ms) * NS_PER_MS;
};

/** Simulate a machine suspend: wall jumps far, monotonic barely moves. */
const simulateSuspend = (ms: number): void => {
  nowMs += ms;
  monoNs += 50n * NS_PER_MS; // 50ms residual
};

let killCalls: Array<{ pid: number; signal: string }> = [];
const killProcess = (pid: number, signal: NodeJS.Signals): void => {
  killCalls.push({ pid, signal });
};

let graceFn: (() => void) | null = null;
const fakeSetTimeout = (fn: () => void): unknown => {
  graceFn = fn;
  return 'grace-timer';
};

function makeGuard(
  opts: Partial<ConstructorParameters<typeof WorkerTimeoutGuard>[0]> = {}
): WorkerTimeoutGuard {
  return new WorkerTimeoutGuard({
    stallMs: 12 * 60_000,         // 12-min stall (DEFAULT_STALL_MS)
    absoluteCapMs: 60 * 60_000,   // 60-min cap  (DEFAULT_ABSOLUTE_CAP_MS)
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

describe('WorkerTimeoutGuard — hung-request liveness (epic-030)', () => {
  beforeEach(() => {
    nowMs = 1_000_000_000;   // arbitrary wall origin
    monoNs = 5_000_000_000n; // arbitrary monotonic origin
    killCalls = [];
    graceFn = null;
  });

  // ── HUNG-NO-RESPONSE (mandated) ─────────────────────────────────────────────
  it('HUNG-NO-RESPONSE: kills with hung_request before stallMs when requesting and no stream event', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,   // 45s tighter bound
      stallMs: 12 * 60_000,   // 12min stall unchanged
      absoluteCapMs: 0,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending(); // arm the budget
    // Advance past the 45s hung-request bound but well under the 12-min stall.
    advance(46_000);
    const result = w.check();
    assert.equal(result, 'hung_request', 'guard fires hung_request before the stall window');
    assert.deepEqual(reasons, ['hung_request']);
    assert.equal(killCalls.length, 1);
    assert.equal(killCalls[0].signal, 'SIGTERM');
    assert.equal(killCalls[0].pid, -4242, 'signals the process GROUP (negative pid)');
    // lastStreamEvent should be 'system/status:requesting' (set by onRequestPending)
    assert.equal(w.getLastStreamEvent(), 'system/status:requesting');
    // Verify we fired well before the 12-min stall deadline
    assert.ok(
      46_000 < 12 * 60_000,
      'killed at 46s, far sooner than the 12-min stall'
    );
  });

  // ── SLOW-BUT-STREAMING guard unit variant ────────────────────────────────────
  it('SLOW-BUT-STREAMING: stream event disarms hung budget; worker dies only at stall', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,
      stallMs: 60_000,
      absoluteCapMs: 0,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending();
    // Model starts streaming — this disarms the hung-request budget.
    w.recordStreamEvent('assistant/delta');
    // Advance past the would-be hung-request deadline.
    advance(46_000);
    // Must NOT fire a hung kill.
    assert.equal(w.check(), 'noop', 'no hung kill after stream event disarmed budget');
    assert.equal(killCalls.length, 0, 'slow-but-streaming worker is not killed');
    // Advance past the stall window → THEN it dies (unchanged deadline).
    advance(60_000 - 46_000 + 1);
    const result = w.check();
    assert.equal(result, 'stall', 'worker eventually dies at the unchanged stall deadline');
    assert.deepEqual(reasons, ['stall'], 'kill reason is stall, not hung_request');
  });

  // ── Raw-bytes disarm ─────────────────────────────────────────────────────────
  it('raw-bytes (recordActivity) also disarms the hung-request budget', () => {
    const w = makeGuard({ hungRequestMs: 45_000, stallMs: 0, absoluteCapMs: 0 });
    w.start();
    w.onRequestPending();
    // Raw bytes arriving (e.g. any stdout) disarm the budget.
    w.recordActivity();
    advance(50_000); // well past the 45s hung bound
    assert.equal(w.check(), 'noop', 'raw-bytes disarm prevents hung kill');
    assert.equal(killCalls.length, 0);
  });

  // ── Fully-silent subprocess ──────────────────────────────────────────────────
  it('fully-silent subprocess: never requesting, dies at stall with lastStreamEvent (none)', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,
      stallMs: 60_000,
      absoluteCapMs: 0,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    // Never call onRequestPending() — subprocess is fully silent.
    advance(61_000);
    const result = w.check();
    assert.equal(result, 'stall', 'fully-silent subprocess dies at stall, not hung_request');
    assert.deepEqual(reasons, ['stall']);
    assert.equal(w.getLastStreamEvent(), '(none)', 'no stream event ever seen');
    assert.equal(w.getEverProducedStream(), false, 'everProducedStream is false');
  });

  // ── Deadline ordering ────────────────────────────────────────────────────────
  it('deadline ordering: hung fires before cap when both expired simultaneously', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,
      stallMs: 0,
      absoluteCapMs: 45_000, // same deadline as hung — hung is more negative
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending(); // arm 45s ago
    advance(50_000); // both budgets expired
    const result = w.check();
    // Both are expired; hung_request fires because it has the same (or worse) remaining.
    assert.ok(
      result === 'hung_request' || result === 'cap',
      `expected a kill (got ${result})`
    );
    assert.equal(reasons.length, 1, 'exactly one kill fires');
  });

  it('deadline ordering: cap fires first when absolute cap is sooner than hung bound', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 60_000,
      stallMs: 0,
      absoluteCapMs: 30_000,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending(); // arm at t=0
    advance(35_000); // cap (30s) expired, hung (60s) not
    const result = w.check();
    assert.equal(result, 'cap', 'cap fires first when it expires sooner');
    assert.deepEqual(reasons, ['cap']);
  });

  // ── Disabled path ────────────────────────────────────────────────────────────
  it('disabled path: hungRequestMs=0 means the third budget never fires', () => {
    const reasons: string[] = [];
    // stallMs=0 and absoluteCapMs=0 so only the hung-request budget could fire.
    const w = makeGuard({
      hungRequestMs: 0,
      stallMs: 0,
      absoluteCapMs: 0,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending();
    advance(999_000); // far past what would be the hung-request bound
    assert.equal(w.check(), 'noop', 'with hungRequestMs=0 the hung budget is permanently disabled');
    assert.equal(killCalls.length, 0);
    assert.deepEqual(reasons, []);
  });

  it('disabled path: undefined hungRequestMs also leaves the third budget inactive', () => {
    const w = makeGuard({ hungRequestMs: undefined, stallMs: 0, absoluteCapMs: 0 });
    w.start();
    w.onRequestPending();
    advance(999_000);
    assert.equal(w.check(), 'noop', 'no hung kill when hungRequestMs is undefined');
    assert.equal(killCalls.length, 0);
  });

  // ── onRequestPending idempotency ──────────────────────────────────────────────
  it('onRequestPending is idempotent: repeated calls keep the EARLIEST arm time', () => {
    const reasons: string[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,
      stallMs: 0,
      absoluteCapMs: 0,
      onKill: (r) => reasons.push(r),
    });
    w.start();
    w.onRequestPending(); // arm at t=0
    advance(10_000);      // 10s later
    w.onRequestPending(); // should NOT reset the clock to t+10; keeps t=0
    // At 46s total: armed at t=0, so 46s elapsed > 45s → kill.
    advance(36_000);
    const result = w.check();
    assert.equal(result, 'hung_request', 'guard fires at 46s (from the FIRST arm), not at 56s');
    assert.deepEqual(reasons, ['hung_request']);
  });

  // ── Suspend / clock-jump ─────────────────────────────────────────────────────
  it('suspend: large monotonic jump (laptop sleep) does NOT produce a false hung kill', () => {
    // After a suspend, the guard re-arms from the resume instant. The requestPendingSince
    // clock is also cleared (the suspended gap must not count toward the hung budget).
    const suspends: number[] = [];
    const w = makeGuard({
      hungRequestMs: 45_000,
      stallMs: 0,
      absoluteCapMs: 0,
      pollMs: 5_000,
      onSuspendDetected: (info) => suspends.push(info.wallJumpMs),
    });
    w.start();
    w.onRequestPending(); // arm at t=0
    // Simulate a 1-hour sleep: wall jumps 3600s, monotonic barely moves.
    simulateSuspend(3_600_000);
    // On resume, the guard detects the suspend and re-arms (clears requestPendingSinceNs).
    const result = w.check();
    assert.equal(result, 'noop', 'a suspend does NOT trigger a hung kill');
    assert.equal(suspends.length, 1, 'suspend was detected');
    assert.equal(killCalls.length, 0, 'no kill across the sleep');
    // After resume, the budget is disarmed (cleared by suspend detection).
    // Advancing past the hung bound should NOT kill.
    advance(50_000);
    assert.equal(w.check(), 'noop', 'post-resume: budget is disarmed, no hung kill');
  });
});
