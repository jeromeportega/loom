import type { Policy } from '../types.js';
import type { SliceBounds } from './types.js';

const DEFAULTS: SliceBounds = {
  maxLineWindow: 200,
  maxFileBytes: 262144,
  maxFiles: 20,
  maxMatchesPerFile: 10,
};

/**
 * Derive SliceBounds from the effective policy, applying conservative defaults.
 * Called once per retrieval operation — the returned object is the single source
 * of limits consumed by RepoReader (story-057-002) and RepoSearcher (story-057-003).
 */
export function loadSliceBounds(policy: Policy): SliceBounds {
  const b = policy.cross_repo.bounds;
  return {
    maxLineWindow: b.max_line_window ?? DEFAULTS.maxLineWindow,
    maxFileBytes: b.max_file_bytes ?? DEFAULTS.maxFileBytes,
    maxFiles: b.max_files ?? DEFAULTS.maxFiles,
    maxMatchesPerFile: b.max_matches_per_file ?? DEFAULTS.maxMatchesPerFile,
  };
}
