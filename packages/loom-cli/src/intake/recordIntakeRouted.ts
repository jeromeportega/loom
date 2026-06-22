import type { AuditLog, IntakeVerdict } from '@loom-ai/core';

export const INTAKE_ROUTED_ACTION = 'intake_routed' as const;

// Leaves any prior intake_classified row untouched; the two action strings separate classifier evidence from routing decision.
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
  audit.record({ action: INTAKE_ROUTED_ACTION, command: epicId, allowed: true, detail });
}
