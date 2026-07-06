// Tests for story-075-005: scope the read-scope guard to worker sessions only.
//
// Unit tests for isWorkerContext and integration tests for the operator
// pass-through / worker enforcement split.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');

// Import isWorkerContext directly for unit testing.
// Resolved against the compiled dist output.
import { isWorkerContext } from '../commands/guard.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;      // initialized git + loom project
let worktreesDir: string; // <tmpDir>/.loom/worktrees
let worktreePath: string; // <tmpDir>/.loom/worktrees/story-001
let outsidePath: string;  // a real path outside tmpDir

function hookPayload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wc-integ-')));
  worktreesDir = path.join(tmpDir, '.loom', 'worktrees');
  worktreePath = path.join(worktreesDir, 'story-001');

  // Initialize a git repo + loom project so PolicyEngine.load works from tmpDir.
  execSync('git init -q', { cwd: tmpDir });
  execSync('git config user.email "test@loom.dev"', { cwd: tmpDir });
  execSync('git config user.name "Loom Test"', { cwd: tmpDir });
  execSync('git config commit.gpgsign false', { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execSync('git add .', { cwd: tmpDir });
  execSync('git commit -q -m "initial"', { cwd: tmpDir });
  execSync(`node "${LOOM_CLI}" init`, {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home') },
  });

  // Create the worktrees dir and a fake worker worktree directory.
  // (Not a real git worktree — just a directory under .loom/worktrees/ so
  // the cwd-based worker-context detection works during integration tests.)
  fs.mkdirSync(worktreePath, { recursive: true });

  // Create a minimal .loom/ in the fake worktree so PolicyEngine.load() succeeds
  // when the hook runs with cwd=worktreePath. Without it, load() throws and the
  // hook exits 0 (allowed) instead of enforcing scope.
  const worktreeLoomDir = path.join(worktreePath, '.loom');
  fs.mkdirSync(worktreeLoomDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeLoomDir, 'policy.yaml'), '{}\n');

  // outsidePath is a real absolute path that lives outside tmpDir.
  // Resolve symlinks (macOS /tmp → /private/tmp) to match realpathSync comparisons.
  outsidePath = fs.realpathSync(os.tmpdir());
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Unit tests: isWorkerContext ─────────────────────────────────────────────

describe('isWorkerContext — unit', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    delete process.env['LOOM_WORKER_CONTEXT'];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env['LOOM_WORKER_CONTEXT'];
  });

  it('returns true when cwd is directly under .loom/worktrees (primary cwd check)', () => {
    process.chdir(worktreePath);
    assert.equal(isWorkerContext(worktreesDir), true, 'cwd under worktrees dir must be detected as worker context');
  });

  it('returns false when cwd is the repo root and LOOM_WORKER_CONTEXT is unset', () => {
    process.chdir(tmpDir);
    assert.equal(isWorkerContext(worktreesDir), false, 'repo root without env marker must not be worker context');
  });

  it('returns true when LOOM_WORKER_CONTEXT=1 even though cwd is the repo root (env marker)', () => {
    process.chdir(tmpDir);
    process.env['LOOM_WORKER_CONTEXT'] = '1';
    assert.equal(isWorkerContext(worktreesDir), true, 'env marker must trigger worker context');
  });

  it('returns true via cwd check regardless of LOOM_WORKER_CONTEXT value when cwd is under worktrees', () => {
    process.chdir(worktreePath);
    process.env['LOOM_WORKER_CONTEXT'] = '0';
    assert.equal(isWorkerContext(worktreesDir), true, 'cwd check wins over env value of 0');
  });

  it('returns false when cwd is under .loom/integration (not .loom/worktrees)', () => {
    const integrationPath = path.join(tmpDir, '.loom', 'integration', 'epic-001');
    fs.mkdirSync(integrationPath, { recursive: true });
    process.chdir(integrationPath);
    assert.equal(isWorkerContext(worktreesDir), false, 'integration worktrees are not worker contexts');
    // cleanup: remove the integration dir (worktreesDir was already created in before())
    fs.rmSync(path.join(tmpDir, '.loom', 'integration'), { recursive: true, force: true });
  });

  it('returns true when cwd is under a symlink that resolves into the worktrees dir', () => {
    const symlinkBase = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wc-sym-'));
    const linkPath = path.join(symlinkBase, 'link-to-story');
    fs.symlinkSync(worktreePath, linkPath);
    try {
      process.chdir(linkPath);
      assert.equal(isWorkerContext(worktreesDir), true, 'symlink that resolves into worktrees dir must be detected');
    } finally {
      fs.rmSync(symlinkBase, { recursive: true, force: true });
    }
  });

  it('returns false when worktreesDir does not exist (handles missing worktrees gracefully)', () => {
    process.chdir(tmpDir);
    const nonExistentWorktreesDir = path.join(tmpDir, '.loom', 'worktrees-nonexistent');
    assert.equal(isWorkerContext(nonExistentWorktreesDir), false, 'missing worktrees dir must not throw and must return false');
  });
});

