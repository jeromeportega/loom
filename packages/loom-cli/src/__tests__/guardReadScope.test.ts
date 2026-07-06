// Tests for story-067-003: guard hook dispatch for Read/Grep/Glob native tools
// and Bash read-scope enforcement. These tests prove the non-Bash short-circuit
// is gone and that the new dispatch routes are correct.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;   // initialized loom + git repo (worktreeRoot in the hook)
let outsidePath: string; // a real absolute path outside tmpDir

function hookPayload(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

/** Pipe a JSON payload to `loom guard hook` via stdin and return the result. */
function runHook(payload: string): { status: number; stderr: string } {
  const result = spawnSync('node', [LOOM_CLI, 'guard', 'hook'], {
    input: payload,
    cwd: tmpDir,
    encoding: 'utf8',
    // LOOM_WORKER_CONTEXT=1 simulates a worker session so the read-scope guard
    // is active. Without this, an operator early-exit would allow everything.
    env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home'), LOOM_WORKER_CONTEXT: '1' },
  });
  const raw = result.stderr ?? '';
  // Extract the JSON blocking message from stderr, skipping advisory lines from
  // loadEnvLayer. In the worktree build environment, @loom-ai/core resolves to
  // the main repo's dist (pre-envLayer fix), so LOOM_WORKER_CONTEXT triggers a
  // warning line before the JSON. Find the first JSON object line.
  const stderr = raw.split('\n').find(l => l.trimStart().startsWith('{')) ?? raw.trim();
  return { status: result.status ?? 1, stderr };
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-guard-read-scope-')));
  // Need a git repo so prepareRepoState (in openProjectDatabase) can determine
  // the slug. We init, add a commit, and run loom init.
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
  // Resolve symlinks (on macOS /tmp → /private/tmp) so path comparisons inside
  // the hook's realpathSync-based containment check match what we pass here.
  outsidePath = fs.realpathSync(os.tmpdir());
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Read / Grep / Glob dispatch (non-Bash early-return is GONE) ───────────

describe('guard hook — Read tool', () => {
  it('blocks an out-of-scope file_path (exit 2 with feedback)', () => {
    const payload = hookPayload('Read', { file_path: path.join(outsidePath, 'secret.txt') });
    const { status, stderr } = runHook(payload);
    assert.equal(status, 2, 'should exit 2 for out-of-scope Read');
    const body = JSON.parse(stderr.trim());
    assert.equal(body.loom_guard, 'blocked');
    assert.equal(body.rule, 'filesystem.allowed_read_root');
  });

  it('allows an in-scope absolute path (exit 0)', () => {
    const payload = hookPayload('Read', { file_path: path.join(tmpDir, 'README.md') });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'should exit 0 for in-scope Read');
  });

  it('allows an empty file_path (cwd = in-scope, exit 0)', () => {
    const payload = hookPayload('Read', { file_path: '' });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'empty path resolves to cwd which is in-scope');
  });

  it('allows a missing file_path key (exit 0)', () => {
    const payload = hookPayload('Read', {});
    const { status } = runHook(payload);
    assert.equal(status, 0, 'missing path resolves to cwd which is in-scope');
  });
});

describe('guard hook — Grep tool', () => {
  it('blocks an out-of-scope path (exit 2)', () => {
    const payload = hookPayload('Grep', { path: path.join(outsidePath, 'file.txt') });
    const { status, stderr } = runHook(payload);
    assert.equal(status, 2, 'should exit 2 for out-of-scope Grep');
    const body = JSON.parse(stderr.trim());
    assert.equal(body.loom_guard, 'blocked');
  });

  it('allows an in-scope path (exit 0)', () => {
    const payload = hookPayload('Grep', { path: tmpDir });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'in-scope Grep should be allowed');
  });

  it('allows missing path (exit 0, treats as cwd)', () => {
    const payload = hookPayload('Grep', { pattern: 'foo' });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'missing path = cwd = in-scope');
  });
});

