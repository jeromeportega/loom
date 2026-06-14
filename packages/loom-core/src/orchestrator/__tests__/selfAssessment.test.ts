import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelfAssessment, SELF_ASSESSMENT_MARKER } from '../selfAssessment.js';

describe('parseSelfAssessment', () => {
  it('parses a well-formed marker line', () => {
    const out = `done.\n${SELF_ASSESSMENT_MARKER} {"confidence":"high","complexity":"low","note":"trivial typo fix"}`;
    assert.deepEqual(parseSelfAssessment(out), {
      confidence: 'high',
      complexity: 'low',
      note: 'trivial typo fix',
    });
  });

  it('returns undefined when the marker is absent', () => {
    assert.equal(parseSelfAssessment('just some normal worker output'), undefined);
  });

  it('returns undefined for empty input', () => {
    assert.equal(parseSelfAssessment(''), undefined);
  });

  it('takes the LAST marker when the model echoed the format earlier', () => {
    const out = [
      `I will end with ${SELF_ASSESSMENT_MARKER} {"confidence":"low","complexity":"high"} as instructed.`,
      'work happens...',
      `${SELF_ASSESSMENT_MARKER} {"confidence":"high","complexity":"medium","note":"clean"}`,
    ].join('\n');
    assert.deepEqual(parseSelfAssessment(out), {
      confidence: 'high',
      complexity: 'medium',
      note: 'clean',
    });
  });

  it('defaults complexity to medium when only confidence is present', () => {
    const out = `${SELF_ASSESSMENT_MARKER} {"confidence":"medium"}`;
    assert.deepEqual(parseSelfAssessment(out), { confidence: 'medium', complexity: 'medium' });
  });

  it('returns undefined when confidence is missing (load-bearing field)', () => {
    assert.equal(parseSelfAssessment(`${SELF_ASSESSMENT_MARKER} {"complexity":"low"}`), undefined);
  });

  it('returns undefined for an invalid confidence value', () => {
    assert.equal(
      parseSelfAssessment(`${SELF_ASSESSMENT_MARKER} {"confidence":"very-high"}`),
      undefined
    );
  });

  it('returns undefined for malformed JSON', () => {
    assert.equal(
      parseSelfAssessment(`${SELF_ASSESSMENT_MARKER} {confidence: high}`),
      undefined
    );
  });

  it('ignores trailing prose after the JSON object', () => {
    const out = `${SELF_ASSESSMENT_MARKER} {"confidence":"low","complexity":"high"} — thanks!`;
    assert.deepEqual(parseSelfAssessment(out), { confidence: 'low', complexity: 'high' });
  });

  it('drops an empty note', () => {
    const out = `${SELF_ASSESSMENT_MARKER} {"confidence":"high","complexity":"low","note":"  "}`;
    assert.deepEqual(parseSelfAssessment(out), { confidence: 'high', complexity: 'low' });
  });
});
