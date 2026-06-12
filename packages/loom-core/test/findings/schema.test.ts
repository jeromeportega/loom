import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Finding,
  ReviewerOutput,
  SeverityEnum,
} from '../../src/findings/schema.js';

function validFinding() {
  return {
    severity: 'high',
    category: 'correctness',
    location: { file: 'src/app.ts', line: 42 },
    description: 'Off-by-one in the retry loop.',
    suggested_fix: 'Use <= instead of <.',
    source: 'adversarial-review',
  };
}

describe('findings schema', () => {
  it('accepts a valid finding', () => {
    const result = Finding.safeParse(validFinding());
    assert.equal(result.success, true);
  });

  it('accepts a finding without the optional fields (suggested_fix, line)', () => {
    const { suggested_fix, location, ...rest } = validFinding();
    void suggested_fix;
    const result = Finding.safeParse({ ...rest, location: { file: location.file } });
    assert.equal(result.success, true);
  });

  it('rejects a finding missing a required field (description)', () => {
    const { description, ...rest } = validFinding();
    void description;
    const result = Finding.safeParse(rest);
    assert.equal(result.success, false);
  });

  it('rejects a finding missing the source field', () => {
    const { source, ...rest } = validFinding();
    void source;
    assert.equal(Finding.safeParse(rest).success, false);
  });

  it('rejects a finding whose location has an empty file', () => {
    assert.equal(
      Finding.safeParse({ ...validFinding(), location: { file: '' } }).success,
      false,
    );
  });

  it('rejects a finding with a non-positive line number', () => {
    assert.equal(
      Finding.safeParse({
        ...validFinding(),
        location: { file: 'a.ts', line: 0 },
      }).success,
      false,
    );
  });

  it('severity enum is exactly {blocker, high, medium, low, info}', () => {
    assert.deepEqual(
      [...SeverityEnum.options].sort(),
      ['blocker', 'high', 'info', 'low', 'medium'],
    );
    for (const sev of SeverityEnum.options) {
      assert.equal(
        Finding.safeParse({ ...validFinding(), severity: sev }).success,
        true,
      );
    }
    assert.equal(
      Finding.safeParse({ ...validFinding(), severity: 'critical' }).success,
      false,
    );
  });

  it('ReviewerOutput accepts an empty findings array and an array of findings', () => {
    assert.equal(ReviewerOutput.safeParse({ findings: [] }).success, true);
    assert.equal(
      ReviewerOutput.safeParse({ findings: [validFinding()] }).success,
      true,
    );
  });

  it('ReviewerOutput rejects a non-array findings field', () => {
    assert.equal(ReviewerOutput.safeParse({ findings: {} }).success, false);
  });
});
