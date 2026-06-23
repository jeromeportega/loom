import fs from 'node:fs';
import path from 'node:path';
import type { MigrationResult } from './repoState.js';
import { gitSafe, isGitRepo } from '../orchestrator/git.js';

/**
 * Migrate the planning scratch directory from in-repo to loom-home.
 *
 * Iterates direct children of srcRoot and moves each one to the corresponding
 * location under dstRoot, skipping any child that is git-tracked (to preserve
 * committed planning artifacts like epic-040/). Uses renameSync with an EXDEV
 * copy+delete fallback for cross-filesystem moves.
 *
 * Stale-source removal: only the entries actually relocated are removed from
 * srcRoot. Git-tracked entries are never touched.
 */
export function migratePlanningScratch(opts: {
  srcRoot: string;
  dstRoot: string;
}): MigrationResult {
  const { srcRoot, dstRoot } = opts;

  if (!fs.existsSync(srcRoot)) {
    return { migrated: false, from: null, to: dstRoot, method: null };
  }

  const entries = fs.readdirSync(srcRoot);
  if (entries.length === 0) {
    return { migrated: false, from: null, to: dstRoot, method: null };
  }

  // Pre-check git state once. When srcRoot is inside a git working tree we
  // use per-entry tracking checks to protect committed artifacts (AC3). When
  // it is not (non-git project or git unavailable), no committed entries can
  // exist so all entries are safe to migrate without per-entry checks.
  const inGitRepo = isGitRepo(srcRoot);

  fs.mkdirSync(dstRoot, { recursive: true });

  let migratedCount = 0;
  let usedCopy = false;

  for (const entry of entries) {
    const srcEntry = path.join(srcRoot, entry);
    const dstEntry = path.join(dstRoot, entry);

    if (inGitRepo && isGitTrackedEntry(srcRoot, entry)) continue;
    if (fs.existsSync(dstEntry)) continue;

    try {
      fs.renameSync(srcEntry, dstEntry);
      migratedCount++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      // Cross-filesystem move: copy then delete. If the copy fails midway,
      // clean up the partial destination before re-throwing so the next
      // invocation does not skip it via the existsSync guard above.
      try {
        copyDirRecursive(srcEntry, dstEntry);
        fs.rmSync(srcEntry, { recursive: true, force: true });
        migratedCount++;
        usedCopy = true;
      } catch (copyErr) {
        try { fs.rmSync(dstEntry, { recursive: true, force: true }); } catch { /* best-effort */ }
        throw copyErr;
      }
    }
  }

  if (migratedCount === 0) {
    return { migrated: false, from: null, to: dstRoot, method: null };
  }

  // Remove the srcRoot directory itself when all untracked entries were
  // relocated and only git-tracked entries (if any) remain. If git-tracked
  // entries are present, srcRoot will be non-empty and we leave it in place.
  try {
    if (fs.readdirSync(srcRoot).length === 0) {
      fs.rmdirSync(srcRoot);
    }
  } catch {
    // Best-effort: failing to remove an empty parent does not invalidate the migration.
  }

  return {
    migrated: true,
    from: srcRoot,
    to: dstRoot,
    method: usedCopy ? 'copy' : 'rename',
  };
}

function isGitTrackedEntry(dir: string, entry: string): boolean {
  const res = gitSafe(dir, ['ls-files', entry]);
  return res.ok && res.output.trim().length > 0;
}

function copyDirRecursive(src: string, dst: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyDirRecursive(path.join(src, child), path.join(dst, child));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}
