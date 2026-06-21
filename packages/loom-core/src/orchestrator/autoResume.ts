import type { WorkerResult } from './WorkerRunner.js';

/**
 * Pure predicate: returns true iff the Supervisor should auto-resume a story
 * that was killed by the timeout guard.
 *
 * All three conditions must hold:
 *   - kill reason is stall or hung_request (not cap, budget, or normal exit)
 *   - a checkpoint commit exists (resuming without one would lose in-flight edits)
 *   - attempts so far are strictly less than the cap (0 cap = disabled)
 */
export function shouldAutoResume(
  result: WorkerResult,
  attemptsSoFar: number,
  cap: number,
): boolean {
  return (
    (result.killReason === 'stall' || result.killReason === 'hung_request') &&
    result.checkpointCommitted === true &&
    attemptsSoFar < cap
  );
}
