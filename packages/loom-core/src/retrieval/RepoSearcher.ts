import { execFileSync } from 'node:child_process';
import { isSecretPath } from './secretFilter.js';
import type { ResolvedRepo, SliceBounds, SearchResult, RetrievalMatch } from './types.js';

/**
 * Grep-style search over a single manifest-registered repository.
 *
 * Shells out to `git grep` via execFileSync (argv array, no shell) so:
 *  - `query` is always a literal pattern — never string-interpolated (ADR-005 / T7).
 *  - `cwd: repo.root` confines the search; git cannot cross sibling repo boundaries.
 *
 * Bounds come from the same SliceBounds as RepoReader (story-057-002) — maxFiles
 * caps the number of distinct matched files, maxMatchesPerFile caps per-file hits.
 * `truncated: true` is set whenever either cap is hit.
 *
 * Secret paths (matched by secretGlobs via minimatch) are silently excluded from results.
 *
 * ADR-005 trade-off: `git grep` sees only tracked files.  Untracked files (including
 * accidentally-dropped secrets not yet committed) are invisible to search.
 */
export function searchBounded(
  repo: ResolvedRepo,
  query: string,
  pathGlob: string | undefined,
  bounds: SliceBounds,
  secretGlobs: string[],
): SearchResult {
  // Build argv: -e passes query as a literal pattern (safe even when query starts with '-').
  const args = ['grep', '--line-number', '-e', query];
  if (pathGlob !== undefined) {
    // '--' separates the pattern from pathspecs so git doesn't confuse them with revisions.
    args.push('--', pathGlob);
  }

  let rawOutput: string;
  try {
    rawOutput = execFileSync('git', args, {
      cwd: repo.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    if (e.status === 1) {
      // git grep exits 1 when the pattern matches nothing — not an error.
      return { slug: repo.slug, matches: [], truncated: false };
    }
    // Exit code 2 or other = real git error.
    throw new Error(
      `git grep failed in repo "${repo.slug}": ${e.stderr ?? e.stdout ?? String(err)}`,
    );
  }

  // Parse output: each line is "filepath:lineno:matched-content"
  // Split on the first two colons so file paths with embedded colons survive on exotic FSes.
  const byFile = new Map<string, Array<{ line: number; excerpt: string }>>();
  for (const rawLine of rawOutput.split('\n')) {
    if (rawLine.length === 0) continue;
    const c1 = rawLine.indexOf(':');
    if (c1 === -1) continue;
    const c2 = rawLine.indexOf(':', c1 + 1);
    if (c2 === -1) continue;

    const filePath = rawLine.slice(0, c1);
    const lineNo = parseInt(rawLine.slice(c1 + 1, c2), 10);
    const excerpt = rawLine.slice(c2 + 1);

    if (isNaN(lineNo)) continue;

    let entry = byFile.get(filePath);
    if (!entry) {
      entry = [];
      byFile.set(filePath, entry);
    }
    entry.push({ line: lineNo, excerpt });
  }

  const matches: RetrievalMatch[] = [];
  let truncated = false;
  let fileCount = 0;

  for (const [filePath, fileMatches] of byFile) {
    // Exclude paths that match any secret glob.
    if (isSecretPath(filePath, secretGlobs)) continue;

    // Enforce maxFiles cap.
    if (fileCount >= bounds.maxFiles) {
      truncated = true;
      break;
    }
    fileCount++;

    // Enforce maxMatchesPerFile cap.
    let hitCount = 0;
    for (const m of fileMatches) {
      if (hitCount >= bounds.maxMatchesPerFile) {
        truncated = true;
        break;
      }
      matches.push({ path: filePath, line: m.line, excerpt: m.excerpt });
      hitCount++;
    }
  }

  return { slug: repo.slug, matches, truncated };
}
