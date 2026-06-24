// Re-exported from epic-054 so downstream stories import from one place without re-declaring.
export type { ManifestEntry, WorkspaceManifest } from '../home/workspaceManifest.js';

/** A registered repo whose on-disk root is verified present AND identity-matched. */
export interface ResolvedRepo {
  slug: string;
  root: string;               // fs.realpathSync(entry.path), confirmed dir, slug re-derives
}

/** Conservative defaults; every field overridable via policy.cross_repo.bounds. */
export interface SliceBounds {
  maxLineWindow: number;      // default 200
  maxFileBytes: number;       // default 262144 (256 KiB)
  maxFiles: number;           // default 20
  maxMatchesPerFile: number;  // default 10
}

export type RetrievalRequest =
  | { kind: 'read';   slug: string; path: string; lines?: [number, number]; }
  | { kind: 'search'; slug: string; query: string; pathGlob?: string; };

export interface RetrievalMatch { path: string; line: number; excerpt: string; }
export interface SearchResult { slug: string; matches: RetrievalMatch[]; truncated: boolean; }
export interface ReadResult   { slug: string; path: string; content: string;
                                window: [number, number]; truncated: boolean; }

/** Thrown for EVERY refusal; carries the guard-style rule/reason for the audit log. */
export class RetrievalRefused extends Error {
  constructor(readonly rule: string, readonly reason: string) {
    super(`[${rule}] ${reason}`);
    this.name = 'RetrievalRefused';
  }
}

/** Canonical audit rule strings — resolver, guard, reader, searcher, service ALL use these. */
export const CROSS_REPO_RULES = {
  UNREGISTERED:     'cross_repo.unregistered',      // slug not in manifest
  STALE_PATH:       'cross_repo.stale_path',        // path moved/deleted/slug mismatch (FR-8)
  USE_RETRIEVAL:    'cross_repo.use_retrieval',     // raw read into a sibling root denied
  OUT_OF_WORKSPACE: 'cross_repo.out_of_workspace',  // path outside [worktree ∪ workspace roots]
  READ_ONLY:        'cross_repo.read_only',         // write outside own worktree denied
  FILE_TOO_LARGE:   'cross_repo.file_too_large',    // exceeds maxFileBytes
  TOO_MANY_FILES:   'cross_repo.too_many_files',    // exceeds maxFiles
  SECRET_EXCLUDED:  'cross_repo.secret_excluded',   // path matched a secret glob
} as const;
