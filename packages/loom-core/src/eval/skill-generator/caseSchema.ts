import { z } from 'zod';

const WorkContextSchema = z.object({
  story: z.object({
    id:                  z.string().min(1),
    title:               z.string().min(1),
    description:         z.string(),
    acceptance_criteria: z.array(z.string()),
  }),
  summary:         z.string(),
  diff_context:    z.string(),
  existing_skills: z.array(z.object({ name: z.string(), description: z.string() })).default([]),
});

const RubricExpectationSchema = z.object({
  expected_decision: z.enum(['generate', 'none', 'either']),
  expected_themes:   z.array(z.string()).default([]),
  spurious_traps:    z.array(z.string()).default([]),
});

export const SkillGeneratorCaseSchema = z.object({
  id:        z.string().min(1),
  source:    z.enum(['worthy', 'trivial', 'borderline']),
  work:      WorkContextSchema,
  rubric:    RubricExpectationSchema,
  rationale: z.string().min(1),
});

export const SkillGeneratorCaseSetSchema = z.object({
  cases: z.array(SkillGeneratorCaseSchema).min(1),
});

export type SkillGeneratorCase    = z.infer<typeof SkillGeneratorCaseSchema>;
export type SkillGeneratorCaseSet = z.infer<typeof SkillGeneratorCaseSetSchema>;
