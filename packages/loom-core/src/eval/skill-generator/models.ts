import { DEFAULT_JUDGE_MODEL } from '../framework/models.js';

export const DEFAULT_GATE_MODEL = 'claude-haiku-4-5-20251001';
export { DEFAULT_JUDGE_MODEL };

/**
 * Resolves gate and judge models for the skill-generator eval.
 * Precedence: opts.* > LOOM_EVAL_{GATE,JUDGE}_MODEL env > safe defaults (ADR-005).
 */
export function resolveSkillGeneratorModels(
  opts?: { gateModel?: string; judgeModel?: string },
): { gateModel: string; judgeModel: string } {
  const gateModel  = opts?.gateModel  ?? process.env.LOOM_EVAL_GATE_MODEL  ?? DEFAULT_GATE_MODEL;
  const judgeModel = opts?.judgeModel ?? process.env.LOOM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  return { gateModel, judgeModel };
}
