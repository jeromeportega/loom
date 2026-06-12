/**
 * Bounded auto-retry policy for a detected `infra_failure` (story-006-003).
 *
 * An infra fault is transient and environmental — the agent never started, the
 * connection dropped, the config file was mid-rename — so retrying the SAME
 * attempt in place often just works. This controller owns the two policy
 * decisions and nothing else:
 *
 *   - `shouldRetry(attempt)` — are we still under the attempt cap?
 *   - `waitBeforeRetry(attempt)` — sleep the scheduled backoff (with jitter)
 *     before the next attempt, driven through the injected clock so tests
 *     perform ZERO real sleeps.
 *
 * It deliberately does NOT decide *whether* an outcome is infra (that is the
 * classifier, story-006-002) and does NOT touch the story's failure budget
 * (ADR-3/ADR-5: infra retries re-enter the same worktree and are free — the
 * budget is counted once at the existing single point in `BaseCliWorker.run()`).
 * Every timing constant comes from the single-source `resilience/constants.ts`;
 * this class introduces no policy knob.
 */
import {
  INFRA_RETRY_SCHEDULE_MS,
  INFRA_RETRY_MAX_ATTEMPTS,
  INFRA_RETRY_JITTER_FRACTION,
} from './resilience/constants.js';
import { type RetryClock, type JitterSource, jitter } from './resilience/RetryClock.js';

export interface InfraRetryControllerOptions {
  clock: RetryClock;
  jitter: JitterSource;
}

export class InfraRetryController {
  private readonly clock: RetryClock;
  private readonly jitter: JitterSource;

  constructor(opts: InfraRetryControllerOptions) {
    this.clock = opts.clock;
    this.jitter = opts.jitter;
  }

  /**
   * May we make retry number `attempt + 1`? `attempt` is the count of retries
   * ALREADY performed (0 before the first retry). Capped at
   * `INFRA_RETRY_MAX_ATTEMPTS`, so the original spawn plus three retries is the
   * most any infra fault gets. Also guards against an attempt index that would
   * run past the end of the fixed schedule.
   */
  shouldRetry(attempt: number): boolean {
    return attempt < INFRA_RETRY_MAX_ATTEMPTS && attempt < INFRA_RETRY_SCHEDULE_MS.length;
  }

  /**
   * Resolve after the backoff for retry number `attempt + 1`:
   * `INFRA_RETRY_SCHEDULE_MS[attempt]` jittered by ±`INFRA_RETRY_JITTER_FRACTION`.
   * The wait is scheduled via `clock.setTimeout`, so an injected fake clock
   * makes the delay deterministic and instantaneous in tests. Indices beyond
   * the schedule resolve immediately (defensive — `shouldRetry` already bounds
   * the caller).
   */
  waitBeforeRetry(attempt: number): Promise<void> {
    const base = INFRA_RETRY_SCHEDULE_MS[attempt];
    if (base === undefined) return Promise.resolve();
    const delayMs = jitter(base, INFRA_RETRY_JITTER_FRACTION, this.jitter);
    return new Promise((resolve) => {
      this.clock.setTimeout(() => resolve(), delayMs);
    });
  }
}
