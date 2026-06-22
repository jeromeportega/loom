import type {
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  GateDeps,
  JudgeDeps,
  RunRecord,
} from '../framework/types.js';
import type { JudgeResult } from '../../skills/SkillJudge.js';
import type { SkillJudgeEvalCase } from './caseSchema.js';
import type { SkillJudgeJudgment } from './judgeTypes.js';
import type { SkillJudgeMetrics } from './score.js';
import { loadSkillJudgeCases } from './loadCases.js';
import { runSkillJudgeGate } from './runGate.js';
import { judgeSkillAdmissibility } from './judge.js';
import { scoreSkillJudge, skillJudgeVerdict, SKILL_JUDGE_THRESHOLDS } from './score.js';

export function createSkillJudgeConsumer(
  _opts?: { projectRoot?: string },
): GateEvalConsumer<SkillJudgeEvalCase, JudgeResult, SkillJudgeJudgment, SkillJudgeMetrics> {
  return {
    loadCases(fixturePath?: string): SkillJudgeEvalCase[] {
      return loadSkillJudgeCases(fixturePath);
    },

    async runGate(c: SkillJudgeEvalCase, deps: GateDeps): Promise<GateOutcome<JudgeResult>> {
      return runSkillJudgeGate(c, deps);
    },

    async judge(
      c: SkillJudgeEvalCase,
      output: JudgeResult,
      deps: JudgeDeps,
    ): Promise<JudgeOutcome<SkillJudgeJudgment>> {
      return judgeSkillAdmissibility(c, output, deps);
    },

    score(records: RunRecord<JudgeResult, SkillJudgeJudgment>[]): SkillJudgeMetrics {
      return scoreSkillJudge(records);
    },

    verdict: skillJudgeVerdict,

    thresholds: SKILL_JUDGE_THRESHOLDS,
  };
}
