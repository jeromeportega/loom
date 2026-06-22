import type { JudgeOutcome, JudgeDeps } from '../framework/types.js';
import type { SkillGeneratorCase } from './caseSchema.js';
import type { SkillGeneratorDecision, SkillGeneratorJudgment } from './judgeTypes.js';

// Body filled by story-043-003.
// decision==='none'      → { status: 'skipped' }
// decision==='generate'  → LLM scores 4 numeric dims; parse error → 'inconclusive'
// prompt id: 'skill-generator-judge'
export async function judgeSkillGeneration(
  c: SkillGeneratorCase,
  output: SkillGeneratorDecision,
  deps: JudgeDeps,
): Promise<JudgeOutcome<SkillGeneratorJudgment>> {
  void c; void output; void deps;
  throw new Error('judgeSkillGeneration: not implemented (story-043-003)');
}
