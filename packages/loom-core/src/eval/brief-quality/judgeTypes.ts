import type { CoreMetrics } from '../framework/types.js';

export interface BriefQualityJudgment {
  readiness_correct: boolean;
  quality_in_band:   boolean;
  critique_fidelity: 'faithful' | 'partial' | 'fabricated';
  reason:            string;
}

export interface BriefQualityMetrics extends CoreMetrics {
  readinessAccuracy:    number;   // readiness_correct / scoredCases
  qualityBandAgreement: number;   // quality_in_band   / scoredCases
  critiqueQuality:      number;   // (faithful + 0.5·partial) / scoredCases
}
