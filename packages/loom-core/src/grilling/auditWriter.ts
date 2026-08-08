import type { AuditLog } from '../state/AuditLog.js';

/**
 * Appends a `grilling_session` row to the existing `audit_log` table (no new
 * table or column). Called for BOTH 'completed' and 'cancelled' outcomes so the
 * grilling token premium is always measurable. `high_blast_unresolved` is
 * included only when provided (a cap-hit cancellation).
 *
 * Note: `AuditLog.record` takes `detail` as an object and JSON-stringifies it
 * internally — do NOT pre-stringify (the shared-contract example was inaccurate).
 */
export function writeGrillingAuditRow(
  audit: AuditLog,
  runId: string,
  tokenCost: number,
  outcome: 'completed' | 'cancelled',
  resolvedCount: number,
  highBlastUnresolved?: number,
): void {
  const detail: Record<string, unknown> = {
    run_id: runId,
    outcome,
    grilling_token_cost: tokenCost,
    resolved_count: resolvedCount,
  };
  if (highBlastUnresolved !== undefined) {
    detail.high_blast_unresolved = highBlastUnresolved;
  }
  audit.record({ action: 'grilling_session', detail });
}
