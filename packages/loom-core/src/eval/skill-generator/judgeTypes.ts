export interface SkillGeneratorDecision {
  decision: 'generate' | 'none';
  skillMd:  string | null;   // raw SKILL.md body when 'generate', else null
}

export interface SkillGeneratorJudgment {
  well_formed:           number;   // 0..1
  reusable:              number;   // 0..1
  faithfulness:          number;   // 0..1
  scope_appropriateness: number;   // 0..1
  spurious:              boolean;  // advisory
  low_quality:           boolean;  // advisory
  reason:                string;
}
