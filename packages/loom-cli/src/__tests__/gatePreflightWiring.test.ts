/**
 * Wiring proof for the gate-preflight advisory warning: `loom epic` emits it
 * right after policy load and still proceeds to planning; `loom run` emits it
 * before supervisor.run() and the supervisor still runs. Both are subprocess
 * tests — the non-blocking guarantee is asserted on the real CLI, so this
 * suite goes red if preflight ever gains the power to stop a run.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// Excludes any user-level bin dirs so the `claude` CLI is never found:
// `loom epic` then fails its LLM call *after* the warning, which is exactly
// the boundary we want to observe.
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let tmpDir: string;

function loom(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [LOOM_CLI, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOM_HOME: path.join(tmpDir, '.loom-home'),
      ...env,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-preflight-wiring-'));
  execSync('git init -q', { cwd: tmpDir });
  loom(['init']);
  // Non-viable gate setup: a real test script but no lockfile, so the
  // auto-detected `npm test` cannot run in a bare integration worktree.
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } })
  );
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loom epic — advisory warning at plan time', () => {
  it('warns after policy load and still proceeds to brief refinement', () => {
    const result = loom(
      ['epic', 'Build a small demo feature exercising the preflight warning wiring.'],
      { PATH: BARE_PATH }
    );
    assert.ok(
      result.stderr.includes('WARNING: integration gate command will fail'),
      `expected the advisory warning on stderr, got:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('test_command: "npm ci && npm test"'),
      'warning names the exact test_command to set'
    );
    // Non-blocking proof: the command reached the NEXT phase (brief
    // refinement) after warning. It exits non-zero later only because the
    // claude CLI is unavailable on the bare PATH — not because of preflight.
    assert.ok(
      result.stdout.includes('Refining brief'),
      'epic proceeded past the warning into planning'
    );
  });
});

describe('loom run — advisory warning at run start', () => {
  it('warns before supervisor.run() and the supervisor still runs to completion', () => {
    const result = loom(['run']);
    assert.ok(
      result.stderr.includes('WARNING: integration gate command will fail'),
      `expected the advisory warning on stderr, got:\n${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('test_command: "npm ci && npm test"'),
      'warning names the exact test_command to set'
    );
    // supervisor.run() provably executed: its no-approved-epics result is
    // printed after the run completes.
    assert.ok(
      result.stdout.includes('No approved epics to run'),
      'supervisor.run() was still called after the warning'
    );
    assert.equal(result.status, 0, 'a non-viable preflight must never fail the run');
  });

  it('is silent once the gate command is viable', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');
    const result = loom(['run']);
    fs.rmSync(path.join(tmpDir, 'package-lock.json'));
    assert.ok(
      !result.stderr.includes('WARNING: integration gate command will fail'),
      'no warning when the preflight is viable'
    );
    assert.equal(result.status, 0);
  });
});
