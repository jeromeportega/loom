import { z } from 'zod';

export const SkillQualityBand = z.enum(['bad', 'borderline', 'good']);
export type SkillQualityBandType = z.infer<typeof SkillQualityBand>;

export const ExistingSkillSchema = z.object({ name: z.string(), description: z.string() });

export const SkillJudgeEvalCaseSchema = z.object({
  id:                z.string(),
  source:            z.enum(['anchor', 'borderline', 'derived']),
  category:          z.enum(['accept', 'reject', 'borderline']),
  skill_md:          z.string().min(1),
  existing_skills:   z.array(ExistingSkillSchema).default([]),
  expected_decision: z.enum(['accept', 'reject']),
  expected_band:     SkillQualityBand,
  failure_mode:      z.enum(['vague', 'not-reusable', 'duplicative', 'unsafe']).optional(),
  rationale:         z.string().min(1),
});

export const SkillJudgeEvalSetSchema = z.object({ cases: z.array(SkillJudgeEvalCaseSchema).min(1) });

export type SkillJudgeEvalCase = z.infer<typeof SkillJudgeEvalCaseSchema>;
