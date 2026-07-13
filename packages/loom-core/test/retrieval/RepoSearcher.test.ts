import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gitSafe } from '../../src/orchestrator/git.js';
import { registerRepo } from '../../src/home/workspaceManifest.js';
import { resolveRegisteredRepo } from '../../src/retrieval/ManifestResolver.js';
import { loadSliceBounds } from '../../src/retrieval/SliceBounds.js';
import { PolicySchema } from '../../src/types.js';
import { searchBounded } from '../../src/retrieval/RepoSearcher.js';
import type { ResolvedRepo, SliceBounds } from '../../src/retrieval/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-searcher-${prefix}-`));
  try { return fs.realpathSync(dir); } catch { return dir; }
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function commitFile(dir: string, relPath: string): void {
  gitSafe(dir, ['add', relPath]);
  gitSafe(dir, ['commit', '-m', `add ${relPath}`]);
}

function writeAndCommit(dir: string, relPath: string, content: string): void {
  writeFile(dir, relPath, content);
  commitFile(dir, relPath);
}

function makeSearchRepo(): {
  repoDir: string;
  loomHome: string;
  resolved: ResolvedRepo;
  cleanup: () => void;
} {
  const loomHome = makeTmp('home');
  const repoDir = makeTmp('repo');
  fs.mkdirSync(loomHome, { recursive: true });
  gitInit(repoDir);
  const entry = registerRepo(loomHome, repoDir);
  const resolved = resolveRegisteredRepo(loomHome, entry.slug);
  return {
    repoDir,
    loomHome,
    resolved,
    cleanup: () => {
      fs.rmSync(loomHome, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function defaultBounds(): SliceBounds {
  return loadSliceBounds();
}

function defaultSecretGlobs(): string[] {
  return PolicySchema.parse({}).cross_repo.secret_globs;
}

// ── AC-1: Happy path — matches committed content ──────────────────────────────

describe('searchBounded — AC-1: happy path, matched committed content', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    writeAndCommit(ctx.repoDir, 'src/app.ts',
      'const greeting = "hello world";\nconsole.log(greeting);\n',
    );
    writeAndCommit(ctx.repoDir, 'src/util.ts',
      'export function greet(name: string): string {\n  return `hello ${name}`;\n}\n',
    );
  });

  after(() => { ctx.cleanup(); });

  it('returns matches with correct slug, path, line, and excerpt', () => {
    const result = searchBounded(ctx.resolved, 'hello', undefined, defaultBounds(), []);
    assert.equal(result.slug, ctx.resolved.slug, 'slug should match repo slug');
    assert.equal(result.truncated, false);
    assert.ok(result.matches.length >= 2, `expected at least 2 matches, got ${result.matches.length}`);

    const appMatch = result.matches.find(m => m.path === 'src/app.ts');
    assert.ok(appMatch, 'expected a match in src/app.ts');
    assert.equal(appMatch.line, 1, 'match on first line of app.ts');
    assert.ok(appMatch.excerpt.includes('hello world'), `excerpt should contain "hello world", got "${appMatch.excerpt}"`);

    const utilMatch = result.matches.find(m => m.path === 'src/util.ts');
    assert.ok(utilMatch, 'expected a match in src/util.ts');
    assert.ok(utilMatch.line >= 1 && utilMatch.line <= 3, `line should be valid, got ${utilMatch.line}`);
    assert.ok(utilMatch.excerpt.includes('hello'), `excerpt should contain "hello", got "${utilMatch.excerpt}"`);
  });

  it('match paths are relative to repo.root (no absolute paths in results)', () => {
    const result = searchBounded(ctx.resolved, 'hello', undefined, defaultBounds(), []);
    for (const m of result.matches) {
      assert.ok(!path.isAbsolute(m.path), `path "${m.path}" should be relative`);
    }
  });

  it('returns empty matches and truncated=false when query matches nothing', () => {
    const result = searchBounded(ctx.resolved, 'XYZZY_NO_MATCH_9999', undefined, defaultBounds(), []);
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
  });
});

// ── AC-2: Repo confinement — query never spans sibling repos ─────────────────

describe('searchBounded — AC-2: search confined to repo.root', () => {
  let primaryCtx: ReturnType<typeof makeSearchRepo>;
  let siblingDir: string;

  before(() => {
    primaryCtx = makeSearchRepo();
    writeAndCommit(primaryCtx.repoDir, 'main.ts', 'const UNIQUE_PRIMARY_TOKEN = 1;\n');

    // Create a sibling git repo on disk (NOT registered — just present next to the primary).
    siblingDir = makeTmp('sibling');
    gitInit(siblingDir);
    writeAndCommit(siblingDir, 'sibling.ts', 'const UNIQUE_SIBLING_TOKEN = 2;\n');
    // Also plant the PRIMARY token in the sibling to verify it doesn't bleed through.
    writeAndCommit(siblingDir, 'bleed.ts', 'const UNIQUE_PRIMARY_TOKEN = 999;\n');
  });

  after(() => {
    primaryCtx.cleanup();
    fs.rmSync(siblingDir, { recursive: true, force: true });
  });

  it('returns matches only from repo.root — not from sibling', () => {
    // UNIQUE_PRIMARY_TOKEN exists in both primaryCtx.repoDir/main.ts AND siblingDir/bleed.ts.
    const result = searchBounded(primaryCtx.resolved, 'UNIQUE_PRIMARY_TOKEN', undefined, defaultBounds(), []);
    assert.ok(result.matches.length >= 1, 'expected at least one match in primary repo');
    for (const m of result.matches) {
      // Verify result paths never mention the sibling directory name.
      assert.ok(
        !m.path.includes(siblingDir),
        `match path "${m.path}" must not reference sibling directory`,
      );
      assert.ok(!path.isAbsolute(m.path), `match path "${m.path}" should be relative to repo.root`);
    }
  });

  it('does not return UNIQUE_SIBLING_TOKEN (present only in sibling)', () => {
    const result = searchBounded(primaryCtx.resolved, 'UNIQUE_SIBLING_TOKEN', undefined, defaultBounds(), []);
    assert.deepEqual(result.matches, [], 'sibling content must never appear in primary repo search');
  });
});

// ── T7: Injection safety — query is a literal pattern, never shell-interpolated ──

describe('searchBounded — T7: shell injection safety', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;
  let pwnedPath: string;

  before(() => {
    ctx = makeSearchRepo();
    writeAndCommit(ctx.repoDir, 'clean.ts', 'const safe = true;\n');
    pwnedPath = path.join(os.tmpdir(), `loom-pwned-${process.pid}`);
    // Make sure the pwned marker doesn't pre-exist from a prior run.
    try { fs.unlinkSync(pwnedPath); } catch { /* ok */ }
  });

  after(() => {
    ctx.cleanup();
    try { fs.unlinkSync(pwnedPath); } catch { /* ok */ }
  });

  it('treats $(touch ...) as a literal pattern — no shell side effects', () => {
    const malicious = `$(touch ${pwnedPath})`;
    // Should return empty matches (pattern is treated literally, no such content in repo).
    const result = searchBounded(ctx.resolved, malicious, undefined, defaultBounds(), []);
    assert.equal(result.matches.length, 0, 'malicious query should match nothing');
    assert.equal(fs.existsSync(pwnedPath), false, 'shell injection must not create a file');
  });

  it('treats `; rm -rf` as a literal pattern — no shell side effects', () => {
    const malicious = '; rm -rf /tmp/totally-safe';
    const result = searchBounded(ctx.resolved, malicious, undefined, defaultBounds(), []);
    // Pattern is literal — won't match "const safe = true;"
    assert.equal(result.matches.length, 0);
  });

  it('treats --query-looking strings as literal patterns, not as flags', () => {
    // A query starting with "--" passed via -e cannot be misinterpreted as a git flag.
    const result = searchBounded(ctx.resolved, '--version', undefined, defaultBounds(), []);
    assert.ok(Array.isArray(result.matches), 'should return a SearchResult, not throw');
  });
});

