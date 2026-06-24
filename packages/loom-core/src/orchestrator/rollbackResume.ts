import type { RepoMergeRecord } from './landingTypes.js';

/**
 * Returns the repo slugs that are already fully reverted.
 * These are reported in RollbackResult.skipped — no revert-of-a-revert (FR-6).
 *
 * Only records that had a mergeCommitSha (i.e. were actually merged by loom)
 * are counted — pending rows that were never merged are excluded.
 */
export function collectSkipped(records: RepoMergeRecord[]): string[] {
  return records
    .filter(r => r.mergeState === 'reverted' && r.mergeCommitSha !== null)
    .map(r => r.repoSlug);
}

/**
 * Returns true when all loom-merged records for an attempt are fully reverted
 * (every row with a mergeCommitSha is at mergeState='reverted').
 *
 * Distinct from the noop case (no merges at all): converged() requires at
 * least one merged record so a blank attempt is never mistaken for completion.
 */
export function hasConverged(allMerges: RepoMergeRecord[]): boolean {
  const withAnchor = allMerges.filter(r => r.mergeCommitSha !== null);
  return withAnchor.length > 0 && withAnchor.every(r => r.mergeState === 'reverted');
}
