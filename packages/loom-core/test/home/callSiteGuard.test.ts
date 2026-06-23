/**
 * story-052-005 — Call-site guard for loom-home DB and scratch routing (ADR-005).
 *
 * Verifies that:
 *  1. The three specific call sites (run.ts, crossEpicOverlap.ts, resolveProjectDb.ts)
 *     use the loom-home resolver (prepareRepoState / resolveRepoStatePaths) for all DB access.
 *  2. No production source file outside `home/` constructs a raw `.loom/loom.db` or
 *     `.loom/planning` path for DB/scratch purposes (the "missed call-site" regression).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk upward from startDir until we find a package.json with
 * `name === 'loom-ai-monorepo'` (the monorepo root). This is robust to
 * outDir changes: we anchor on a content marker, not a fixed `..` depth.
 */
function findMonorepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'loom-ai-monorepo') return dir;
      } catch { /* skip unparseable package.json */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`[callSiteGuard] Cannot locate loom-ai-monorepo root from ${startDir}`);
    dir = parent;
  }
}
const WORKTREE_ROOT = findMonorepoRoot(__dirname);

function readSrc(relPath: string): string {
  const absPath = path.join(WORKTREE_ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Source file not found: ${absPath}`);
  }
  return fs.readFileSync(absPath, 'utf8');
}

// ── Targeted call-site checks ────────────────────────────────────────────────

describe('call-site guard — run.ts uses prepareRepoState for DB open', () => {
  let src: string;
  it('source file is readable', () => {
    src = readSrc('packages/loom-cli/src/commands/run.ts');
    assert.ok(src.length > 0);
  });
  it('imports prepareRepoState', () => {
    assert.ok(
      src.includes('prepareRepoState'),
      'run.ts must import prepareRepoState from @loom-ai/core',
    );
  });
  it('calls prepareRepoState before openDatabase', () => {
    const prepIdx = src.indexOf('prepareRepoState(');
    const dbIdx = src.indexOf('openDatabase(');
    assert.ok(prepIdx !== -1, 'prepareRepoState( call not found');
    assert.ok(dbIdx !== -1, 'openDatabase( call not found');
    assert.ok(prepIdx < dbIdx, 'prepareRepoState must appear before openDatabase');
  });
  it('does not call openDatabase with a raw .loom path', () => {
    // No pattern like: openDatabase(path.join(..., '.loom'))
    // or: openDatabase(loomDir) where loomDir is built as path.join(..., '.loom')
    assert.ok(
      !/.loom['"]\s*\)\s*\)\s*;/.test(src),
      'openDatabase must not receive a path ending in .loom',
    );
  });
});

describe('call-site guard — crossEpicOverlap.ts uses resolveRepoStatePaths for DB open', () => {
  let src: string;
  it('source file is readable', () => {
    src = readSrc('packages/loom-cli/src/crossEpicOverlap.ts');
    assert.ok(src.length > 0);
  });
  it('imports resolveRepoStatePaths', () => {
    assert.ok(
      src.includes('resolveRepoStatePaths'),
      'crossEpicOverlap.ts must use resolveRepoStatePaths',
    );
  });
  it('derives namespaceDir before calling openDatabase', () => {
    assert.ok(
      src.includes('namespaceDir'),
      'crossEpicOverlap.ts must destructure namespaceDir from resolveRepoStatePaths',
    );
    assert.ok(
      src.includes('openDatabase(namespaceDir)'),
      'openDatabase must be called with namespaceDir, not a raw .loom path',
    );
  });
});

describe('call-site guard — resolveProjectDb.ts uses resolveRepoStatePaths for peer DB', () => {
  let src: string;
  it('source file is readable', () => {
    src = readSrc('packages/loom-web/src/server/resolveProjectDb.ts');
    assert.ok(src.length > 0);
  });
  it('imports resolveRepoStatePaths', () => {
    assert.ok(
      src.includes('resolveRepoStatePaths'),
      'resolveProjectDb.ts must import resolveRepoStatePaths',
    );
  });
  it('derives namespaceDir before calling createDatabase', () => {
    assert.ok(
      src.includes('namespaceDir'),
      'resolveProjectDb.ts must destructure namespaceDir from resolveRepoStatePaths',
    );
    assert.ok(
      src.includes('createDatabase(dbPath)') || src.includes('createDatabase(path.join(peerNsDir'),
      'createDatabase must receive a loom-home-resolved path',
    );
  });
  it('does not construct .loom/loom.db directly', () => {
    assert.ok(
      !src.includes("'.loom', 'loom.db'") && !src.includes('".loom", "loom.db"') && !src.includes('.loom/loom.db'),
      'resolveProjectDb must not hand-build a .loom/loom.db path',
    );
  });
});

// ── Broad source scan — no production file constructs .loom DB/scratch outside home/ ──

/**
 * Collects all .ts source files under the given directory, excluding paths
 * that contain any of the exclusion tokens.
 */
function collectSourceFiles(dir: string, exclude: string[]): string[] {
  const results: string[] = [];
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !exclude.some((ex) => full.includes(ex))) {
        results.push(full);
      }
    }
  }
  if (fs.existsSync(dir)) {
    walk(dir);
  }
  return results;
}

describe('broad source scan — no hand-built .loom DB/scratch outside home/ resolver', () => {
  // Files that are explicitly permitted to mention these path segments:
  // - home/ resolver files (they ARE the canonical builders)
  // - test / __tests__ files
  // - eval/ files (use isolated temp dirs, not projectRoot)
  // - bench/ files (use temp dirs)
  // - planner/paths.ts (planningRelPaths returns a relative label, not an absolute path used to open files)
  // - planner/Planner.ts (has a fallback default for planningRoot, which is a legitimate backwards-compat guard)
  const EXCLUDED_TOKENS = [
    path.sep + 'home' + path.sep,
    '__tests__',
    path.sep + 'test' + path.sep,
    '.test.ts',
    path.sep + 'eval' + path.sep,
    path.sep + 'bench' + path.sep,
    path.join('planner', 'paths.ts'),
    path.join('planner', 'Planner.ts'),
  ];

  const scanDirs = [
    path.join(WORKTREE_ROOT, 'packages', 'loom-core', 'src'),
    path.join(WORKTREE_ROOT, 'packages', 'loom-cli', 'src'),
    path.join(WORKTREE_ROOT, 'packages', 'loom-web', 'src'),
  ];

  let violations: Array<{ file: string; line: number; text: string }> = [];

  it('collects source files and scans for forbidden patterns', () => {
    // Patterns that indicate a raw .loom/loom.db or .loom/planning path construction
    // for the state DB or planning scratch (as an absolute path, not a relative label).
    //
    // We look for path.join arguments containing both '.loom' and 'loom.db', or
    // path.join arguments with '.loom' followed shortly by 'planning' (absolute construction).
    // String literals like `.loom/planning` used as relative DB/scratch paths are the red flag.
    const FORBIDDEN_RE = [
      // path.join(..., '.loom', 'loom.db') — raw DB path construction
      /['"]\.loom['"],\s*['"]loom\.db['"]/,
      // path.join(..., '.loom', 'planning') — raw scratch path construction
      /['"]\.loom['"],\s*['"]planning['"]/,
    ];

    let totalScanned = 0;
    for (const dir of scanDirs) {
      const files = collectSourceFiles(dir, EXCLUDED_TOKENS);
      for (const file of files) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        totalScanned++;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip comment lines
          if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
          for (const re of FORBIDDEN_RE) {
            if (re.test(line)) {
              violations.push({ file: path.relative(WORKTREE_ROOT, file), line: i + 1, text: line.trim() });
            }
          }
        }
      }
    }
    assert.ok(totalScanned > 0, 'scan must process at least some source files');
  });

  it('no production file constructs a raw .loom/loom.db or .loom/planning path', () => {
    if (violations.length > 0) {
      const details = violations
        .map((v) => `  ${v.file}:${v.line}: ${v.text}`)
        .join('\n');
      assert.fail(
        `Found ${violations.length} forbidden .loom DB/scratch path construction(s) outside home/:\n${details}\n` +
          'Each must route through prepareRepoState() or resolveRepoStatePaths() instead.',
      );
    }
  });
});
