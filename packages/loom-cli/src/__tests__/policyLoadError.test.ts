// Tests for story-011-002: friendly policy validation error at the shared load path.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyEngine, PolicyValidationError } from '@loom-ai/core';
import { handleTopLevelError } from '../errorHandling.js';

// ── helpers ──────────────────────────────────────────────────────────────────

interface Captured {
  stderrLines: string[];
  exitCode: number | null;
}

/** Intercepts stderr writes and process.exit; runs synchronously. */
function capture(fn: () => void): Captured {
  const origExit = process.exit as (code?: number) => never;
  const origWrite = process.stderr.write.bind(process.stderr);
  const stderrLines: string[] = [];
  let exitCode: number | null = null;

  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    stderrLines.push(String(chunk));
    // Forward encoding/callback so callers that rely on write-completion don't hang.
    const writeCb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    writeCb?.();
    return true;
  };

  try {
    fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    process.stderr.write = origWrite;
  }

  return { stderrLines, exitCode };
}

/** Write an invalid policy.yaml with a bad llm_backend into a temp loomdir. */
function makeInvalidLoomDir(tmpDir: string): string {
  const loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  fs.writeFileSync(
    path.join(loomDir, 'policy.yaml'),
    'agents:\n  llm_backend: invalid-backend\n'
  );
  return loomDir;
}

// ─── PolicyEngine.load unit tests ────────────────────────────────────────────

describe('PolicyEngine.load — invalid policy', () => {
  let tmpDir: string;
  let loomDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-policy-load-'));
    loomDir = makeInvalidLoomDir(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws PolicyValidationError (not a raw ZodError) for an invalid llm_backend value', () => {
    let thrown: unknown;
    try {
      PolicyEngine.load(loomDir);
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown !== undefined, 'expected an error to be thrown');
    assert.ok(
      thrown instanceof PolicyValidationError,
      `expected PolicyValidationError, got ${(thrown as Error)?.constructor?.name}`
    );
  });

  it('error name is PolicyValidationError (not ZodError)', () => {
    try {
      PolicyEngine.load(loomDir);
      assert.fail('expected PolicyEngine.load to throw');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.equal((e as Error).name, 'PolicyValidationError');
    }
  });

  it('security-model guard: invalid policy never produces a usable engine', () => {
    let engine: PolicyEngine | undefined;
    try {
      engine = PolicyEngine.load(loomDir);
    } catch {
      // expected
    }
    assert.equal(engine, undefined, 'no PolicyEngine must be returned for an invalid policy');
  });

  it('thrown error carries the policyPath and structured issues', () => {
    try {
      PolicyEngine.load(loomDir);
      assert.fail('expected PolicyEngine.load to throw');
    } catch (e) {
      assert.ok(e instanceof PolicyValidationError);
      assert.ok(e.policyPath.endsWith('policy.yaml'));
      assert.ok(e.issues.length > 0, 'at least one structured issue');
      const issue = e.issues.find((i) => i.fieldPath.includes('llm_backend'));
      assert.ok(issue, 'expected an issue for llm_backend');
      assert.equal(issue.received, 'invalid-backend');
      assert.match(issue.constraint, /one of:/);
    }
  });

  it('message contains the FR-1 structured fields', () => {
    try {
      PolicyEngine.load(loomDir);
      assert.fail('expected PolicyEngine.load to throw');
    } catch (e) {
      assert.ok(e instanceof PolicyValidationError);
      assert.match(e.message, /policy\.yaml/);
      assert.match(e.message, /agents\.llm_backend/);
      assert.match(e.message, /invalid-backend/);
      assert.match(e.message, /one of:/);
    }
  });
});

describe('PolicyEngine.load — valid policy (regression)', () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-policy-valid-'));
    const loomDir = path.join(tmpDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(
      path.join(loomDir, 'policy.yaml'),
      'agents:\n  review_strategy: comment\n'
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a PolicyEngine for a valid policy', () => {
    const loomDir = path.join(tmpDir, '.loom');
    const engine = PolicyEngine.load(loomDir);
    assert.ok(engine instanceof PolicyEngine);
  });

  it('valid policy max_concurrent is accessible (review_strategy baked-removed)', () => {
    // review_strategy was a baked field removed in story-094-003; verify the policy
    // still loads and a surviving field is readable.
    const loomDir = path.join(tmpDir, '.loom');
    const engine = PolicyEngine.load(loomDir);
    assert.equal(engine.policyData.agents.max_concurrent, 5);
  });
});

// ─── handleTopLevelError boundary tests ─────────────────────────────────────

