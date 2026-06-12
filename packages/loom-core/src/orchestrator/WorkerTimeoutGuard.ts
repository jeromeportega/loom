/**
 * Coordinates the wall-clock kill paths for a single worker subprocess.
 *
 * Replaces the blunt single `setTimeout(SIGTERM, 30min)` that used to live in
 * `BaseCliWorker.spawnAgent`. That timer killed long-but-productive stories
 * (active editing, ran out of clock) and discarded their work. This guard:
 *
 *   - resets on *output activity* (stdout/stderr), the one liveness signal
 *     common to every backend (claude-cli, cursor-cli, the mock) and one that
 *     stays live during a long streaming test run — so a worker is only killed
 *     when it is genuinely silent (`stallMs`) or has run past an absolute
 *     ceiling (`absoluteCapMs`);
 *   - kills the worker's whole *process group* (the agent CLI often spawns its
 *     own children — a test runner, a build), not just the immediate child;
 *   - escalates SIGTERM -> SIGKILL after a grace window so a child that ignores
 *     SIGTERM can never hang the supervisor forever.
 *
 * Methodology note: the guard never alters what the worker SEES. It only bounds
 * how long the supervisor waits. Time/timer/kill sources are all injectable so
 * the logic is unit-testable without real time (mirrors WorkerWatchdog).
 *
 * Sleep-proofing (epic-006 story-006-005): ALL duration math runs on a
 * MONOTONIC clock (`monotonicNow`, production `process.hrtime.bigint()`), which
 * does not jump on an NTP step or a laptop suspend. The wall clock is consulted
 * ONLY to detect a suspend: a tick that sees the WALL time jump more than
 * `SUSPEND_POLL_MULTIPLE × pollMs` while the MONOTONIC delta stayed small means
 * the machine slept between ticks. On a detected suspend the guard re-arms its
 * start/activity instants from the resume moment and returns a no-op kill — it
 * forgives only the slept gap (ADR-4). A worker still silent for a full stall
 * window AFTER resume is killed normally; the caller routes the slept worker
 * through epic-006's shared infra-retry path.
 */
import { SUSPEND_POLL_MULTIPLE } from './resilience/constants.js';

export type TimeoutKillReason = 'stall' | 'cap' | 'budget';

export interface WorkerTimeoutGuardOptions {
  /** Kill after this many ms with zero output activity. 0 disables the stall kill. */
  stallMs: number;
  /** Kill after this many ms total regardless of activity. 0 disables the cap. */
  absoluteCapMs: number;
  /** SIGTERM -> SIGKILL escalation window. Default 10_000ms. */
  graceMs?: number;
  /**
   * Emit the one-shot `onWarn` when the nearest deadline is within this many
   * ms. Default 60_000. Set 0 (or omit `onWarn`) to disable the warning.
   */
  warnMs?: number;
  /** Poll interval in ms. Default 5_000. */
  pollMs?: number;
  /** Returns the current pid of the worker (group leader), or undefined once it exits. */
  getPid: () => number | undefined;
  /**
   * Invoked exactly once when the guard decides to kill for a wall-clock
   * reason ('stall' | 'cap'). The worker uses this to flag the run as
   * timed-out so `run()` can checkpoint + report. Not called for 'budget'
   * (the caller drives that via `terminate('budget')`).
   */
  onKill?: (reason: 'stall' | 'cap') => void;
  /** One-shot near-deadline warning. */
  onWarn?: (info: { reason: TimeoutKillReason; elapsedMs: number; remainingMs: number }) => void;
  /**
   * Invoked each time a tick detects a machine suspend (a wall-clock jump
   * greater than `SUSPEND_POLL_MULTIPLE × pollMs` with little monotonic
   * progress). The caller uses this to route the slept worker through
   * epic-006's shared infra-retry path. The guard has already re-armed its
   * timers from the resume instant by the time this fires; it does NOT kill
   * on the slept tick.
   */
  onSuspendDetected?: (info: { wallJumpMs: number }) => void;
  // ─── Injectable sources (default to the globals; overridden in tests) ──────
  /**
   * Monotonic time source for ALL duration math — production
   * `process.hrtime.bigint()` (nanoseconds). A monotonic clock never jumps
   * backward and does not skip forward on an NTP step or a VM/laptop resume,
   * so stall/cap budgets measure true elapsed work, not wall-clock drift.
   */
  monotonicNow?: () => bigint;
  /**
   * Wall-clock source — production `Date.now()` (ms). Used ONLY for suspend
   * detection (comparing the wall delta against the monotonic delta per tick);
   * never for duration math.
   */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Defaults to process.kill. Called with a NEGATIVE pid to signal the group. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_WARN_MS = 60_000;
const DEFAULT_POLL_MS = 5_000;
const NS_PER_MS = 1_000_000n;

export class WorkerTimeoutGuard {
  /** Monotonic start instant (ns). All duration math is relative to this. */
  private startNs: bigint;
  /** Monotonic instant of the last output activity (ns). */
  private lastActivityNs: bigint;
  /** Wall-clock reading captured on the previous tick — suspend detection only. */
  private lastTickWallMs: number;
  /** Monotonic reading captured on the previous tick — suspend detection only. */
  private lastTickNs: bigint;
  private pollHandle: unknown;
  private graceHandle: unknown;
  private warned = false;
  private terminating = false;