// ── AC-3: Bounds reuse — maxFiles / maxMatchesPerFile from the same SliceBounds ─

describe('searchBounded — AC-3: bounds enforcement', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    // Create 5 files each containing multiple matches for the pattern "NEEDLE".
    for (let i = 0; i < 5; i++) {
      writeAndCommit(ctx.repoDir, `file${i}.ts`,
        Array.from({ length: 5 }, (_, j) => `const NEEDLE${i}_${j} = ${j};`).join('\n') + '\n',
      );
    }
  });

  after(() => { ctx.cleanup(); });

  it('caps results at maxFiles and sets truncated=true when more files match', () => {
    const narrowBounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 262144, maxFiles: 2, maxMatchesPerFile: 10 };
    const result = searchBounded(ctx.resolved, 'NEEDLE', undefined, narrowBounds, []);
    // 5 files match but cap is 2.
    const distinctFiles = new Set(result.matches.map(m => m.path)).size;
    assert.ok(distinctFiles <= 2, `expected at most 2 distinct files, got ${distinctFiles}`);
    assert.equal(result.truncated, true, 'truncated should be true when maxFiles is hit');
  });

  it('caps per-file matches at maxMatchesPerFile and sets truncated=true', () => {
    // Use generous maxFiles but tight maxMatchesPerFile.
    const narrowBounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 262144, maxFiles: 20, maxMatchesPerFile: 2 };
    const result = searchBounded(ctx.resolved, 'NEEDLE', undefined, narrowBounds, []);
    // Each file has 5 matches but cap is 2.
    const byFile = new Map<string, number>();
    for (const m of result.matches) {
      byFile.set(m.path, (byFile.get(m.path) ?? 0) + 1);
    }
    for (const [file, count] of byFile) {
      assert.ok(count <= 2, `file "${file}" has ${count} matches, expected at most 2`);
    }
    assert.equal(result.truncated, true, 'truncated should be true when maxMatchesPerFile is hit');
  });

  it('exactly-at-limit does not set truncated=true', () => {
    // Create a controlled repo with exactly 1 file and 1 match.
    const ctlCtx = makeSearchRepo();
    try {
      writeAndCommit(ctlCtx.repoDir, 'exactly.ts', 'const EXACT_MATCH = 1;\n');
      const bounds: SliceBounds = { maxLineWindow: 200, maxFileBytes: 262144, maxFiles: 1, maxMatchesPerFile: 1 };
      const result = searchBounded(ctlCtx.resolved, 'EXACT_MATCH', undefined, bounds, []);
      assert.equal(result.matches.length, 1);
      assert.equal(result.truncated, false, 'exactly at limit should not set truncated');
    } finally {
      ctlCtx.cleanup();
    }
  });

  it('uses the SAME SliceBounds type as RepoReader (maxFiles + maxMatchesPerFile fields)', () => {
    // Assert no second limit set was introduced: SliceBounds must carry all four shared fields.
    // (No field-count assertion — new legitimate fields should not break this test.)
    const bounds = defaultBounds();
    assert.ok('maxFiles' in bounds, 'SliceBounds must have maxFiles');
    assert.ok('maxMatchesPerFile' in bounds, 'SliceBounds must have maxMatchesPerFile');
    assert.ok('maxLineWindow' in bounds, 'SliceBounds must have maxLineWindow');
    assert.ok('maxFileBytes' in bounds, 'SliceBounds must have maxFileBytes');
  });
});