// ─── Integration tests: runGuardHook early-exit ───────────────────────────────

/** Run the hook with configurable cwd and env. */
function runHookAs(
  payload: string,
  cwd: string,
  extraEnv: Record<string, string> = {}
): { status: number; stderr: string } {
  const result = spawnSync('node', [LOOM_CLI, 'guard', 'hook'], {
    input: payload,
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOOM_HOME: path.join(tmpDir, '.loom-home'),
      ...extraEnv,
    },
  });
  return { status: result.status ?? 1, stderr: result.stderr ?? '' };
}

describe('guard hook — operator session pass-through', () => {
  it('allows Read outside project root when session is operator (no LOOM_WORKER_CONTEXT, cwd = project root)', () => {
    const payload = hookPayload('Read', { file_path: path.join(outsidePath, 'secret.txt') });
    // Operator: cwd = project root, LOOM_WORKER_CONTEXT unset
    const { status } = runHookAs(payload, tmpDir);
    assert.equal(status, 0, 'operator session must pass through unconditionally (exit 0)');
  });

  it('allows any Read in operator session even with a restrictive policy in place', () => {
    // The existing loom init creates a default policy. Even without any policy
    // customization, reading outside the project root would be blocked in worker
    // mode. In operator mode it must pass through regardless.
    const payload = hookPayload('Read', { file_path: '/etc/passwd' });
    const { status } = runHookAs(payload, tmpDir);
    assert.equal(status, 0, 'operator session is unrestricted');
  });
});

describe('guard hook — worker session via cwd under .loom/worktrees', () => {
  it('allows Read inside worktree root when cwd is the worktree (exit 0)', () => {
    // Write a file inside the worktree to make the path concrete.
    const inScopeFile = path.join(worktreePath, 'README.md');
    fs.writeFileSync(inScopeFile, '# worker\n');
    const payload = hookPayload('Read', { file_path: inScopeFile });
    // Worker: cwd = worktreePath (under .loom/worktrees)
    const { status } = runHookAs(payload, worktreePath);
    assert.equal(status, 0, 'read inside worktree root must be allowed');
  });

  it('blocks Read outside worktree root when cwd is the worktree (exit 2)', () => {
    const payload = hookPayload('Read', { file_path: path.join(outsidePath, 'secret.txt') });
    const { status, stderr } = runHookAs(payload, worktreePath);
    assert.equal(status, 2, 'read outside worktree root must be blocked with feedback');
    const body = JSON.parse(stderr.trim());
    assert.equal(body.loom_guard, 'blocked');
  });
});

describe('guard hook — worker session via LOOM_WORKER_CONTEXT env marker', () => {
  it('blocks Read outside cwd scope when LOOM_WORKER_CONTEXT=1 and cwd is project root (exit 2)', () => {
    const payload = hookPayload('Read', { file_path: path.join(outsidePath, 'secret.txt') });
    // Worker via env marker: cwd = project root but env marker signals worker context
    const { status } = runHookAs(payload, tmpDir, { LOOM_WORKER_CONTEXT: '1' });
    assert.equal(status, 2, 'env-marker worker session must enforce read scope (exit 2)');
  });

  it('allows Read within cwd scope when LOOM_WORKER_CONTEXT=1 (exit 0)', () => {
    const inScopeFile = path.join(tmpDir, 'README.md');
    const payload = hookPayload('Read', { file_path: inScopeFile });
    const { status } = runHookAs(payload, tmpDir, { LOOM_WORKER_CONTEXT: '1' });
    assert.equal(status, 0, 'in-scope read in env-marker worker session must be allowed');
  });
});
