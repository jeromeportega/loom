/**
 * Band boundaries for the skill-judge gate eval (ADR-003).
 *
 * skill_md scores are 0–10 integers from SkillJudge.
 * A score s is "in band" when  lo ≤ s ≤ hi.
 *
 *   bad        0 – (JUDGE_MIN_SCORE−2) : clearly reject — vague, unsafe, not reusable
 *   borderline (JUDGE_MIN_SCORE−1) – JUDGE_MIN_SCORE : marginal — close call
 *   good       (JUDGE_MIN_SCORE+1) – 10 : clearly accept — crisp, reusable, safe
 *
 * BAND_TOLERANCE (τ=1): a score agrees with the expected band if it falls
 * within [max(lo−τ, 0), hi+τ].  The low bound is clamped at 0 because skill
 * scores are never negative — any score < 0 is always out of every band.
 * The single-point margin absorbs natural scoring jitter at band edges without
 * masking systematic off-by-one errors (ADR-003).
 *
 * Bands are anchored to JUDGE_MIN_SCORE (skills/judgeMinScore.ts) — the eval's
 * SSOT for the policy default.  Never hard-code 6 here.
 * ADR-001: one-way dependency eval → skills; never the reverse.
 *
 * The 999 fail-open sentinel (ADR-005) is always out of every band because
 * 999 > hi + τ for all bands, and scores < 0 are explicitly rejected.
 * scoreInBand(999, *) === false and scoreInBand(-1, *) === false.
 */
import { JUDGE_MIN_SCORE } from '../../skills/judgeMinScore.js';
import type { SkillQualityBandType } from './caseSchema.js';

export { JUDGE_MIN_SCORE };

export const BANDS: Record<SkillQualityBandType, readonly [number, number]> = {
  bad:        [0,                      JUDGE_MIN_SCORE - 2],
  borderline: [JUDGE_MIN_SCORE - 1,    JUDGE_MIN_SCORE    ],
  good:       [JUDGE_MIN_SCORE + 1,    10                 ],
} as const;

export const BAND_TOLERANCE = 1;

export function scoreInBand(score: number, band: SkillQualityBandType): boolean {
  if (score < 0) return false;
  const [lo, hi] = BANDS[band];
  return score >= lo - BAND_TOLERANCE && score <= hi + BAND_TOLERANCE;
}