describe('guard hook — Glob tool', () => {
  it('blocks an out-of-scope path (exit 2)', () => {
    const payload = hookPayload('Glob', { path: path.join(outsidePath, '**/*.ts') });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'should exit 2 for out-of-scope Glob');
  });

  it('allows an in-scope path (exit 0)', () => {
    const payload = hookPayload('Glob', { path: path.join(tmpDir, '**/*.ts') });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'in-scope Glob should be allowed');
  });
});

// ─── Parent-traversal (../–escaping) tests ───────────────────────────────

describe('guard hook — parent-traversal (../–escaping) paths', () => {
  it('blocks Read with a ../–escaping file_path (exit 2)', () => {
    // path.join resolves the traversal: tmpDir + /../../etc/passwd → /etc/passwd
    const escapingPath = path.join(tmpDir, '../../etc/passwd');
    const payload = hookPayload('Read', { file_path: escapingPath });
    const { status, stderr } = runHook(payload);
    assert.equal(status, 2, 'Read with ../–escaping path should exit 2');
    const body = JSON.parse(stderr.trim());
    assert.equal(body.loom_guard, 'blocked');
  });

  it('blocks Bash cat with a ../–escaping path (exit 2)', () => {
    const escapingPath = path.join(tmpDir, '../../etc/passwd');
    const payload = hookPayload('Bash', { command: `cat "${escapingPath}"` });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'cat with ../–escaping path should exit 2');
  });

  it('blocks Bash grep with a ../–escaping path (exit 2)', () => {
    const escapingPath = path.join(tmpDir, '../../etc/passwd');
    const payload = hookPayload('Bash', { command: `grep pattern "${escapingPath}"` });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'grep with ../–escaping path should exit 2');
  });
});

// ─── Bash dispatch — read-scope appended after write/git checks ────────────

describe('guard hook — Bash read-scope (grep/rg/find/cat/ls)', () => {
  it('blocks grep against an out-of-scope absolute path (exit 2)', () => {
    const cmd = `grep pattern "${path.join(outsidePath, 'file.txt')}"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'grep to out-of-scope path should exit 2');
  });

  it('blocks rg against an out-of-scope absolute path (exit 2)', () => {
    const cmd = `rg pattern "${path.join(outsidePath, 'file.txt')}"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'rg to out-of-scope path should exit 2');
  });

  it('blocks find against an out-of-scope absolute path (exit 2)', () => {
    const cmd = `find "${path.join(outsidePath, 'secret')}" -name "*.ts"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'find to out-of-scope path should exit 2');
  });

  it('blocks cat against an out-of-scope absolute path (exit 2)', () => {
    const cmd = `cat "${path.join(outsidePath, 'file.txt')}"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'cat to out-of-scope path should exit 2');
  });

  it('blocks ls against an out-of-scope absolute path (exit 2)', () => {
    const cmd = `ls "${outsidePath}/some-other-dir"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'ls to out-of-scope path should exit 2');
  });

  it('allows grep against an in-scope absolute path (exit 0)', () => {
    const cmd = `grep pattern "${tmpDir}"`;
    const payload = hookPayload('Bash', { command: cmd });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'grep in-scope path should be allowed');
  });

  it('still blocks write/git commands (no regression from read-scope check)', () => {
    const payload = hookPayload('Bash', { command: 'git push --force' });
    const { status } = runHook(payload);
    assert.equal(status, 2, 'force push should still be blocked by existing write check');
  });
});

// ─── Other tools are allowed through ─────────────────────────────────────

describe('guard hook — other tools', () => {
  // Write scope enforcement (out-of-worktree writes) is covered by the existing
  // policy engine write-guard (PolicyEngine.check / evaluateCommand), not by the
  // read-scope hook. This test only verifies that Write is not double-intercepted
  // by the read-scope dispatch added in story-067-003.
  it('allows a non-intercepted tool (e.g. Write) without prompts (exit 0)', () => {
    // Use a neutral non-existent path; /etc/passwd should not appear in test fixtures.
    const payload = hookPayload('Write', { file_path: '/tmp/loom-test-non-existent', content: 'test' });
    const { status } = runHook(payload);
    assert.equal(status, 0, 'Write tool is not intercepted by the read-scope hook');
  });
});
