import { coreMetrics } from '../framework/coreMetrics.js';
import type { RunRecord } from '../framework/types.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { BriefQualityJudgment, BriefQualityMetrics } from './judgeTypes.js';

type ScoredRecord = RunRecord<BriefRefinement, BriefQualityJudgment> & {
  gate:  { status: 'ok'; output: BriefRefinement };
  judge: { status: 'ok'; judgment: BriefQualityJudgment };
};

export function scoreBriefQuality(
  records: RunRecord<BriefRefinement, BriefQualityJudgment>[],
): BriefQualityMetrics {
  const base = coreMetrics(records);

  const scored = records.filter(
    (r): r is ScoredRecord => r.gate.status === 'ok' && r.judge.status === 'ok',
  );

  if (scored.length === 0) {
    return { ...base, readinessAccuracy: 0, qualityBandAgreement: 0, critiqueQuality: 0 };
  }

  let readinessCorrect = 0;
  let qualityInBand = 0;
  let faithful = 0;
  let partial = 0;

  for (const r of scored) {
    const j = r.judge.judgment;
    if (j.readiness_correct) readinessCorrect++;
    if (j.quality_in_band) qualityInBand++;
    if (j.critique_fidelity === 'faithful') faithful++;
    else if (j.critique_fidelity === 'partial') partial++;
  }

  const n = scored.length;
  return {
    ...base,
    readinessAccuracy:    readinessCorrect / n,
    qualityBandAgreement: qualityInBand / n,
    critiqueQuality:      (faithful + 0.5 * partial) / n,
  };
}
