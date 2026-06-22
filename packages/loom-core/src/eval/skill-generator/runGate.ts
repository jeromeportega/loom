import type { GateOutcome, GateDeps } from '../framework/types.js';
import type { SkillGeneratorCase } from './caseSchema.js';
import type { SkillGeneratorDecision } from './judgeTypes.js';

// Body filled by story-043-004. See contract marshaling spec for DB/SkillStore wiring.
export async function runSkillGeneratorGate(
  c: SkillGeneratorCase,
  deps: GateDeps,
): Promise<GateOutcome<SkillGeneratorDecision>> {
  void c; void deps;
  throw new Error('runSkillGeneratorGate: not implemented (story-043-004)');
}
