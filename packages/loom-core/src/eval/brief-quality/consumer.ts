import type {
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
  RunRecord,
  EvalThresholds,
} from '../framework/types.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { BriefQualityCase } from './caseSchema.js';
import type { BriefQualityJudgment, BriefQualityMetrics } from './judgeTypes.js';
import { loadBriefQualityCases } from './loadCases.js';
import { runBriefQualityGate } from './runGate.js';
import { judgeBriefQuality } from './judge.js';
import { scoreBriefQuality } from './score.js';

const BRIEF_QUALITY_THRESHOLDS: EvalThresholds = {
  minScoredCases: 5,
  maxGateFailureRate: 0.25,
  maxJudgeInconclusiveRate: 0.25,
};

function briefQualityVerdict(metrics: BriefQualityMetrics): 'proceed' | 'do-not-proceed' {
  if (metrics.readinessAccuracy < 0.8) return 'do-not-proceed';
  if (metrics.qualityBandAgreement < 0.7) return 'do-not-proceed';
  if (metrics.critiqueQuality < 0.6) return 'do-not-proceed';
  return 'proceed';
}

export function createBriefQualityConsumer(opts: { projectRoot: string }): GateEvalConsumer<
  BriefQualityCase,
  BriefRefinement,
  BriefQualityJudgment,
  BriefQualityMetrics
> {
  return {
    loadCases(fixturePath?: string): BriefQualityCase[] {
      return loadBriefQualityCases(fixturePath);
    },

    async runGate(c: BriefQualityCase, deps: GateDeps): Promise<GateOutcome<BriefRefinement>> {
      return runBriefQualityGate(c, deps, opts.projectRoot);
    },

    async judge(
      c: BriefQualityCase,
      output: BriefRefinement,
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<BriefQualityJudgment>> {
      return judgeBriefQuality(c, output, deps);
    },

    score(records: RunRecord<BriefRefinement, BriefQualityJudgment>[]): BriefQualityMetrics {
      return scoreBriefQuality(records);
    },

    verdict: briefQualityVerdict,

    thresholds: BRIEF_QUALITY_THRESHOLDS,
  };
}
