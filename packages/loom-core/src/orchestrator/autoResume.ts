import type { WorkerResult } from './WorkerRunner.js';

/**
 * Canonical allowlist of killReasons that indicate a no-output stall.
 * 'cap' (wall-clock ceiling) and 'budget' are intentionally excluded.
 * Import from here rather than re-declaring to keep a single source of truth.
 */
export const STALL_KILL_REASONS: ReadonlySet<string> = new Set([
  'stall',
  'hung_request',
]);

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
    STALL_KILL_REASONS.has(result.killReason ?? '') &&
    result.checkpointCommitted === true &&
    attemptsSoFar < cap
  );
}
