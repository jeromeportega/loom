/**
 * Single source of truth for every resilience timing/backoff constant in
 * epic-006. The auto-retry schedule, attempt cap, and jitter fraction live
 * HERE and nowhere else — there is deliberately no policy knob for any of them
 * (story-006-003 AC5). An operator does not have the calibration data to tune a
 * backoff schedule better than the engineering default, so it stays in source.
 *
 * Ownership (epic-006 shared contract): story-006-003 creates and is the sole
 * editor of this file. story-006-004/005/007 import the constants they need
 * (`SPAWN_STAGGER_*`, `SUSPEND_POLL_MULTIPLE`, `STOP_CHECKPOINT_TIMEOUT_MS`)
 * but MUST NOT append to it — a genuinely new constant is a one-line addition
 * requested of this file's owner, never a locally-redeclared divergent value.
 */

/**
 * Fixed auto-retry backoff schedule for a detected `infra_failure`: 30s, then
 * 2m, then 8m. Indexed by the zero-based retry attempt (the delay BEFORE
 * attempt N is `INFRA_RETRY_SCHEDULE_MS[N]`). No complexity scaling — an infra
 * fault is environmental, not proportional to the story's size.
 */
export const INFRA_RETRY_SCHEDULE_MS = [30_000, 120_000, 480_000] as const; // 30s / 2m / 8m

/**
 * Hard ceiling on auto-retries for a single attempt point. Three retries map
 * onto the three schedule entries; the original attempt plus three retries is
 * the most an infra fault ever gets before the failure is surfaced.
 */
export const INFRA_RETRY_MAX_ATTEMPTS = 3;

/**
 * ±20% full-jitter applied to each scheduled delay. Drawn from an injectable
 * seeded source so a thundering herd of simultaneously-failed workers does not
 * re-storm the same backend in lockstep, while tests stay fully deterministic.
 */
export const INFRA_RETRY_JITTER_FRACTION = 0.2; // ±20% full jitter

/** Spawn-stagger window (story-006-004). Min/max jittered delay before each spawn. */
export const SPAWN_STAGGER_MIN_MS = 1_000;
export const SPAWN_STAGGER_MAX_MS = 2_000;

/** Suspend detection (story-006-005): a wall jump > 6× pollMs ⇒ machine slept. */
export const SUSPEND_POLL_MULTIPLE = 6;

/** Per-worker WIP-commit bound for `loom stop` (story-006-007). */
export const STOP_CHECKPOINT_TIMEOUT_MS = 30_000;
