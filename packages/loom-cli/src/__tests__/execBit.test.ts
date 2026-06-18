// story-010-002: verifies exec bit is set on CLI binaries after a clean build (POSIX only).
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
const IS_WIN32    = process.platform === 'win32';

// ── Static: build script ordering (single pinned-value assertion) ─────────────

describe('execBit — build script content [order coupling]', () => {
  it('build script matches pinned value (clean → tsc → chmod)', () => {
    const build: string = JSON.parse(readFileSync(CLI_PKG_JSON, 'utf8')).scripts.build;
    assert.equal(
      build,
      'rm -rf dist && tsc && chmod +x dist/index.js $(test -f dist/loom-bench.js && echo dist/loom-bench.js)',
      `build script does not match pinned value: "${build}"`
    );
  });
});

// ── Integration: exec bit + runnability (POSIX only) ─────────────────────────

describe('execBit — file mode after clean build [AC1, AC2, AC3]', () => {
  it('[AC1] dist/index.js has owner-executable bit set', { skip: IS_WIN32 }, () => {
    assert.ok(existsSync(DIST_INDEX), 'dist/index.js not found — was the build run?');
    const mode = statSync(DIST_INDEX).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/index.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC1] dist/loom-bench.js has owner-executable bit set', { skip: IS_WIN32 }, () => {
    assert.ok(existsSync(DIST_BENCH), 'dist/loom-bench.js not found — was the build run?');
    const mode = statSync(DIST_BENCH).mode;
    assert.ok(
      (mode & OWNER_EXEC) !== 0,
      `dist/loom-bench.js is missing owner-exec bit (mode 0o${mode.toString(8)})`
    );
  });

  it('[AC2] dist/index.js is directly invokable without manual chmod', { skip: IS_WIN32 }, () => {
    assert.ok(existsSync(DIST_INDEX), 'dist/index.js not found — was the build run?');
    const src = readFileSync(DIST_INDEX, 'utf8');
    assert.ok(src.startsWith('#!'), 'dist/index.js is missing a shebang — AC2 would fail regardless of exec bit');
    const result = spawnSync(DIST_INDEX, ['--version'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(
      result.status,
      0,
      `dist/index.js --version exited ${result.status}: ${result.stderr}`
    );
  });

  it('[AC2] dist/loom-bench.js is directly invokable without manual chmod', { skip: IS_WIN32 }, () => {
    assert.ok(existsSync(DIST_BENCH), 'dist/loom-bench.js not found — was the build run?');
    const src = readFileSync(DIST_BENCH, 'utf8');
    assert.ok(src.startsWith('#!'), 'dist/loom-bench.js is missing a shebang — AC2 would fail regardless of exec bit');
    const result = spawnSync(DIST_BENCH, ['--help'], { encoding: 'utf8', timeout: 5000 });
    assert.ok(
      result.status !== null,
      `dist/loom-bench.js --help was killed by signal or could not start: ${result.stderr}`
    );
  });
});
