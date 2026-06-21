import type { Policy } from '../../types.js';
import { modelFor } from '../../llm/factory.js';

export const DEFAULT_JUDGE_MODEL = 'claude-opus-4-8';

export function resolveEvalModels(policy: Policy): { gateModel: string; judgeModel: string } {
  const gateModel = process.env.LOOM_EVAL_GATE_MODEL ?? modelFor(policy, 'planning');
  const judgeModel = process.env.LOOM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  return { gateModel, judgeModel };
}