// ── pathGlob scoping ──────────────────────────────────────────────────────────

describe('searchBounded — pathGlob scoping', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    writeAndCommit(ctx.repoDir, 'src/index.ts', 'const COMMON = "match me";\n');
    writeAndCommit(ctx.repoDir, 'lib/helper.js', 'const COMMON = "match me too";\n');
    writeAndCommit(ctx.repoDir, 'README.md', 'COMMON placeholder\n');
  });

  after(() => { ctx.cleanup(); });

  it('without pathGlob returns matches from all files', () => {
    const result = searchBounded(ctx.resolved, 'COMMON', undefined, defaultBounds(), []);
    const paths = result.matches.map(m => m.path);
    assert.ok(paths.some(p => p.includes('index.ts')), 'should match src/index.ts');
    assert.ok(paths.some(p => p.includes('helper.js')), 'should match lib/helper.js');
    assert.ok(paths.some(p => p.includes('README.md')), 'should match README.md');
  });

  it('pathGlob "*.ts" narrows results to TypeScript files only', () => {
    const result = searchBounded(ctx.resolved, 'COMMON', '*.ts', defaultBounds(), []);
    for (const m of result.matches) {
      assert.ok(m.path.endsWith('.ts'), `path "${m.path}" should end with .ts`);
    }
    assert.ok(result.matches.length >= 1, 'expected at least one .ts match');
  });

  it('pathGlob "src/**" restricts to src/ directory', () => {
    const result = searchBounded(ctx.resolved, 'COMMON', 'src/**', defaultBounds(), []);
    for (const m of result.matches) {
      assert.ok(m.path.startsWith('src/'), `path "${m.path}" should start with "src/"`);
    }
    assert.ok(result.matches.length >= 1, 'expected at least one src/ match');
  });

  it('non-matching pathGlob returns empty results', () => {
    const result = searchBounded(ctx.resolved, 'COMMON', '*.go', defaultBounds(), []);
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
  });
});

// ── ADR-005: Tracked-files-only — untracked files are invisible ───────────────

