import type { WorkerResult } from './WorkerRunner.js';
import { STALL_KILL_REASONS } from './autoResume.js';

export type WorkerExitClass = 'stall' | 'task_error' | 'other';

// Compile-time guard: tsc will error if WorkerExitClass gains a new variant
// without this record being updated.
const _exhaustive: Record<WorkerExitClass, true> = {
  stall: true,
  task_error: true,
  other: true,
};
void _exhaustive;

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

  if (result.status === 'failed' && (result.logTail ?? '').length > 0) {
    return 'task_error';
  }

  return 'other';
}
