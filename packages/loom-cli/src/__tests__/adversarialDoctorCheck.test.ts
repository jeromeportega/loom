/**
 * Tests for adversarialReviewFindingsToChecks() — the loom doctor severity
 * mapping for adversarial review findings (story-082-004, FR-10).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adversarialReviewFindingsToChecks } from '../commands/doctor.js';
import type { ReviewFinding } from '@loom-ai/core';

describe('adversarialReviewFindingsToChecks — doctor severity mapping (FR-10)', () => {
  it('blocker finding → ok:false, required:true (error)', () => {
    const finding: ReviewFinding = {
      severity: 'blocker',
      file: 'src/auth.ts',
      line: 42,
      issue: 'missing auth check',
      suggestion: 'add guard at top of handler',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].required, true, 'blocker must be required:true (maps to error ✗)');
  });

  it('should-fix finding → ok:false, required:false (warn)', () => {
    const finding: ReviewFinding = {
      severity: 'should-fix',
      file: 'src/utils.ts',
      issue: 'poor error handling',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].required, false, 'should-fix must be required:false (maps to warn ⚠)');
  });

  it('nit finding → ok:false, required:false (warn)', () => {
    const finding: ReviewFinding = {
      severity: 'nit',
      file: 'src/helpers.ts',
      issue: 'minor style issue',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].ok, false);
    assert.equal(checks[0].required, false, 'nit must be required:false (maps to warn ⚠)');
  });

  it('empty findings array → empty checks array (omitted from doctor output)', () => {
    const checks = adversarialReviewFindingsToChecks([]);
    assert.equal(checks.length, 0, 'no findings → no checks');
  });

  it('check name includes file and line when line is present', () => {
    const finding: ReviewFinding = {
      severity: 'blocker',
      file: 'src/main.ts',
      line: 99,
      issue: 'critical bug',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.ok(
      checks[0].name.includes('src/main.ts:99'),
      `name must include file:line, got: ${checks[0].name}`
    );
  });

  it('check name includes only file when line is absent', () => {
    const finding: ReviewFinding = {
      severity: 'nit',
      file: 'src/types.ts',
      issue: 'missing jsdoc',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.ok(checks[0].name.includes('src/types.ts'));
    assert.ok(
      !checks[0].name.includes(':undefined'),
      'should not include ":undefined" when line is absent'
    );
  });

  it('check detail includes suggestion when present', () => {
    const finding: ReviewFinding = {
      severity: 'should-fix',
      file: 'src/api.ts',
      issue: 'no timeout',
      suggestion: 'add a 30s timeout',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.ok(
      checks[0].detail.includes('add a 30s timeout'),
      'detail must include the suggestion'
    );
  });

  it('check detail includes only issue when suggestion is absent', () => {
    const finding: ReviewFinding = {
      severity: 'blocker',
      file: 'src/db.ts',
      issue: 'SQL injection risk',
    };
    const checks = adversarialReviewFindingsToChecks([finding]);
    assert.ok(checks[0].detail.includes('SQL injection risk'));
    assert.ok(!checks[0].detail.includes('undefined'), 'no "undefined" in detail without suggestion');
  });

  it('maps multiple findings preserving all severity types', () => {
    const findings: ReviewFinding[] = [
      { severity: 'blocker', file: 'src/a.ts', issue: 'critical issue' },
      { severity: 'should-fix', file: 'src/b.ts', issue: 'error handling missing' },
      { severity: 'nit', file: 'src/c.ts', issue: 'naming' },
    ];
    const checks = adversarialReviewFindingsToChecks(findings);
    assert.equal(checks.length, 3);
    assert.equal(checks[0].required, true);   // blocker
    assert.equal(checks[1].required, false);  // should-fix
    assert.equal(checks[2].required, false);  // nit
  });
});
