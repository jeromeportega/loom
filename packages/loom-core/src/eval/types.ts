import { z } from 'zod';

/** Graded expectations for a planning eval case. All bounds are optional. */
export const PlanningExpectationSchema = z.object({
  minEpics: z.number().int().min(1).optional(),
  maxEpics: z.number().int().min(1).optional(),
  minStories: z.number().int().min(1).optional(),
  maxStories: z.number().int().min(1).optional(),
  /** When true, the produced epics must pass validateEpicSet (dependency soundness). */
  dependenciesValid: z.boolean().optional(),
});
export type PlanningExpectation = z.infer<typeof PlanningExpectationSchema>;

/** One planning eval case: a brief plus what a good plan for it looks like. */
export const EvalCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  brief: z.string().min(10),
  expect: PlanningExpectationSchema,
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export const EvalSuiteSchema = z.object({
  cases: z.array(EvalCaseSchema).min(1),
});

export interface EvalCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalCaseResult {
  caseId: string;
  /** True only if every check passed and the planner did not error. */
  passed: boolean;
  error?: string;
  checks: EvalCheck[];
}

export interface EvalReport {
  suite: string;
  total: number;
  passed: number;
  /** passed / total, in [0, 1]. */
  score: number;
  cases: EvalCaseResult[];
}
