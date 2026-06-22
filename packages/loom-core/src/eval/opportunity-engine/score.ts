import { coreMetrics } from '../framework/coreMetrics.js';
import type { RunRecord, CoreMetrics, EvalThresholds } from '../framework/types.js';
import type { OpportunityRecord } from '../../signals/OpportunityEngine.js';
import type { OpportunityEngineJudgment } from './judgeTypes.js';

export interface OpportunityEngineMetrics extends CoreMetrics {
  coherence: number;             // mean over scored cases
  scoreReasonableness: number;   // mean over scored cases
  grounding: number;             // mean over scored cases
  forcedClusteringRate: number;  // Σ forced_clusters / Σ cluster_count
  hallucinationRate: number;     // Σ (invented_opportunities + nonexistent_signal_ids) / Σ cluster_count
}

export const OPPORTUNITY_ENGINE_THRESHOLDS: EvalThresholds = {
  minScoredCases: 3,
  maxGateFailureRate: 0.25,
  maxJudgeInconclusiveRate: 0.25,
};

export interface QualityBar {
  minCoherence: number;
  minScoreReasonableness: number;
  minGrounding: number;
  maxForcedClusteringRate: number;
  maxHallucinationRate: number;
}

export const DEFAULT_QUALITY_BAR: QualityBar = {
  minCoherence: 0.80,
  minScoreReasonableness: 0.70,
  minGrounding: 0.90,
  maxForcedClusteringRate: 0.20,
  maxHallucinationRate: 0.10,
};

export function resolveQualityBar(opts?: Partial<QualityBar>): QualityBar {
  function envFloat(key: string): number | undefined {
    const v = process.env[key];
    if (v === undefined || v === '') return undefined;
    const n = parseFloat(v);
    return isNaN(n) ? undefined : n;
  }

  return {
    minCoherence:
      opts?.minCoherence ??
      envFloat('LOOM_EVAL_OPP_MIN_COHERENCE') ??
      DEFAULT_QUALITY_BAR.minCoherence,
    minScoreReasonableness:
      opts?.minScoreReasonableness ??
      envFloat('LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS') ??
      DEFAULT_QUALITY_BAR.minScoreReasonableness,
    minGrounding:
      opts?.minGrounding ??
      envFloat('LOOM_EVAL_OPP_MIN_GROUNDING') ??
      DEFAULT_QUALITY_BAR.minGrounding,
    maxForcedClusteringRate:
      opts?.maxForcedClusteringRate ??
      envFloat('LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE') ??
      DEFAULT_QUALITY_BAR.maxForcedClusteringRate,
    maxHallucinationRate:
      opts?.maxHallucinationRate ??
      envFloat('LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE') ??
      DEFAULT_QUALITY_BAR.maxHallucinationRate,
  };
}

type ScoredRecord = RunRecord<OpportunityRecord[], OpportunityEngineJudgment> & {
  gate: { status: 'ok'; output: OpportunityRecord[] };
  judge: { status: 'ok'; judgment: OpportunityEngineJudgment };
};

export function scoreOpportunityEngine(
  records: RunRecord<OpportunityRecord[], OpportunityEngineJudgment>[],
): OpportunityEngineMetrics {
  const base = coreMetrics(records);

  const scored = records.filter(
    (r): r is ScoredRecord => r.gate.status === 'ok' && r.judge.status === 'ok',
  );

  if (scored.length === 0) {
    return {
      ...base,
      coherence: 0,
      scoreReasonableness: 0,
      grounding: 0,
      forcedClusteringRate: 0,
      hallucinationRate: 0,
    };
  }

  let sumCoherence = 0;
  let sumScoreReasonableness = 0;
  let sumGrounding = 0;
  let sumForcedClusters = 0;
  let sumInventedOpportunities = 0;
  let sumNonexistentSignalIds = 0;
  let sumClusterCount = 0;

  for (const r of scored) {
    const j = r.judge.judgment;
    sumCoherence += j.coherence;
    sumScoreReasonableness += j.score_reasonableness;
    sumGrounding += j.grounding;
    sumForcedClusters += j.forced_clusters;
    sumInventedOpportunities += j.invented_opportunities;
    sumNonexistentSignalIds += j.nonexistent_signal_ids;
    sumClusterCount += j.cluster_count;
  }

  const n = scored.length;

  return {
    ...base,
    coherence: sumCoherence / n,
    scoreReasonableness: sumScoreReasonableness / n,
    grounding: sumGrounding / n,
    forcedClusteringRate: sumClusterCount === 0 ? 0 : sumForcedClusters / sumClusterCount,
    hallucinationRate:
      sumClusterCount === 0
        ? 0
        : (sumInventedOpportunities + sumNonexistentSignalIds) / sumClusterCount,
  };
}

export function opportunityEngineVerdict(m: OpportunityEngineMetrics): 'proceed' | 'do-not-proceed' {
  const bar = resolveQualityBar();
  if (m.coherence < bar.minCoherence) return 'do-not-proceed';
  if (m.scoreReasonableness < bar.minScoreReasonableness) return 'do-not-proceed';
  if (m.grounding < bar.minGrounding) return 'do-not-proceed';
  if (m.forcedClusteringRate > bar.maxForcedClusteringRate) return 'do-not-proceed';
  if (m.hallucinationRate > bar.maxHallucinationRate) return 'do-not-proceed';
  return 'proceed';
}
