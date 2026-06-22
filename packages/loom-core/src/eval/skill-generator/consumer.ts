import type {
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
  RunRecord,
} from '../framework/types.js';
import type { SkillGeneratorCase } from './caseSchema.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';
import type { SkillGeneratorMetrics } from './score.js';
import { loadSkillGeneratorCases } from './loadCases.js';
import { runSkillGeneratorGate } from './runGate.js';
import { judgeSkillGeneration } from './judge.js';
import { scoreSkillGenerator, skillGeneratorVerdict, SKILL_GENERATOR_THRESHOLDS } from './score.js';

export function createSkillGeneratorConsumer(opts: { projectRoot: string }):
  GateEvalConsumer<SkillGeneratorCase, SkillGeneratorDecision, SkillGeneratorJudgment, SkillGeneratorMetrics> {
  void opts;
  return {
    loadCases(fixturePath?: string): SkillGeneratorCase[] {
      return loadSkillGeneratorCases(fixturePath);
    },

    async runGate(c: SkillGeneratorCase, deps: GateDeps): Promise<GateOutcome<SkillGeneratorDecision>> {
      return runSkillGeneratorGate(c, deps);
    },

    async judge(
      c: SkillGeneratorCase,
      output: SkillGeneratorDecision,
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<SkillGeneratorJudgment>> {
      return judgeSkillGeneration(c, output, deps);
    },

    score(records: RunRecord<SkillGeneratorDecision, SkillGeneratorJudgment>[]): SkillGeneratorMetrics {
      return scoreSkillGenerator(records);
    },

    verdict: skillGeneratorVerdict,

    thresholds: SKILL_GENERATOR_THRESHOLDS,
  };
}
