import { z } from 'zod';

/**
 * Output of the failure-investigator skill (story-004). The grade drives the
 * failure router: a `strong` grade carries an actionable retry hint, so the
 * schema requires `hint` to be present and non-empty iff the grade is strong.
 */
export const EvidenceGrade = z.enum(['strong', 'weak', 'contradictory']);
export type EvidenceGrade = z.infer<typeof EvidenceGrade>;

export const Investigation = z
  .object({
    grade: EvidenceGrade,
    hypothesis: z.string().min(1),
    hint: z.string().optional(), // REQUIRED iff grade === "strong"
    evidence_refs: z.array(z.string()),
  })
  .refine((v) => v.grade !== 'strong' || (v.hint !== undefined && v.hint.length > 0), {
    message: 'strong grade requires a non-empty hint',
  });
export type Investigation = z.infer<typeof Investigation>;
