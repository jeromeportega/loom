import fs from 'node:fs';
import path from 'node:path';
import { RetrievalRefused, CROSS_REPO_RULES } from './types.js';
import type { ResolvedRepo, ReadResult, SliceBounds } from './types.js';
import { isSecretPath, redactSecrets } from './secretFilter.js';

/**
 * Read a bounded slice of a file from a registered repo.
 *
 * Invariants (in order of check):
 *  1. relPath must not match any secretGlobs — refused before any fs access.
 *  2. Resolved absolute path must not escape repo.root — path traversal + symlink escape refused.
 *  3. File must be at most bounds.maxFileBytes — refused (not truncated) per ADR-007.
 *  4. Line window (when provided) is truncated to bounds.maxLineWindow — truncated: true signals the agent.
 *  5. Content is run through the redact-secrets helper before returning.
 */
export function readBounded(
  repo: ResolvedRepo,
  relPath: string,
  lines: [number, number] | undefined,
  bounds: SliceBounds,
  secretGlobs: string[],
): ReadResult {
  // 1. Secret path exclusion — refuse before any fs read.
  if (isSecretPath(relPath, secretGlobs)) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.SECRET_EXCLUDED,
      `Path "${relPath}" matches a secret glob and cannot be read`,
    );
  }

  // 2. Path escape check.
  // path.resolve normalises ../escape and absolute overrides without touching the fs.
  const absPath = path.resolve(repo.root, relPath);
  const normalizedRoot = repo.root.endsWith(path.sep) ? repo.root : repo.root + path.sep;
  if (!absPath.startsWith(normalizedRoot) && absPath !== repo.root) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.OUT_OF_WORKSPACE,
      `Path "${relPath}" resolves outside repo root "${repo.root}"`,
    );
  }

  // Follow symlinks to catch symlink-based escapes.
  let realAbs: string;
  try {
    realAbs = fs.realpathSync(absPath);
  } catch {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Cannot resolve "${relPath}" in repo "${repo.slug}": file not found`,
    );
  }

  // repo.root is already a realpath (set by ManifestResolver via fs.realpathSync).
  const normalizedRealRoot = repo.root.endsWith(path.sep) ? repo.root : repo.root + path.sep;
  if (!realAbs.startsWith(normalizedRealRoot) && realAbs !== repo.root) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.OUT_OF_WORKSPACE,
      `Path "${relPath}" resolves outside repo root "${repo.root}" (symlink escape)`,
    );
  }

  // 3. File size check — refused, not truncated (ADR-007).
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realAbs);
  } catch {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Cannot stat "${relPath}" in repo "${repo.slug}"`,
    );
  }

  if (stat.size > bounds.maxFileBytes) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.FILE_TOO_LARGE,
      `File "${relPath}" is ${stat.size} bytes, exceeds maxFileBytes=${bounds.maxFileBytes}`,
    );
  }

  // 4. Read and slice.
  const raw = fs.readFileSync(realAbs, 'utf8');
  const rawLines = raw.split('\n');
  // Strip the trailing empty string produced by a trailing newline so line
  // counts are stable regardless of whether the file ends with '\n'.
  const allLines =
    rawLines.length > 1 && rawLines[rawLines.length - 1] === ''
      ? rawLines.slice(0, -1)
      : rawLines;
  const totalLines = allLines.length;

  let startLine: number;
  let endLine: number;
  let truncated = false;

  if (lines === undefined) {
    // Full-file read — no window requested.
    startLine = 1;
    endLine = totalLines;
  } else {
    startLine = lines[0];
    // Clamp end to EOF — b beyond EOF is a soft bound, not an error.
    endLine = Math.min(lines[1], totalLines);
    // Truncate over-wide windows to the configured cap.
    const windowSize = endLine - startLine + 1;
    if (windowSize > bounds.maxLineWindow) {
      endLine = startLine + bounds.maxLineWindow - 1;
      truncated = true;
    }
  }

  const sliceLines = allLines.slice(startLine - 1, endLine);
  const content = redactSecrets(sliceLines.join('\n'));

  return {
    slug: repo.slug,
    path: relPath,
    content,
    window: [startLine, endLine],
    truncated,
  };
}
