import type { CoreMetrics, EvalThresholds, Decision } from './types.js';

export function decide<TMetrics extends CoreMetrics>(
  metrics: TMetrics,
  thresholds: EvalThresholds,
  verdict: (m: TMetrics) => 'proceed' | 'do-not-proceed',
): Decision {
  if (metrics.scoredCases < thresholds.minScoredCases) {
    return {
      verdict: 'inconclusive',
      reasons: [
        `scoredCases ${metrics.scoredCases} < minScoredCases ${thresholds.minScoredCases}`,
      ],
    };
  }

  if (metrics.gateFailureRate > thresholds.maxGateFailureRate) {
    return {
      verdict: 'inconclusive',
      reasons: [
        `gateFailureRate ${metrics.gateFailureRate} > maxGateFailureRate ${thresholds.maxGateFailureRate}`,
      ],
    };
  }

  if (metrics.judgeInconclusiveRate > thresholds.maxJudgeInconclusiveRate) {
    return {
      verdict: 'inconclusive',
      reasons: [
        `judgeInconclusiveRate ${metrics.judgeInconclusiveRate} > maxJudgeInconclusiveRate ${thresholds.maxJudgeInconclusiveRate}`,
      ],
    };
  }

  return { verdict: verdict(metrics), reasons: [] };
}
