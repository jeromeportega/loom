import type { SliceBounds } from './types.js';
import {
  CROSS_REPO_MAX_LINE_WINDOW,
  CROSS_REPO_MAX_FILE_BYTES,
  CROSS_REPO_MAX_FILES,
  CROSS_REPO_MAX_MATCHES_PER_FILE,
} from '../orchestrator/constants.js';

/**
 * Returns the baked SliceBounds constants.
 * Called once per retrieval operation — the returned object is the single source
 * of limits consumed by RepoReader (story-057-002) and RepoSearcher (story-057-003).
 */
export function loadSliceBounds(): SliceBounds {
  return {
    maxLineWindow: CROSS_REPO_MAX_LINE_WINDOW,
    maxFileBytes: CROSS_REPO_MAX_FILE_BYTES,
    maxFiles: CROSS_REPO_MAX_FILES,
    maxMatchesPerFile: CROSS_REPO_MAX_MATCHES_PER_FILE,
  };
}
