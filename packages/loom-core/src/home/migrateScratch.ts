import type { MigrationResult } from './repoState.js';

/**
 * Stub — real implementation produced by story-052-003.
 * Returns a no-op result; the seam is wired at epic integration.
 *
 * WARNING: planning artifacts under .loom/planning/ are NOT migrated until
 * story-052-003 ships. Preserve your in-repo .loom/planning/ directory
 * until that story merges.
 */
export function migratePlanningScratch(opts: {
  srcRoot: string;
  dstRoot: string;
}): MigrationResult {
  // Planning-scratch migration is deferred to story-052-003.
  // Emit a warning so operators know their planning history remains at the old location.
  console.warn(
    `[loom] planning-scratch migration deferred (story-052-003): ` +
    `artifacts remain at ${opts.srcRoot} until the next release.`,
  );
  return { migrated: false, from: null, to: opts.dstRoot, method: null };
}
