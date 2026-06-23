import type { MigrationResult } from './repoState.js';

/**
 * Stub — real implementation produced by story-052-003.
 * Returns a no-op result; the seam is wired at epic integration.
 */
export function migratePlanningScratch(opts: {
  srcRoot: string;
  dstRoot: string;
}): MigrationResult {
  return { migrated: false, from: null, to: opts.dstRoot, method: null };
}
