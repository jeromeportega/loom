import { coreMetrics } from '../framework/coreMetrics.js';
import type { RunRecord, CoreMetrics, EvalThresholds } from '../framework/types.js';
import type { JudgeResult } from '../../skills/SkillJudge.js';
import type { SkillJudgeJudgment } from './judgeTypes.js';

export interface SkillJudgeMetrics extends CoreMetrics {
  decisionAccuracy:     number;
  bandAgreement:        number;
  independentAgreement: number;
  failOpenObserved:     number;
}

export const SKILL_JUDGE_THRESHOLDS: EvalThresholds = {
  minScoredCases:           5,
  maxGateFailureRate:       0.25,
  maxJudgeInconclusiveRate: 0.25,
};

type ScoredRecord = RunRecord<JudgeResult, SkillJudgeJudgment> & {
  gate:  { status: 'ok'; output: JudgeResult };
  judge: { status: 'ok'; judgment: SkillJudgeJudgment };
};

export function scoreSkillJudge(
  records: RunRecord<JudgeResult, SkillJudgeJudgment>[],
): SkillJudgeMetrics {
  const base = coreMetrics(records);

  const failOpenObserved = records.filter((r) => {
    if (r.gate.status !== 'failed') return false;
    return r.gate.detail === 'fail-open';
  }).length;

  const scored = records.filter(
    (r): r is ScoredRecord => r.gate.status === 'ok' && r.judge.status === 'ok',
  );

  if (scored.length === 0) {
    return {
      ...base,
      decisionAccuracy:     0,
      bandAgreement:        0,
      independentAgreement: 0,
      failOpenObserved,
    };
  }

  let decisionCorrect = 0;
  let bandInRange = 0;
  let independentMatch = 0;

  for (const r of scored) {
    const j = r.judge.judgment;
    if (j.decision_correct) decisionCorrect++;
    if (j.band_in_range) bandInRange++;
    if (j.independent_verdict === r.gate.output.verdict) independentMatch++;
  }

  const n = scored.length;
  return {
    ...base,
    decisionAccuracy:     decisionCorrect / n,
    bandAgreement:        bandInRange / n,
    independentAgreement: independentMatch / n,
    failOpenObserved,
  };
}

export function skillJudgeVerdict(m: SkillJudgeMetrics): 'proceed' | 'do-not-proceed' {
  if (m.scoredCases < SKILL_JUDGE_THRESHOLDS.minScoredCases) return 'do-not-proceed';
  if (m.gateFailureRate > SKILL_JUDGE_THRESHOLDS.maxGateFailureRate) return 'do-not-proceed';
  if (m.judgeInconclusiveRate > SKILL_JUDGE_THRESHOLDS.maxJudgeInconclusiveRate) return 'do-not-proceed';
  return 'proceed';
}
