import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicySchema } from '../../src/types.js';
import {
  describePolicyIssues,
  formatPolicyError,
  PolicyValidationError,
} from '../../src/guardrails/policyError.js';
import type { PolicyIssue } from '../../src/guardrails/policyError.js';
import { ZodError } from 'zod';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse a bad policy object and return the resulting ZodError (real issue shapes). */
function parseError(bad: unknown): ZodError {
  const result = PolicySchema.safeParse(bad);
  assert.equal(result.success, false, 'expected a validation failure');
  return result.error;
}

// ── describePolicyIssues ─────────────────────────────────────────────────────

describe('describePolicyIssues', () => {
  it('enum violation: bad review_strategy yields a PolicyIssue with correct fields', () => {
    const err = parseError({ agents: { review_strategy: 'loud' } });
    const issues = describePolicyIssues(err);

    const issue = issues.find((i: PolicyIssue) => i.fieldPath === 'agents.review_strategy');
    assert.ok(issue, 'expected an issue for agents.review_strategy');
    assert.equal(issue.received, 'loud');
    assert.match(issue.constraint, /one of:/);
    assert.match(issue.constraint, /off/);
    assert.match(issue.constraint, /comment/);
    assert.match(issue.constraint, /block-and-revise/);
    assert.ok(issue.hint.length > 0, 'hint must be non-empty');
  });

  it('bound violation: too_small on max_concurrent renders the bound', () => {
    // max_concurrent has min(1).max(10)
    const err = parseError({ agents: { max_concurrent: 0 } });
    const issues = describePolicyIssues(err);

    const issue = issues.find((i: PolicyIssue) => i.fieldPath === 'agents.max_concurrent');
    assert.ok(issue, 'expected an issue for agents.max_concurrent');
    assert.match(issue.constraint, /1/);
    assert.ok(issue.hint.length > 0, 'hint must be non-empty');
  });

  it('bound violation: too_big on max_concurrent renders the bound', () => {
    const err = parseError({ agents: { max_concurrent: 99 } });
    const issues = describePolicyIssues(err);

    const issue = issues.find((i: PolicyIssue) => i.fieldPath === 'agents.max_concurrent');
    assert.ok(issue, 'expected an issue for agents.max_concurrent');
    assert.match(issue.constraint, /10/);
    assert.ok(issue.hint.length > 0, 'hint must be non-empty');
  });

  it('multiple issues: returns one PolicyIssue per ZodError issue', () => {
    const err = parseError({
      agents: { review_strategy: 'loud', max_concurrent: 0 },
    });
    const issues = describePolicyIssues(err);
    assert.ok(issues.length >= 2, `expected ≥2 issues, got ${issues.length}`);
  });
});

// ── formatPolicyError ────────────────────────────────────────────────────────

describe('formatPolicyError', () => {
  it('contains all five FR-1 elements: policy path, field path, received, constraint, hint', () => {
    const err = parseError({ agents: { review_strategy: 'loud' } });
    const issues = describePolicyIssues(err);
    const msg = formatPolicyError('/project/.loom/policy.yaml', issues);

    assert.match(msg, /\/project\/.loom\/policy\.yaml/, 'policy file path');
    assert.match(msg, /agents\.review_strategy/, 'field path');
    assert.match(msg, /loud/, 'received value');
    assert.match(msg, /one of:/, 'constraint / allowed values');
    assert.match(msg, /Fix:|Set /, 'fix hint');
  });

  it('single-issue error renders cleanly with all elements', () => {
    const err = parseError({ agents: { max_concurrent: 0 } });
    const issues = describePolicyIssues(err);
    const msg = formatPolicyError('/a/policy.yaml', issues);

    assert.match(msg, /\/a\/policy\.yaml/);
    assert.match(msg, /agents\.max_concurrent/);
    assert.match(msg, /Constraint:/);
    assert.match(msg, /Fix:/);
  });

  it('multiple issues: all issues appear in the output (FR-9)', () => {
    const err = parseError({
      agents: { review_strategy: 'loud', max_concurrent: 0 },
    });
    const issues = describePolicyIssues(err);
    assert.ok(issues.length >= 2);
    const msg = formatPolicyError('/p/policy.yaml', issues);

    assert.match(msg, /review_strategy/, 'first issue present');
    assert.match(msg, /max_concurrent/, 'second issue present');
  });
});

// ── PolicyValidationError ─────────────────────────────────────────────────────

describe('PolicyValidationError', () => {
  it('carries policyPath and structured issues', () => {
    const err = parseError({ agents: { review_strategy: 'loud' } });
    const issues = describePolicyIssues(err);
    const pve = new PolicyValidationError('/my/policy.yaml', issues);

    assert.equal(pve.policyPath, '/my/policy.yaml');
    assert.deepEqual(pve.issues, issues);
    assert.ok(pve instanceof Error);
    assert.ok(pve instanceof PolicyValidationError);
  });

  it('.message equals formatPolicyError(policyPath, issues)', () => {
    const err = parseError({ agents: { review_strategy: 'loud' } });
    const issues = describePolicyIssues(err);
    const pve = new PolicyValidationError('/my/policy.yaml', issues);

    assert.equal(pve.message, formatPolicyError('/my/policy.yaml', issues));
  });

  it('message contains field path and received value', () => {
    const err = parseError({ agents: { review_strategy: 'loud' } });
    const issues = describePolicyIssues(err);
    const pve = new PolicyValidationError('/project/.loom/policy.yaml', issues);

    assert.match(pve.message, /agents\.review_strategy/);
    assert.match(pve.message, /loud/);
  });
});

// ── No-new-validation guard ───────────────────────────────────────────────────

describe('no-new-validation guard', () => {
  it('describePolicyIssues only consumes a ZodError — it never calls parse itself', () => {
    // Feed a minimal hand-constructed ZodError to ensure the renderer
    // never validates the raw input.
    const zodErr = new ZodError([
      {
        code: 'invalid_enum_value',
        path: ['agents', 'review_strategy'],
        message: 'Invalid enum value',
        received: 'loud',
        options: ['off', 'comment', 'block-and-revise'],
      },
    ]);
    const issues = describePolicyIssues(zodErr);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].fieldPath, 'agents.review_strategy');
    assert.equal(issues[0].received, 'loud');
  });
});
