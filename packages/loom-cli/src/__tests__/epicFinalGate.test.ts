/**
 * Epic-003 final gate (story-003-006).
 *
 * Tree-wide source grep: the four forbidden strings must return zero hits
 * outside the allowlisted worker-provisioning paths.
 *
 * Allowlisted paths (retained MCP provisioning surface, not the removed operator surface):
 *   - packages/loom-core/src/mcp/**
 *   - packages/loom-core/src/orchestrator/Supervisor.ts
 *       (has one stale `loom serve` comment in the guidance-watcher section;
 *        Supervisor.ts is a protected file per the shared contract)
 *
 * docs/research/cursor-mcp-strictness.md is the one research doc that may
 * reference these strings; verified to exist on disk.
 *
 * Test files (under __tests__/, *.test.ts) are excluded because they
 * legitimately contain the forbidden strings as test data or assertions.
 *
 * CI usage: this test runs as part of the normal npm run test suite and exits
 * non-zero on any disallowed hit — making the done-ness mechanical (ADR-004).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Recursively collect .ts files under a directory. */
function walkTs(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Normalise an absolute path to a repo-relative form for display and matching. */
function rel(p: string): string {
  return path.relative(REPO_ROOT, p);
}

/** Return true if the file is a test file (excluded from the forbidden-string scan). */
function isTestFile(relPath: string): boolean {
  return (
    relPath.includes('__tests__') ||
    relPath.endsWith('.test.ts') ||
    relPath.includes('/test/e2e/') ||
    relPath.includes('/test/unit/')
  );
}

/** Return true if the file is in an allowlisted worker-provisioning path. */
function isAllowlisted(relPath: string): boolean {
  // Retained worker-provisioning MCP module
  if (relPath.startsWith('packages/loom-core/src/mcp/')) return true;
  // Supervisor.ts has one stale `loom serve` comment in the guidance-watcher section;
  // it is a protected file per the shared contract and cannot be edited here.
  if (relPath === 'packages/loom-core/src/orchestrator/Supervisor.ts') return true;
  return false;
}

/** Collect lines in a file matching the given regex. Returns [] if none. */
function findHits(filePath: string, pattern: RegExp): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map((line, i) => ({ line, lineNo: i + 1 }))
    .filter(({ line }) => pattern.test(line))
    .map(({ lineNo }) => `${rel(filePath)}:${lineNo}`);
}

/**
 * The four forbidden strings, expressed as regexes.
 *
 * `loom serve` uses a negative lookahead so it matches the CLI command but not
 * the legitimate `loom server` word (with a trailing 'r') that appears in
 * worker-provisioning comments describing the MCP config materialiser.
 */
const FORBIDDEN: Array<{ pattern: RegExp; display: string; label: string }> = [
  { pattern: /loom-mcp/, display: 'loom-mcp', label: 'loom-mcp package reference' },
  { pattern: /loom serve(?!r)/, display: 'loom serve', label: 'loom serve CLI command' },
  { pattern: /mcp__loom/, display: 'mcp__loom', label: 'mcp__loom tool namespace' },
  { pattern: /loom init --mcp/, display: 'loom init --mcp', label: 'loom init --mcp option reference' },
];

// Collect all source TS files across the three packages
const SOURCE_DIRS = ['loom-core', 'loom-cli', 'loom-web'].map((pkg) =>
  path.join(REPO_ROOT, 'packages', pkg, 'src')
);
const ALL_TS_FILES = SOURCE_DIRS.flatMap((d) => walkTs(d));
const SCAN_FILES = ALL_TS_FILES.filter((f) => {
  const r = rel(f);
  return !isTestFile(r) && !isAllowlisted(r);
});

describe('epic-003 final gate — forbidden-string source scan (story-003-006)', () => {
  it('REPO_ROOT resolves to the actual repository root', () => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, 'package.json')),
      `REPO_ROOT '${REPO_ROOT}' does not contain package.json — path depth is wrong`
    );
  });

  it('docs/research/cursor-mcp-strictness.md exists (allowlisted research doc)', () => {
    const p = path.join(REPO_ROOT, 'docs', 'research', 'cursor-mcp-strictness.md');
    assert.ok(fs.existsSync(p), 'docs/research/cursor-mcp-strictness.md is missing');
  });

  for (const { pattern, display, label } of FORBIDDEN) {
    it(`"${display}" absent from non-test source files outside provisioning paths (${label})`, () => {
      const hits: string[] = [];
      for (const file of SCAN_FILES) {
        hits.push(...findHits(file, pattern));
      }
      assert.deepEqual(
        hits,
        [],
        `Forbidden string "${display}" found in non-allowlisted source:\n  ${hits.join('\n  ')}`
      );
    });
  }

  it('allowlisted provisioning paths exist on disk', () => {
    const mcpDir = path.join(REPO_ROOT, 'packages', 'loom-core', 'src', 'mcp');
    assert.ok(
      fs.existsSync(mcpDir),
      `packages/loom-core/src/mcp/ not found — provisioning module was unexpectedly deleted`
    );
    const supervisorPath = path.join(
      REPO_ROOT,
      'packages',
      'loom-core',
      'src',
      'orchestrator',
      'Supervisor.ts'
    );
    assert.ok(fs.existsSync(supervisorPath), 'Supervisor.ts not found');
  });
});
