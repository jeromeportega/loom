import type { WorkerResult } from './WorkerRunner.js';

/**
 * Strict allowlist of killReasons that indicate a no-output stall.
 * 'cap' (wall-clock ceiling) is intentionally excluded — it is NOT a stall.
 */
const STALL_KILL_REASONS = new Set<string>(['stall', 'hung_request']);

export type WorkerExitClass = 'stall' | 'task_error' | 'other';

/**
 * Pure classifier: distinguishes a no-output stall from a real task-error exit.
 *
 * Rules (checked in order):
 *   1. killReason ∈ {'stall','hung_request'} → 'stall'  (auto-recovery candidate)
 *   2. killReason set to anything else (e.g. 'cap','budget') → 'other'
 *      (guard-killed by a non-stall reason; leave on existing paths)
 *   3. status failed + logTail non-empty → 'task_error'
 *      (worker ran, produced output, then exited non-zero — hung-then-errored or slow error)
 *   4. everything else → 'other'
 *      (spawn-infra failure, normal exit, silent non-zero exit)
 *
 * No side effects. Safe to call repeatedly with the same input.
 */
export function classifyWorkerExit(result: WorkerResult): WorkerExitClass {
  if (result.killReason != null && STALL_KILL_REASONS.has(result.killReason)) {
    return 'stall';
  }

  if (result.killReason != null) {
    return 'other';
  }

  if (result.status === 'failed' && result.logTail.length > 0) {
    return 'task_error';
  }

  return 'other';
}