describe('searchBounded — ADR-005: tracked files only', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    // Commit one file with a known pattern.
    writeAndCommit(ctx.repoDir, 'tracked.ts', 'const TRACKED_CONTENT = 1;\n');
    // Write an untracked file with a different known pattern (never git-add it).
    writeFile(ctx.repoDir, 'untracked.ts', 'const UNTRACKED_CONTENT = 2;\n');
    // Write an untracked .env — even if not secret-filtered, git grep won't see it.
    writeFile(ctx.repoDir, '.env', 'SECRET_KEY=super-secret\n');
  });

  after(() => { ctx.cleanup(); });

  it('matches content in tracked files', () => {
    const result = searchBounded(ctx.resolved, 'TRACKED_CONTENT', undefined, defaultBounds(), []);
    assert.ok(result.matches.some(m => m.path === 'tracked.ts'), 'tracked.ts should be found');
  });

  it('does not match content in untracked files', () => {
    const result = searchBounded(ctx.resolved, 'UNTRACKED_CONTENT', undefined, defaultBounds(), []);
    assert.deepEqual(result.matches, [], 'untracked content must not appear in results');
  });

  it('does not match untracked .env even without secret filtering', () => {
    // Pass no secret globs so the only protection is tracked-files-only behavior.
    const result = searchBounded(ctx.resolved, 'SECRET_KEY', undefined, defaultBounds(), []);
    assert.deepEqual(result.matches, [], 'untracked .env must not appear in results');
  });
});

// ── Secret filtering — committed secrets are excluded from results ────────────

describe('searchBounded — secret filtering', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    // Commit a secret-path file and a normal file — both contain the same pattern.
    writeAndCommit(ctx.repoDir, '.env', 'SECRET_PATTERN=secret_value\n');
    writeAndCommit(ctx.repoDir, 'config.ts', 'const SECRET_PATTERN = "safe";\n');
  });

  after(() => { ctx.cleanup(); });

  it('excludes committed files matching secretGlobs from results', () => {
    const result = searchBounded(ctx.resolved, 'SECRET_PATTERN', undefined, defaultBounds(), defaultSecretGlobs());
    const paths = result.matches.map(m => m.path);
    assert.ok(!paths.includes('.env'), '.env should be excluded by secret filtering');
  });

  it('still returns matches from non-secret files even when secretGlobs provided', () => {
    const result = searchBounded(ctx.resolved, 'SECRET_PATTERN', undefined, defaultBounds(), defaultSecretGlobs());
    assert.ok(result.matches.some(m => m.path === 'config.ts'), 'config.ts should still match');
  });

  it('with empty secretGlobs, .env matches are included', () => {
    const result = searchBounded(ctx.resolved, 'SECRET_PATTERN', undefined, defaultBounds(), []);
    const paths = result.matches.map(m => m.path);
    assert.ok(paths.includes('.env'), '.env should appear when no secret globs provided');
  });

  it('excludes files in secrets/ directory', () => {
    const sCtx = makeSearchRepo();
    try {
      writeAndCommit(sCtx.repoDir, 'secrets/token.txt', 'VAULT_TOKEN=abc123\n');
      writeAndCommit(sCtx.repoDir, 'normal.ts', 'const VAULT_TOKEN = "";\n');
      const globs = ['**/secrets/**'];
      const result = searchBounded(sCtx.resolved, 'VAULT_TOKEN', undefined, defaultBounds(), globs);
      const paths = result.matches.map(m => m.path);
      assert.ok(!paths.includes('secrets/token.txt'), 'secrets/ file should be excluded');
      assert.ok(paths.includes('normal.ts'), 'normal.ts should still match');
    } finally {
      sCtx.cleanup();
    }
  });
});

// ── Unit-level: argv construction — no shell, literal query via -e ────────────

describe('searchBounded — argv construction (unit assertions)', () => {
  let ctx: ReturnType<typeof makeSearchRepo>;

  before(() => {
    ctx = makeSearchRepo();
    // Commit a file that contains the literal string "$(echo injected)".
    writeAndCommit(ctx.repoDir, 'literal.ts', 'const x = "$(echo injected)";\n');
  });

  after(() => { ctx.cleanup(); });

  it('finds a literal pattern that looks like a shell substitution when committed', () => {
    // The pattern "$(echo injected)" is committed verbatim in literal.ts line 1.
    // If git grep were invoked via a shell, this would evaluate instead of match.
    // Using execFileSync without shell=true means git grep receives it as a literal.
    const result = searchBounded(ctx.resolved, '$(echo injected)', undefined, defaultBounds(), []);
    assert.ok(
      result.matches.some(m => m.path === 'literal.ts' && m.line === 1),
      'should find the literal pattern in the committed file',
    );
  });

  it('a query with backtick injection is treated as a literal pattern', () => {
    writeAndCommit(ctx.repoDir, 'backtick.ts', 'const cmd = "`date`";\n');
    const result = searchBounded(ctx.resolved, '`date`', undefined, defaultBounds(), []);
    assert.ok(
      result.matches.some(m => m.path === 'backtick.ts'),
      'backtick content should be found as a literal string',
    );
  });
});
