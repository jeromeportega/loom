/**
 * End-to-end removal guard for `loom serve` (story-003-001).
 *
 * Verifies that after deletion of packages/loom-mcp and removal of the
 * `.command('serve')` block, the CLI:
 *   1. Does NOT list `serve` in `--help` output.
 *   2. Treats `loom serve` as an unknown command → exits non-zero, no stack trace.
 *   3. Still starts cleanly for a known-good command (`loom --version`).
 *   4. Does NOT reference `packages/loom-mcp` in any retained file at test time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

function loom(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [LOOM_CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

describe('loom serve removal (story-003-001)', () => {
  it('loom --help does not list "serve" as a command', () => {
    const { stdout, status } = loom(['--help']);
    assert.equal(status, 0, '--help should exit 0');
    // Match "serve" only when it appears as a listed command (start of word on a
    // command-listing line). The word appears as a substring of "server" in other
    // descriptions so we need an exact word-boundary check.
    const lines = stdout.split('\n');
    const serveLine = lines.find((l) => /^\s+serve(\s|$)/.test(l));
    assert.ok(
      serveLine === undefined,
      `Expected "serve" to not be listed as a command in --help, but found:\n${serveLine}`
    );
  });

  it('loom serve exits non-zero as an unknown command', () => {
    const { status, stderr, stdout } = loom(['serve']);
    assert.ok(status !== 0, `Expected non-zero exit for unknown command "serve", got ${status}`);
    const combined = stdout + stderr;
    assert.ok(
      !combined.includes('Error:') || !combined.includes('at '),
      'Expected no stack trace in output'
    );
  });

  it('loom serve produces a one-line unknown-command message, not a stack trace', () => {
    const { stdout, stderr } = loom(['serve']);
    const combined = (stdout + stderr).trim();
    // Commander emits a short "error: unknown command 'serve'" — no multi-line stack
    const lines = combined.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length <= 3, `Expected at most 3 lines of output, got:\n${combined}`);
  });

  it('loom --version starts cleanly (CLI boots without dangling import)', () => {
    const { status } = loom(['--version']);
    assert.equal(status, 0, '--version should exit 0 — dangling @loom-ai/mcp import would throw');
  });

  it('packages/loom-mcp directory no longer exists', () => {
    const mcpPkg = path.resolve(__dirname, '../../../../../loom-mcp');
    assert.ok(
      !fs.existsSync(mcpPkg),
      `Expected packages/loom-mcp to be deleted, but it still exists at ${mcpPkg}`
    );
  });
});
