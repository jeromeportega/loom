import { z } from 'zod';

/** LLM-owned fields only — the lesson-extractor SKILL.md instructs the model to return exactly these. */
export const LessonContent = z.object({
  category:     z.string().min(1),
  observation:  z.string().min(1),
  root_cause:   z.string().optional(),
  general_rule: z.string().min(1),
  evidence:     z.string().optional(),
});

/** Full persisted shape — handler-owned fields stamped BEFORE parse (ADR-003). */
export const Lesson = LessonContent.extend({
  epic_id:     z.string().min(1),
  applied_as:  z.enum(['worker_guidance', 'policy_suggestion']).nullable().default(null),
  applied_ref: z.string().nullable().default(null),
  created_at:  z.string().min(1),
});
export type Lesson = z.infer<typeof Lesson>;
export type LessonRow = Lesson & { id: number };
