/**
 * Build-step verification for story-010-002.
 *
 * [AC1]    dist/index.js and dist/loom-bench.js have owner-executable bit after clean build.
 * [AC2]    dist/index.js and dist/loom-bench.js are directly invokable without a manual chmod.
 * [AC3]    Mode/runnability assertions are POSIX-only (skipped on Windows, NFR-4).
 * [order]  The build script is ordered clean → tsc → chmod so rm -rf dist cannot wipe the bit.
 *
 * The `pretest` npm hook in package.json runs `npm run build` before this suite, so the
 * file-mode and runnability assertions always test the output of the current build script.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// When compiled: __dirname = packages/loom-cli/dist/__tests__
const CLI_PKG_DIR = path.resolve(__dirname, '../..');
const CLI_PKG_JSON = path.join(CLI_PKG_DIR, 'package.json');
const DIST_INDEX  = path.join(CLI_PKG_DIR, 'dist/index.js');
const DIST_BENCH  = path.join(CLI_PKG_DIR, 'dist/loom-bench.js');
const OWNER_EXEC  = 0o100;

// ── Static: build script content & ordering ───────────────────────────────────

describe('execBit — build script content [order coupling]', () => {
  it('build script chmods both bin targets (dist/index.js and dist/loom-bench.js)', () => {
    const build: string = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8')).scripts.build;
    assert.ok(build.includes('chmod +x'),          `build script must contain chmod +x: "${build}"`);
    assert.ok(build.includes('dist/index.js'),     `build script must chmod dist/index.js: "${build}"`);
    assert.ok(build.includes('dist/loom-bench.js'), `build script must chmod dist/loom-bench.js: "${build}"`);
  });

  it('clean step precedes chmod in build script', () => {
    const build: string = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8')).scripts.build;
    const cleanIdx = build.indexOf('rm -rf dist');
    const chmodIdx = build.indexOf('chmod +x');
    assert.ok(
      cleanIdx !== -1 && chmodIdx !== -1 && cleanIdx < chmodIdx,
      `rm -rf dist must appear before chmod +x in build script: "${build}"`
    );
  });

  it('tsc step precedes chmod in build script', () => {
    const build: string = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8')).scripts.build;
    const tscIdx  = build.indexOf('tsc');
    const chmodIdx = build.indexOf('chmod +x');
    assert.ok(
      tscIdx !== -1 && chmodIdx !== -1 && tscIdx < chmodIdx,
      `tsc must appear before chmod +x in build script: "${build}"`
    );
  });
});

// ── Integration: exec bit + runnability (POSIX only) ─────────────────────────
//
// The `pretest` hook ensures dist/ reflects the current build script before these
// assertions run.  Windows is out of scope (NFR-4) — mode checks are skipped there.

describe('execBit — file mode after clean build [AC1, AC2, AC3]', () => {
  if (process.platform === 'win32') {
    it('skip: mode and runnability assertions are POSIX-only (NFR-4)', () => {
      // intentionally empty — Windows is out of scope
    });
    return;
  }

  it('[AC1] dist/index.js has owner-executable bit set', () => {
    assert.ok(existsSync(DIST_INDEX), 'dist/index.js not found — was the build run?');
    const mode = statSync(DIST_INDEX).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/index.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC1] dist/loom-bench.js has owner-executable bit set', () => {
    assert.ok(existsSync(DIST_BENCH), 'dist/loom-bench.js not found — was the build run?');
    const mode = statSync(DIST_BENCH).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/loom-bench.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC2] dist/index.js is directly invokable without manual chmod', () => {
    assert.ok(existsSync(DIST_INDEX), 'dist/index.js not found — was the build run?');
    const src = readFileSync(DIST_INDEX, 'utf8');
    assert.ok(src.startsWith('#!'), 'dist/index.js is missing a shebang — AC2 would fail regardless of exec bit');
    const result = spawnSync(DIST_INDEX, ['--version'], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `dist/index.js --version exited ${result.status}: ${result.stderr}`
    );
  });

  it('[AC2] dist/loom-bench.js is directly invokable without manual chmod', () => {
    assert.ok(existsSync(DIST_BENCH), 'dist/loom-bench.js not found — was the build run?');
    const src = readFileSync(DIST_BENCH, 'utf8');
    assert.ok(src.startsWith('#!'), 'dist/loom-bench.js is missing a shebang — AC2 would fail regardless of exec bit');
    const result = spawnSync(DIST_BENCH, ['--help'], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `dist/loom-bench.js --help exited ${result.status}: ${result.stderr}`
    );
  });
});
