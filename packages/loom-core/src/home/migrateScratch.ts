import fs from 'node:fs';
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
  // Only warn when planning artifacts actually exist at the old location so
  // repos that never ran the planner don't see a spurious warning on every run.
  if (fs.existsSync(opts.srcRoot)) {
    console.warn(
      `[loom] planning-scratch migration deferred (story-052-003): ` +
      `artifacts remain at ${opts.srcRoot} until the next release.`,
    );
  }
  return { migrated: false, from: null, to: opts.dstRoot, method: null };
}
