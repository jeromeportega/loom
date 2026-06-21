import type { SkillQualityBandType } from './caseSchema.js';

export const BANDS: Record<SkillQualityBandType, readonly [number, number]> = {
  bad:        [0, 4],
  borderline: [5, 6],
  good:       [7, 10],
} as const;

export const BAND_TOLERANCE = 1;

export function scoreInBand(score: number, band: SkillQualityBandType): boolean {
  if (score < 0) return false;
  const [lo, hi] = BANDS[band];
  return score >= lo - BAND_TOLERANCE && score <= hi + BAND_TOLERANCE;
}
