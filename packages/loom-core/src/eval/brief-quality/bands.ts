/**
 * Band boundaries for brief-quality eval (FR-11, ADR-003).
 *
 * quality_score is an integer 0–10 produced by BriefRefiner.
 * A score s is "in band" when  lo ≤ s ≤ hi.
 *
 * Operator review note: verify these cuts before each eval run to confirm
 * they still reflect the team's quality bar. Change them here, not in the
 * scorer or judge — this is the single source of truth.
 *
 *   low  0–3  : vague, missing key scope elements, not plan-ready
 *   mid  4–6  : borderline — has structure but has gaps that need clarification
 *   high 7–10 : well-scoped, testable criteria, ready to plan
 *
 * BAND_TOLERANCE (τ=1): a score is accepted as agreeing with the expected band
 * if it falls within [lo−τ, hi+τ].  A single-point margin absorbs natural
 * scoring jitter at band edges without masking systematic off-by-one errors.
 */

export const BANDS = {
  low:  [0, 3],
  mid:  [4, 6],
  high: [7, 10],
} as const;

export const BAND_TOLERANCE = 1;
