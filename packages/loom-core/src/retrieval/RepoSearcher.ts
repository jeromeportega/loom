import { execFileSync } from 'node:child_process';
import { isSecretPath } from './secretFilter.js';
import type { ResolvedRepo, SliceBounds, SearchResult, RetrievalMatch } from './types.js';

/**
 * Grep-style search over a single manifest-registered repository.
 *
 * Shells out to `git grep` via execFileSync (argv array, no shell) so:
 *  - `query` is always a fixed-string literal — passed via -F -e, never interpolated
 *    (ADR-005 / T7). -F prevents regex amplification or exit-2 errors via crafted queries.
 *  - `cwd: repo.root` confines the search; git cannot cross sibling repo boundaries.
 *  - `-z` makes git NUL-delimit all output fields (path\0lineno\0content\n) so paths or
 *    excerpts containing ':' parse correctly on any filesystem.
 *
 * Bounds come from the same SliceBounds as RepoReader (story-057-002) — maxFiles
 * caps the number of distinct matched files, maxMatchesPerFile caps per-file hits.
 * `truncated: true` is set whenever either cap is hit.
 *
 * Secret paths (matched by secretGlobs via minimatch) are silently excluded from results.
 *
 * ADR-005 trade-off: `git grep` sees only tracked files. Untracked files (including
 * accidentally-dropped secrets not yet committed) are invisible to search. Binary file
 * hits produce a summary line with no NUL separator and are silently excluded.
 */
export function searchBounded(
  repo: ResolvedRepo,
  query: string,
  pathGlob: string | undefined,
  bounds: SliceBounds,
  secretGlobs: string[],
): SearchResult {
  // -c color.grep=never: suppress ANSI codes even when the user's git config sets color.ui=always.
  // -F: fixed-string (literal) matching — enforces the literal-match contract and prevents regex
  //     amplification or exit-2 errors via BRE metacharacters in the query.
  // -z: NUL-delimit all fields in output ("path\0lineno\0content\n") so paths and excerpts
  //     containing ':' (exotic FSes) parse unambiguously.
  // -e: pass query as an explicit pattern argument, safe even when query starts with '-'.
  const args = ['-c', 'color.grep=never', 'grep', '--line-number', '-z', '-F', '-e', query];
  if (pathGlob !== undefined) {
    // '--' separates the pattern from pathspecs so git doesn't confuse them with revisions.
    args.push('--', pathGlob);
  }

  // Set maxBuffer proportional to bounds so the buffer cannot be exhausted before our
  // post-processing cap kicks in, with a 16 MiB floor for safety.
  const maxBuffer = Math.max(bounds.maxFiles * bounds.maxMatchesPerFile * 4096, 16 * 1024 * 1024);

  let rawOutput: string;
  try {
    rawOutput = execFileSync('git', args, {
      cwd: repo.root,
      encoding: 'utf8',
      maxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (e.status === 1) {
      // git grep exits 1 when the pattern matches nothing — not an error.
      return { slug: repo.slug, matches: [], truncated: false };
    }
    // Exit code 2 or other = real git error; cap detail to avoid leaking repo internals.
    const detail = (e.stderr ?? e.stdout ?? String(err)).slice(0, 400);
    throw new Error(`git grep failed in repo "${repo.slug}": ${detail}`);
  }

  // Parse NUL-terminated output: with -z and --line-number, each match line is
  // "<filepath>\0<lineno>\0<content>\n" — all three fields separated by NUL, not ':'.
  // This is unambiguous regardless of characters in filenames or content.
  // Lines with fewer than 2 NULs (e.g. binary-file summary lines) are silently skipped.
  const byFile = new Map<string, Array<{ line: number; excerpt: string }>>();
  for (const rawLine of rawOutput.split('\n')) {
    if (rawLine.length === 0) continue;
    const n1 = rawLine.indexOf('\0');
    if (n1 === -1) continue;
    const n2 = rawLine.indexOf('\0', n1 + 1);
    if (n2 === -1) continue;

    const filePath = rawLine.slice(0, n1);
    const lineNo = parseInt(rawLine.slice(n1 + 1, n2), 10);
    const excerpt = rawLine.slice(n2 + 1);

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
