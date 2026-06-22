import type { AuditLog, IntakeVerdict } from '@loom-ai/core';

export const INTAKE_ROUTED_ACTION = 'intake_routed' as const;

/**
 * Writes a confirm-mode provenance record to the audit log.
 *
 * Uses the existing free-form `detail` JSON column — no schema change.
 * The `intake_classified` record (written earlier by recordIntakeClassification)
 * is left completely untouched; the two action strings cleanly separate
 * "what the classifier said" from "what was routed to the planner".
 */
export function recordIntakeRouted(
  audit: AuditLog,
  epicId: string,
  detail: {
    mode: 'confirm' | 'confirm-degraded-advisory';
    decision: 'accepted' | 'overridden';
    original: { type: IntakeVerdict['type']; size: IntakeVerdict['size'] };
    routed:   { type: IntakeVerdict['type']; size: IntakeVerdict['size'] };
    confidence: IntakeVerdict['confidence'];
  },
): void {
  audit.record({ action: INTAKE_ROUTED_ACTION, command: epicId, detail });
}
