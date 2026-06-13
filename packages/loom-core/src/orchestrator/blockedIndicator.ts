import type { EpicRecord } from '../types.js';

export interface BlockedSignal {
  blocked: true;
  blocked_reason: 'integration_gate';
}

/** The ONLY rule. Returns null for every other epic state — normal in_progress,
 *  finalizing, planning, done, failed, rejected. Reads two fields, writes nothing. */
export function deriveBlocked(
  epic: Pick<EpicRecord, 'status' | 'finalize_phase'>
): BlockedSignal | null {
  return epic.status === 'in_progress' && epic.finalize_phase === 'gate'
    ? { blocked: true, blocked_reason: 'integration_gate' }
    : null;
}
