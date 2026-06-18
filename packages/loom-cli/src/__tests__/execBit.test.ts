/**
 * Build-step verification for story-010-002.
 *
 * [AC1]    dist/index.js and dist/loom-bench.js have owner-executable bit after clean build.
 * [AC2]    dist/index.js is directly invokable without a manual chmod.
 * [AC3]    Mode/runnability assertions are POSIX-only (skipped on Windows, NFR-4).
 * [order]  The build script is ordered clean → tsc → chmod so rm -rf dist cannot wipe the bit.
 *
 * The file-mode and runnability assertions check the files produced by the clean build that
 * the test harness ran immediately before this test suite (`npm test` runs `npm run build`
 * first).  Re-running the build inside a test would destroy dist concurrently with other
 * test files, causing false failures.  Checking the already-built files is equivalent: they
 * were produced by the script under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import path from 'node:path';

// When compiled: __dirname = packages/loom-cli/dist/__tests__
const CLI_PKG_DIR = path.resolve(__dirname, '../..');
const CLI_PKG_JSON = path.join(CLI_PKG_DIR, 'package.json');
const DIST_INDEX  = path.join(CLI_PKG_DIR, 'dist/index.js');
const DIST_BENCH  = path.join(CLI_PKG_DIR, 'dist/loom-bench.js');
const OWNER_EXEC  = 0o100;

// ── Static: build script content & ordering ───────────────────────────────────

describe('execBit — build script content [order coupling]', () => {
  it('build script matches pinned value: rm -rf dist && tsc && chmod +x …', () => {
    const pkg = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8'));
    assert.equal(
      pkg.scripts.build,
      'rm -rf dist && tsc && chmod +x dist/index.js dist/loom-bench.js',
      'build script must match pinned contract exactly (ADR-6)'
    );
  });

  it('clean step (rm -rf dist) precedes chmod in build script', () => {
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

  it('build script chmods both bin targets (dist/index.js and dist/loom-bench.js)', () => {
    const build: string = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8')).scripts.build;
    assert.ok(build.includes('dist/index.js'),    `build script must chmod dist/index.js: "${build}"`);
    assert.ok(build.includes('dist/loom-bench.js'), `build script must chmod dist/loom-bench.js: "${build}"`);
  });
});

// ── Integration: exec bit + runnability (POSIX only) ─────────────────────────
//
// These assertions check the files that were produced by the clean build the
// test harness ran just before this suite.  `npm test` runs `npm run build`
// first, so by the time these tests execute the dist files reflect the build
// script we are verifying.

describe('execBit — file mode after clean build [AC1, AC2, AC3]', () => {
  if (process.platform === 'win32') {
    it('skip: mode and runnability assertions are POSIX-only (NFR-4)', () => {
      // intentionally empty — Windows is out of scope
    });
    return;
  }

  it('[AC1] dist/index.js has owner-executable bit set', () => {
    const mode = statSync(DIST_INDEX).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/index.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC1] dist/loom-bench.js has owner-executable bit set', () => {
    const mode = statSync(DIST_BENCH).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/loom-bench.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC2] dist/index.js is directly invokable without manual chmod', () => {
    const result = spawnSync(DIST_INDEX, ['--version'], { encoding: 'utf8' });
    assert.equal(
      result.status,
      0,
      `dist/index.js --version exited ${result.status}: ${result.stderr}`
    );
  });
});