  constructor(private readonly opts: WorkerTimeoutGuardOptions) {
    this.startNs = this.monoNow();
    this.lastActivityNs = this.startNs;
    this.lastTickNs = this.startNs;
    this.lastTickWallMs = this.wallNow();
  }

  private monoNow(): bigint {
    return this.opts.monotonicNow ? this.opts.monotonicNow() : process.hrtime.bigint();
  }

  private wallNow(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Begin polling. Call once, right after the subprocess spawns. */
  start(): void {
    const setIntervalFn = this.opts.setInterval ?? setInterval;
    this.pollHandle = setIntervalFn(() => this.check(), this.opts.pollMs ?? DEFAULT_POLL_MS);
  }

  /** Reset the stall clock. Wire into the stdout/stderr data handlers. */
  recordActivity(): void {
    this.lastActivityNs = this.monoNow();
  }

  /** Tear down all timers. Idempotent — call from the subprocess close/error handlers. */
  stop(): void {
    if (this.pollHandle !== undefined) {
      (this.opts.clearInterval ?? clearInterval)(this.pollHandle as never);
      this.pollHandle = undefined;
    }
    if (this.graceHandle !== undefined) {
      (this.opts.clearTimeout ?? clearTimeout)(this.graceHandle as never);
      this.graceHandle = undefined;
    }
  }

  /**
   * Evaluate the deadlines. Public so tests can drive it without real timers.
   * Returns the action taken on this tick.
   *
   * Suspend detection runs FIRST: if the wall clock jumped more than
   * `SUSPEND_POLL_MULTIPLE × pollMs` since the previous tick while the
   * monotonic clock barely moved, the machine slept. We re-arm `startNs` and
   * `lastActivityNs` from the resume instant (forgiving exactly the slept gap),
   * notify the caller so it can route through the infra-retry path, and return
   * a no-op — the worker is NOT killed for being silent across the sleep. A
   * worker that stays silent for a full stall window AFTER resume is killed by
   * a later tick, normally.
   */
  check(): 'noop' | 'warn' | TimeoutKillReason {
    if (this.terminating) return 'noop';

    const monoNow = this.monoNow();
    const wallNow = this.wallNow();

    // ── Suspend detection (wall vs monotonic divergence since the last tick) ──
    const pollMs = this.opts.pollMs ?? DEFAULT_POLL_MS;
    const suspendThresholdMs = SUSPEND_POLL_MULTIPLE * pollMs;
    const wallDeltaMs = wallNow - this.lastTickWallMs;
    const monoDeltaMs = Number((monoNow - this.lastTickNs) / NS_PER_MS);
    if (
      pollMs > 0 &&
      wallDeltaMs > suspendThresholdMs &&
      monoDeltaMs <= suspendThresholdMs
    ) {
      // The machine slept. Forgive the slept gap: re-arm both the absolute and
      // the stall clocks to the resume instant so neither budget counts the
      // sleep. Monotonic time barely advanced across the sleep, so anchoring to
      // `monoNow` simply discards the small idle delta — exactly the gap.
      this.startNs = monoNow;
      this.lastActivityNs = monoNow;
      this.lastTickNs = monoNow;
      this.lastTickWallMs = wallNow;
      this.opts.onSuspendDetected?.({ wallJumpMs: wallDeltaMs });
      return 'noop';
    }
    this.lastTickNs = monoNow;
    this.lastTickWallMs = wallNow;

    const elapsed = Number((monoNow - this.startNs) / NS_PER_MS);
    const sinceActivity = Number((monoNow - this.lastActivityNs) / NS_PER_MS);

    const capRemaining =
      this.opts.absoluteCapMs > 0 ? this.opts.absoluteCapMs - elapsed : Infinity;
    const stallRemaining =
      this.opts.stallMs > 0 ? this.opts.stallMs - sinceActivity : Infinity;
    const minRemaining = Math.min(capRemaining, stallRemaining);

    const warnMs = this.opts.warnMs ?? DEFAULT_WARN_MS;
    if (
      !this.warned &&
      this.opts.onWarn &&
      warnMs > 0 &&
      minRemaining !== Infinity &&
      minRemaining <= warnMs &&
      minRemaining > 0
    ) {
      this.warned = true;
      const reason: TimeoutKillReason = capRemaining <= stallRemaining ? 'cap' : 'stall';
      this.opts.onWarn({ reason, elapsedMs: elapsed, remainingMs: Math.max(0, minRemaining) });
    }

    if (capRemaining <= 0) {
      this.opts.onKill?.('cap');
      this.terminate('cap');
      return 'cap';
    }
    if (stallRemaining <= 0) {
      this.opts.onKill?.('stall');
      this.terminate('stall');
      return 'stall';
    }
    return this.warned ? 'warn' : 'noop';
  }

  /**
   * Send SIGTERM to the worker's process group, then schedule a SIGKILL
   * escalation after the grace window. Safe to call from any kill path
   * (stall/cap via `check`, or 'budget' from the caller). Idempotent.
   */
  terminate(_reason: TimeoutKillReason): void {
    if (this.terminating) return;
    this.terminating = true;
    // Stop polling — we've decided to kill. Keep the grace handle alive so the
    // SIGKILL escalation can still fire, so don't call stop() here.
    if (this.pollHandle !== undefined) {
      (this.opts.clearInterval ?? clearInterval)(this.pollHandle as never);
      this.pollHandle = undefined;
    }
    const kill = this.opts.killProcess ?? process.kill;
    const pid = this.opts.getPid();
    if (pid === undefined) return;
    this.signalGroup(kill, pid, 'SIGTERM');
    const graceMs = this.opts.graceMs ?? DEFAULT_GRACE_MS;
    const setTimeoutFn = this.opts.setTimeout ?? setTimeout;
    this.graceHandle = setTimeoutFn(() => {
      const stillThere = this.opts.getPid();
      if (stillThere !== undefined) {
        this.signalGroup(kill, stillThere, 'SIGKILL');
      }
    }, graceMs);
  }

  /**
   * Signal the process *group* (negative pid). Workers are spawned `detached`
   * so the child is its own group leader (pgid == pid); signalling the group
   * reaps grandchildren (the test runner the agent launched). Falls back to a
   * direct signal if the group signal fails (e.g. child already gone).
   */
  private signalGroup(
    kill: (pid: number, signal: NodeJS.Signals) => void,
    pid: number,
    signal: NodeJS.Signals
  ): void {
    try {
      kill(-pid, signal);
    } catch {
      try {
        kill(pid, signal);
      } catch {
        // Process already exited — nothing to do.
      }
    }
  }
}
