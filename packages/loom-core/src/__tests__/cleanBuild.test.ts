import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// From dist/__tests__/, the workspace root is four levels up:
//   packages/loom-core/dist/__tests__  →  packages/loom-core/dist  →
//   packages/loom-core  →  packages  →  <workspace-root>
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');

// In a git worktree, node_modules may live in the parent repo rather than
// the worktree root itself — walk up until we find node_modules/.bin/tsc.
function resolveBin(name: string, startDir: string): string {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${name} not found in any node_modules/.bin along the path from ${startDir}`);
    dir = parent;
  }
}

const TSC_BIN = resolveBin('tsc', WORKSPACE_ROOT);

// ─── Source-assertion helpers ────────────────────────────────────────────────

function readBuildScript(pkg: string): string {
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(WORKSPACE_ROOT, 'packages', pkg, 'package.json'), 'utf8')
  ) as { scripts: Record<string, string> };
  return pkgJson.scripts.build ?? '';
}

function readTsconfig(relPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, relPath), 'utf8')) as Record<string, unknown>;
}

// ─── Build-script source assertions (AC1) ────────────────────────────────────

describe('clean build — source assertions', () => {
  it('loom-core build script clears dist before tsc', () => {
    const script = readBuildScript('loom-core');
    assert.ok(
      script.startsWith('rm -rf dist'),
      `expected build to start with 'rm -rf dist', got: ${script}`
    );
    assert.ok(script.includes('tsc'), 'build script must invoke tsc');
  });

  it('loom-core build script clears dist-test before tsc', () => {
    const script = readBuildScript('loom-core');
    assert.ok(
      /rm -rf dist dist-test/.test(script),
      `expected 'rm -rf dist dist-test' in build script, got: ${script}`
    );
  });

  it('loom-web build script clears dist before tsc and builds the React SPA with vite', () => {
    const script = readBuildScript('loom-web');
    assert.ok(
      /rm -rf dist/.test(script),
      `expected 'rm -rf dist' in loom-web build script, got: ${script}`
    );
    assert.ok(script.includes('tsc'), 'build script must invoke tsc (server)');
    // epic-081 re-platformed loom-web from a static vanilla-JS `copy:public`
    // step to a Vite-built React SPA — the build must now invoke `vite build`.
    assert.ok(script.includes('vite build'), 'loom-web build must invoke vite build (React SPA)');
  });
});

// ─── Ghost-test elimination behavioral test (AC1 / AC2) ──────────────────────
//
// Simulates: build once with src/__tests__/ghost.test.ts present, then remove
// it from source and rebuild with the clean-first script. The ghost compiled
// output must not survive.

describe('clean build — ghost-test elimination', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renamed-away source test leaves no compiled ghost in dist/', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-clean-build-'));

    // Minimal fixture tsconfig: rootDir=src, outDir=dist, no composite.
    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        rootDir: 'src',
        outDir: 'dist',
        strict: true,
        skipLibCheck: true,
      },
      include: ['src/**/*'],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2)
    );

    // Step 1: create src/__tests__/ghost.test.ts plus a keeper file, then compile.
    // keeper.ts ensures tsc has at least one input after ghost is removed.
    const srcDir = path.join(tmpDir, 'src');
    const srcTestsDir = path.join(srcDir, '__tests__');
    fs.mkdirSync(srcTestsDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'keeper.ts'), 'export const x = 1;\n');

    const ghostSrc = path.join(srcTestsDir, 'ghost.test.ts');
    fs.writeFileSync(ghostSrc, 'export const ghost = "will be removed";\n');

    // First build (no clean step — simulates the old tsc-only behavior).
    execFileSync(TSC_BIN, [], { cwd: tmpDir, stdio: 'pipe' });

    const ghostCompiled = path.join(tmpDir, 'dist', '__tests__', 'ghost.test.js');
    assert.ok(fs.existsSync(ghostCompiled), 'compiled ghost must exist after first build');

    // Step 2: remove the source test (simulate rename/delete).
    fs.rmSync(ghostSrc);

    // Step 3: rebuild WITH the clean step (rm -rf dist && tsc).
    execSync('rm -rf dist', { cwd: tmpDir, stdio: 'pipe' });
    execFileSync(TSC_BIN, [], { cwd: tmpDir, stdio: 'pipe' });

    assert.ok(
      !fs.existsSync(ghostCompiled),
      'ghost compiled test must not survive a clean build after source removal'
    );

    // Also confirm node --test over dist/ cannot discover it.
    const ghosts = findTestJs(path.join(tmpDir, 'dist'));
    assert.equal(
      ghosts.filter(f => f.includes('ghost.test.js')).length,
      0,
      'node --test discovery must find zero ghost tests'
    );
  });
});

// ─── Long-lived-tree parity (AC3) ────────────────────────────────────────────
//
// Simulates an older-revision dist/ containing an orphan compiled test. After
// one clean build, the result must match what a fresh checkout would produce.

describe('clean build — long-lived-tree parity', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stale dist/ with orphan test converges to fresh-checkout result after one build', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-parity-'));

    const tsconfig = {
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        rootDir: 'src',
        outDir: 'dist',
        strict: true,
        skipLibCheck: true,
      },
      include: ['src/**/*'],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify(tsconfig, null, 2)
    );

    // Current source: only keeper.ts
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'keeper.ts'), 'export const x = 1;\n');

    // Pre-existing stale dist/: contains orphan.js not backed by any source.
    const distTestsDir = path.join(tmpDir, 'dist', '__tests__');
    fs.mkdirSync(distTestsDir, { recursive: true });
    fs.writeFileSync(
      path.join(distTestsDir, 'orphan.test.js'),
      '"use strict"; // stale compiled test from an older revision\n'
    );

    // Run the clean build (rm -rf dist && tsc).
    execSync('rm -rf dist', { cwd: tmpDir, stdio: 'pipe' });
    execFileSync(TSC_BIN, [], { cwd: tmpDir, stdio: 'pipe' });

    // The orphan must be gone.
    assert.ok(
      !fs.existsSync(path.join(distTestsDir, 'orphan.test.js')),
      'orphan compiled test must be swept away by clean build'
    );

    // dist/ must faithfully reflect src/ — keeper.js present, orphan absent.
    assert.ok(
      fs.existsSync(path.join(tmpDir, 'dist', 'keeper.js')),
      'keeper.js must be present in dist/ after clean build'
    );
  });
});

// ─── AC4 — incremental/cache assumption check (by inspection) ────────────────
//
// No tsconfig uses composite or tsBuildInfoFile, so no incremental output
// accumulates. No .github/workflows exists, so no CI relies on cached dist/.

describe('clean build — no incremental/cache assumptions broken (AC4)', () => {
  const tsconfigs = [
    'tsconfig.base.json',
    'packages/loom-core/tsconfig.json',
    'packages/loom-core/tsconfig.test.json',
    'packages/loom-web/tsconfig.json',
    'packages/loom-cli/tsconfig.json',
  ];

  for (const rel of tsconfigs) {
    it(`${rel} does not enable composite or tsBuildInfoFile`, () => {
      const cfg = readTsconfig(rel) as {
        compilerOptions?: { composite?: boolean; tsBuildInfoFile?: string };
      };
      const opts = cfg.compilerOptions ?? {};
      assert.equal(
        opts.composite,
        undefined,
        `${rel} must not set composite (incremental project refs)`
      );
      assert.equal(
        opts.tsBuildInfoFile,
        undefined,
        `${rel} must not set tsBuildInfoFile (incremental build cache)`
      );
    });
  }

  it('no .github/workflows directory exists (no CI caching assumption)', () => {
    const ciDir = path.join(WORKSPACE_ROOT, '.github', 'workflows');
    assert.ok(
      !fs.existsSync(ciDir),
      '.github/workflows must not exist — no CI relies on cached dist/'
    );
  });
});

// ─── Utility ─────────────────────────────────────────────────────────────────

function findTestJs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTestJs(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      results.push(full);
    }
  }
  return results;
}
