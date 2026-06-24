import type { AuditLog } from '../state/AuditLog.js';
import type { WorkerResult } from './WorkerRunner.js';
import type { TimeoutKillReason } from './WorkerTimeoutGuard.js';

export const STALL_KILL_ACTION = 'worker_stall_kill';
export const WORKER_AUTO_RECOVERY_ACTION = 'worker_auto_recovery';

export type SilenceKind = 'hung_request_no_response' | 'fully_silent_subprocess';

export interface StallKillDetail {
  kill_reason: TimeoutKillReason;
  silence_kind: SilenceKind;
  last_stream_event: string;
  resume_attempt: number;
  checkpoint_committed: boolean;
}

/**
 * Records a `worker_stall_kill` audit row for a timeout-guard kill event.
 *
 * Mapping (per ADR-7 / epic-032 contract):
 *   action  = STALL_KILL_ACTION
 *   command = storyId          (so getByStory finds kills across retries)
 *   agent_id= agentId
 *   detail  = StallKillDetail  (JSON)
 *
 * silence_kind derivation rule (from the guard's existing sentinel):
 *   'hung_request' → 'hung_request_no_response'
 *   everything else → 'fully_silent_subprocess'
 */
export function recordStallKill(
  audit: AuditLog,
  input: {
    agentId: string;
    storyId: string;
    result: WorkerResult;
    resumeAttempt: number;
  }
): void {
  const { agentId, storyId, result, resumeAttempt } = input;
  const detail: StallKillDetail = {
    kill_reason: result.killReason!,
    silence_kind:
      result.killReason === 'hung_request'
        ? 'hung_request_no_response'
        : 'fully_silent_subprocess',
    last_stream_event: result.lastStreamEvent ?? '(none)',
    resume_attempt: resumeAttempt,
    checkpoint_committed: result.checkpointCommitted === true,
  };
  audit.record({
    agent_id: agentId,
    action: STALL_KILL_ACTION,
    command: storyId,
    allowed: false,
    detail: detail as unknown as Record<string, unknown>,
  });
}

export interface AutoRecoveryDetail {
  recovery_attempt: number;
  budget: number;
  kill_reason: 'stall' | 'hung_request';
  reset_stories: string[];
}

/**
 * Records a `worker_auto_recovery` audit row when the supervisor auto-retries
 * a stalled story via a clean-retry (fresh worktree + branch, never resume).
 *
 * Mapping:
 *   action  = WORKER_AUTO_RECOVERY_ACTION
 *   command = storyId (so getByStory finds recoveries across retries)
 *   agent_id= agentId of the stalled agent
 *   detail  = AutoRecoveryDetail (JSON)
 *
 * Must be called BEFORE task.status is set to 'pending' (audit-first invariant).
 */
export function recordAutoRecovery(
  audit: AuditLog,
  input: { agentId: string; storyId: string; detail: AutoRecoveryDetail }
): void {
  const { agentId, storyId, detail } = input;
  audit.record({
    agent_id: agentId,
    action: WORKER_AUTO_RECOVERY_ACTION,
    command: storyId,
    allowed: true,
    detail: detail as unknown as Record<string, unknown>,
  });
}
