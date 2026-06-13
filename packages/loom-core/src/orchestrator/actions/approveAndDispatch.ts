import type { EpicStore } from '../../state/EpicStore.js';
import type { AuditLog } from '../../state/AuditLog.js';
import type { Policy } from '../../types.js';

/**
 * The single approve path — used by both human approvals (web/MCP) and
 * full-auto self-approval. Captures the policy snapshot, transitions
 * planned→approved, and writes the epic_approved audit row. The actor field
 * distinguishes who triggered the approval.
 *
 * Callers are responsible for firing dispatch (supervisor.run([epicId])) after
 * this returns; this function only handles the durable state transitions.
 */
export async function approveAndDispatch(
  deps: { epicStore: EpicStore; auditLog: AuditLog; policy: Policy },
  epicId: string,
  opts: { actor: 'human' | 'full-auto' }
): Promise<{ status: 'dispatching' }> {
  try {
    deps.epicStore.setPolicySnapshot(epicId, JSON.stringify(deps.policy));
  } catch {
    // Snapshot persistence is observability — never block approve on it.
  }
  deps.epicStore.updateStatus(epicId, 'approved');
  deps.auditLog.record({
    action: 'epic_approved',
    command: epicId,
    detail: { actor: opts.actor },
  });
  return { status: 'dispatching' };
}
