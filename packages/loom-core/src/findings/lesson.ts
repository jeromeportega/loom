import { z } from 'zod';

/**
 * Output of the lesson-extractor skill (story-006). PROVISIONAL per ADR-001:
 * the field set may tighten when the lesson store lands, but the `kind` axis
 * (worked-well / did-not-work / surprise) is stable.
 */
export const Lesson = z.object({
  kind: z.enum(['worked-well', 'did-not-work', 'surprise']),
  summary: z.string().min(1),
  context: z.string().min(1),
  recommended_action: z.string().optional(),
});
export type Lesson = z.infer<typeof Lesson>;