describe('handleTopLevelError — PolicyValidationError', () => {
  let tmpDir: string;
  let loomDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hte-policy-'));
    loomDir = makeInvalidLoomDir(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePolicyError(): PolicyValidationError {
    try {
      PolicyEngine.load(loomDir);
      throw new Error('expected PolicyEngine.load to throw');
    } catch (e) {
      if (e instanceof PolicyValidationError) return e;
      throw e;
    }
  }

  it('exits 1 for a PolicyValidationError', () => {
    const err = makePolicyError();
    const { exitCode } = capture(() => handleTopLevelError(err));
    assert.equal(exitCode, 1);
  });

  it('writes err.message to stderr', () => {
    const err = makePolicyError();
    const { stderrLines } = capture(() => handleTopLevelError(err));
    const combined = stderrLines.join('');
    assert.match(combined, /policy\.yaml/);
  });

  it('stderr contains the FR-1 structured fields (field, received, constraint, hint)', () => {
    const err = makePolicyError();
    const { stderrLines } = capture(() => handleTopLevelError(err));
    const combined = stderrLines.join('');
    assert.match(combined, /agents\.llm_backend/, 'field path in stderr');
    assert.match(combined, /invalid-backend/, 'received value in stderr');
    assert.match(combined, /one of:/, 'constraint in stderr');
  });

  it('stderr contains NO stack frames (no "at " lines)', () => {
    const err = makePolicyError();
    const { stderrLines } = capture(() => handleTopLevelError(err));
    const combined = stderrLines.join('');
    const hasStackFrame = /^\s+at /m.test(combined);
    assert.equal(hasStackFrame, false, `stderr must not contain stack frames; got:\n${combined}`);
  });

  it('stderr contains no "node:internal" references', () => {
    const err = makePolicyError();
    const { stderrLines } = capture(() => handleTopLevelError(err));
    const combined = stderrLines.join('');
    assert.ok(!combined.includes('node:internal'), 'no node:internal in stderr');
  });
});

describe('handleTopLevelError — non-policy error rethrows (Philosophy #3 / ADR-1)', () => {
  it('rethrows a generic Error unchanged', () => {
    const boom = new Error('unexpected boom');
    assert.throws(
      () => handleTopLevelError(boom),
      (thrown: unknown) => thrown === boom
    );
  });

  it('preserves the stack on rethrow', () => {
    const boom = new Error('stack preserved');
    let caughtStack: string | undefined;
    try {
      handleTopLevelError(boom);
    } catch (e) {
      caughtStack = (e as Error).stack;
    }
    assert.ok(caughtStack, 'stack should be present');
    assert.ok(caughtStack!.includes('stack preserved'), 'original message in stack');
  });

  it('does not call process.exit for a non-policy error', () => {
    const origExit = process.exit;
    let exitCalled = false;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = () => {
      exitCalled = true;
      throw new Error('exit called unexpectedly');
    };
    try {
      handleTopLevelError(new TypeError('not a policy error'));
    } catch {
      // expected rethrow
    } finally {
      (process as NodeJS.Process & { exit: (code?: number) => never }).exit =
        origExit as (code?: number) => never;
    }
    assert.equal(exitCalled, false, 'process.exit must NOT be called for non-policy errors');
  });
});

// ─── Cross-command proof (subprocess) ────────────────────────────────────────

describe('cross-command proof — invalid policy emits friendly message via ≥2 commands', () => {
  const LOOM_CLI = path.resolve(__dirname, '../index.js');
  let tmpDir: string;

  function runLoom(args: string): { stdout: string; stderr: string; status: number } {
    try {
      const stdout = execSync(`node "${LOOM_CLI}" ${args}`, {
        cwd: tmpDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home') },
      });
      return { stdout, stderr: '', status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
    }
  }

  before(function (this: { skip: () => void }) {
    if (!fs.existsSync(LOOM_CLI)) {
      this.skip();
      return;
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cross-cmd-'));
    // Initialize git (required by some commands) and create invalid policy
    execSync('git init -q', { cwd: tmpDir });
    makeInvalidLoomDir(tmpDir);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('guard check: exits non-zero and emits friendly message for invalid policy', () => {
    const result = runLoom('guard check --command "git add ."');
    assert.notEqual(result.status, 0, 'guard check must exit non-zero for invalid policy');
    assert.match(result.stderr, /policy\.yaml/, 'stderr contains policy.yaml reference');
    assert.match(result.stderr, /llm_backend/, 'stderr contains field path');
    assert.match(result.stderr, /one of:/, 'stderr contains constraint');
    // No stack frames
    assert.ok(!/^\s+at /m.test(result.stderr), 'stderr must not contain stack frames');
  });

  it('run: exits non-zero and emits friendly message for invalid policy', () => {
    const result = runLoom('run');
    assert.notEqual(result.status, 0, 'run must exit non-zero for invalid policy');
    assert.match(result.stderr, /policy\.yaml/, 'stderr contains policy.yaml reference');
    assert.match(result.stderr, /llm_backend/, 'stderr contains field path');
    assert.match(result.stderr, /one of:/, 'stderr contains constraint');
    // No stack frames
    assert.ok(!/^\s+at /m.test(result.stderr), 'stderr must not contain stack frames');
  });

  it('both commands produce the same friendly message structure', () => {
    const guardResult = runLoom('guard check --command "git add ."');
    const runResult = runLoom('run');

    // Both must contain the same key FR-1 elements
    for (const result of [guardResult, runResult]) {
      assert.match(result.stderr, /Policy validation failed/, 'FR-1 header present');
      assert.match(result.stderr, /Field:/, 'Field line present');
      assert.match(result.stderr, /Received:/, 'Received line present');
      assert.match(result.stderr, /Constraint:/, 'Constraint line present');
      assert.match(result.stderr, /Fix:/, 'Fix hint present');
    }
  });
});
