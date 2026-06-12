import { z } from 'zod';

/**
 * The shared findings contract for Review Forge (epic-001, ADR-001). Every
 * reviewer in the epic — adversarial-review, edge-case-hunter, and the
 * code-review adapter — emits `Finding[]` shaped exactly like this. The field
 * set is frozen on purpose: adding a sixth field forces a coordinated change
 * across every reviewer and the orchestrator dedupe, so it must land here first.
 */
export const SeverityEnum = z.enum(['blocker', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeverityEnum>;

export const FindingLocation = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
});
export type FindingLocation = z.infer<typeof FindingLocation>;

export const Finding = z.object({
  severity: SeverityEnum,
  category: z.string().min(1),
  location: FindingLocation,
  description: z.string().min(1),
  suggested_fix: z.string().optional(),
  // Exact reviewer-name string — see findings/sources.ts. The orchestrator
  // dedupe and per-reviewer status keying compare against these literals.
  source: z.string().min(1),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewerOutput = z.object({ findings: z.array(Finding) });
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;
