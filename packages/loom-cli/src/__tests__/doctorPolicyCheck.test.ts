import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PolicySchema,
  describePolicyIssues,
  formatPolicyError,
} from '@loom-ai/core';
import { policyValidationCheck } from '../commands/doctor.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

const INVALID_POLICY_YAML = 'agents:\n  review_strategy: loud\n';
const VALID_POLICY_YAML = 'agents:\n  review_strategy: off\n';

function capture(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [LOOM_CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOOM_HOME: path.join(cwd, '.loom-home') },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

// ── Unit tests for policyValidationCheck ─────────────────────────────────────

describe('policyValidationCheck', () => {
  let tmpDir: string;
  let loomDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-policy-check-'));
    loomDir = path.join(tmpDir, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a check named "policy"', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), VALID_POLICY_YAML);
    const check = policyValidationCheck(tmpDir);
    assert.equal(check.name, 'policy');
  });

  it('valid policy → ok:true, required:true', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), VALID_POLICY_YAML);
    const check = policyValidationCheck(tmpDir);
    assert.equal(check.ok, true);
    assert.equal(check.required, true);
  });

  it('invalid knob → ok:false, required:true', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), INVALID_POLICY_YAML);
    const check = policyValidationCheck(tmpDir);
    assert.equal(check.ok, false);
    assert.equal(check.required, true);
  });

  it('invalid knob → detail equals the shared renderer output (FR-4/ADR-2 no-drift)', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), INVALID_POLICY_YAML);
    const check = policyValidationCheck(tmpDir);

    // Build the expected detail via the same renderer path used by the load boundary
    const result = PolicySchema.safeParse({ agents: { review_strategy: 'loud' } });
    assert.equal(result.success, false);
    const issues = describePolicyIssues(result.error!);
    const expectedDetail = formatPolicyError(
      path.join(loomDir, 'policy.yaml'),
      issues
    );

    assert.equal(
      check.detail,
      expectedDetail,
      'detail must equal the renderer output — no-drift guard'
    );
  });

  it('invalid knob → detail carries the field path and allowed-values text', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), INVALID_POLICY_YAML);
    const check = policyValidationCheck(tmpDir);
    assert.ok(
      check.detail.includes('agents.review_strategy'),
      'detail must include the field path'
    );
    assert.ok(check.detail.includes('one of:'), 'detail must include allowed-values constraint');
  });

  it('no-crash guard: invalid policy does not escape policyValidationCheck as an exception', () => {
    fs.writeFileSync(path.join(loomDir, 'policy.yaml'), INVALID_POLICY_YAML);
    let check: ReturnType<typeof policyValidationCheck> | undefined;
    assert.doesNotThrow(() => {
      check = policyValidationCheck(tmpDir);
    }, 'policyValidationCheck must not rethrow a validation error');
    assert.ok(check, 'policyValidationCheck must return a Check object');
    assert.equal(check!.ok, false);
  });
});

// ── Subprocess / exit-code tests ──────────────────────────────────────────────

describe('loom doctor — policy check (subprocess)', () => {
  let repoDir: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-doctor-policy-cli-'));
    fs.mkdirSync(path.join(repoDir, '.loom'), { recursive: true });
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('exits 1 when policy.yaml has an invalid knob (required check fails)', () => {
    fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), INVALID_POLICY_YAML);
    const result = capture(['doctor'], repoDir);
    assert.equal(result.status, 1, 'loom doctor must exit 1 when policy is invalid');
  });

  it('exits 0 when policy.yaml is valid', () => {
    fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), VALID_POLICY_YAML);
    const result = capture(['doctor'], repoDir);
    assert.equal(result.status, 0, 'loom doctor must exit 0 when policy is valid');
  });

  it('renders a [FAIL] policy line when invalid knob present', () => {
    fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), INVALID_POLICY_YAML);
    const result = capture(['doctor'], repoDir);
    const line = result.stdout.split('\n').find((l) => l.includes('] policy:'));
    assert.ok(line, 'doctor output must include a policy check line');
    assert.ok(line!.includes('[FAIL]'), `expected [FAIL] in policy line, got: ${line}`);
  });

  it('renders an [ok  ] policy line when policy is valid', () => {
    fs.writeFileSync(path.join(repoDir, '.loom', 'policy.yaml'), VALID_POLICY_YAML);
    const result = capture(['doctor'], repoDir);
    const line = result.stdout.split('\n').find((l) => l.includes('] policy:'));
    assert.ok(line, 'doctor output must include a policy check line');
    assert.ok(line!.includes('[ok  ]'), `expected [ok  ] in policy line, got: ${line}`);
  });
});
