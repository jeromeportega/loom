import type {
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
  RunRecord,
} from '../framework/types.js';
import type { OpportunityRecord } from '../../signals/OpportunityEngine.js';
import type { OpportunityEngineCase } from './caseSchema.js';
import type { OpportunityEngineJudgment } from './judgeTypes.js';
import type { OpportunityEngineMetrics } from './score.js';
import { loadOpportunityEngineCases } from './loadCases.js';
import { runOpportunityEngineGate } from './runGate.js';
import { judgeOpportunityClusters } from './judge.js';
import { scoreOpportunityEngine, opportunityEngineVerdict, OPPORTUNITY_ENGINE_THRESHOLDS } from './score.js';

export function createOpportunityEngineConsumer(_opts: { projectRoot: string }):
  GateEvalConsumer<OpportunityEngineCase, OpportunityRecord[], OpportunityEngineJudgment, OpportunityEngineMetrics> {
  return {
    loadCases(fixturePath?: string): OpportunityEngineCase[] {
      return loadOpportunityEngineCases(fixturePath);
    },

    async runGate(c: OpportunityEngineCase, deps: GateDeps): Promise<GateOutcome<OpportunityRecord[]>> {
      return runOpportunityEngineGate(c, deps);
    },

    async judge(
      c: OpportunityEngineCase,
      output: OpportunityRecord[],
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<OpportunityEngineJudgment>> {
      return judgeOpportunityClusters(c, output, deps);
    },

    score(records: RunRecord<OpportunityRecord[], OpportunityEngineJudgment>[]): OpportunityEngineMetrics {
      return scoreOpportunityEngine(records);
    },

    verdict: opportunityEngineVerdict,

    thresholds: OPPORTUNITY_ENGINE_THRESHOLDS,
  };
}
