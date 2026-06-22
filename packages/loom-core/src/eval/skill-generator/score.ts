import type { CoreMetrics, EvalThresholds, RunRecord } from '../framework/types.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';

export interface SkillGeneratorMetrics extends CoreMetrics {
  decisionCorrectness:    number;  // deterministic
  spuriousGenerationRate: number;  // deterministic
  skillQuality:           number;
  faithfulness:           number;
  lowQualityRate:         number;
}

export interface SkillGeneratorBar {
  minDecisionCorrectness: number;
  minSkillQuality:        number;
  minFaithfulness:        number;
  maxSpuriousRate:        number;
  maxLowQualityRate:      number;
}

export const SKILL_GENERATOR_THRESHOLDS: EvalThresholds = {
  minScoredCases:           2,
  maxGateFailureRate:       0.25,
  maxJudgeInconclusiveRate: 0.25,
};

// Bodies filled by story-043-005.

export function scoreSkillGenerator(
  records: RunRecord<SkillGeneratorDecision, SkillGeneratorJudgment>[],
): SkillGeneratorMetrics {
  void records;
  throw new Error('scoreSkillGenerator: not implemented (story-043-005)');
}

export function resolveSkillGeneratorBar(opts?: Partial<SkillGeneratorBar>): SkillGeneratorBar {
  void opts;
  throw new Error('resolveSkillGeneratorBar: not implemented (story-043-005)');
}

export function skillGeneratorVerdict(m: SkillGeneratorMetrics): 'proceed' | 'do-not-proceed' {
  void m;
  throw new Error('skillGeneratorVerdict: not implemented (story-043-005)');
}
