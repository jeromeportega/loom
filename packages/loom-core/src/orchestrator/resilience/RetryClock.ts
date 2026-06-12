/**
 * Injectable time, timer, and randomness sources for epic-006's resilience
 * machinery. Production wires these to the real `process.hrtime.bigint()`,
 * `Date.now()`, and `setTimeout`; tests inject deterministic fakes so backoff
 * math is asserted with ZERO real sleeps.
 *
 * Ownership (epic-006 shared contract): story-006-003 creates and owns this
 * file. story-006-004 (stagger), story-006-005 (suspend math), and
 * story-006-007 (checkpoint bound) take a `RetryClock`/`JitterSource` as
 * injected parameters — none re-declares these interfaces.
 */

/**
 * The clock + timer surface the retry/stagger/checkpoint paths need. Split
 * monotonic-vs-wall on purpose:
 *   - `monotonicNs` (hrtime) measures *durations* and never jumps backward or
 *     skips on an NTP step / VM resume — use it for "how long has X taken".
 *   - `wallMs` (Date.now) is for suspend detection ONLY (story-006-005): a
 *     large wall jump with little monotonic progress means the machine slept.
 * `setTimeout`/`clearTimeout` are seams so a backoff wait is driven by a fake
 * timer in tests rather than the real event loop.
 */
export interface RetryClock {
  /** Monotonic nanoseconds — production = `process.hrtime.bigint()`. Duration math. */
  monotonicNs(): bigint;
  /** Wall-clock milliseconds — production = `Date.now()`. Suspend detection only. */
  wallMs(): number;
  /** Schedule a one-shot callback after `ms`. Returns an opaque handle. */
  setTimeout(fn: () => void, ms: number): unknown;
  /** Cancel a handle returned by `setTimeout`. */
  clearTimeout(handle: unknown): void;
}

/** A deterministic source of values in `[0, 1)`, seeded for reproducibility. */
export interface JitterSource {
  /** Next value in `[0, 1)`. Deterministic given the same seed + call sequence. */
  next(): number;
}

/**
 * The production clock — real monotonic/wall time and the global timer. Pure
 * delegation; exists so production code instantiates one obvious object and
 * tests substitute their own.
 */
export class SystemRetryClock implements RetryClock {
  monotonicNs(): bigint {
    return process.hrtime.bigint();
  }
  wallMs(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms);
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/**
 * Apply ±`fraction` FULL jitter to `baseMs` using one draw from `src`.
 *
 * Full jitter spreads the delay uniformly across the whole window
 * `[baseMs·(1−fraction), baseMs·(1+fraction)]` rather than only ever adding
 * (equal-jitter) — the strongest de-synchronisation for a herd of workers that
 * failed at the same instant. A draw of 0 maps to the floor, →1 maps toward
 * the ceiling, 0.5 maps to exactly `baseMs`. The result is clamped at 0 so a
 * pathological `fraction > 1` can never yield a negative delay. With the
 * shipped `INFRA_RETRY_JITTER_FRACTION = 0.2`, clamping never triggers.
 */
export function jitter(baseMs: number, fraction: number, src: JitterSource): number {
  const offset = (src.next() * 2 - 1) * fraction * baseMs;
  return Math.max(0, baseMs + offset);
}

/**
 * A ~30-line `mulberry32` seeded PRNG. Tiny, fast, fully deterministic given a
 * 32-bit seed — the canonical choice for "I need reproducible jitter in a test
 * without pulling in a dependency". NOT cryptographically secure; it never
 * guards anything secret, it only de-synchronises retries.
 *
 * Each `next()` advances the internal state and returns a fresh value in
 * `[0, 1)`; the same seed always produces the same sequence, which is exactly
 * what lets tests assert an exact post-jitter delay.
 */
export class Mulberry32 implements JitterSource {
  private state: number;

  constructor(seed: number) {
    // Force the seed into an unsigned 32-bit integer so the generator is
    // well-defined for any numeric input (negatives, floats, > 2^32).
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
