import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBriefGate } from '../brief/gate.js';

describe('evaluateBriefGate', () => {
  it('passes when ready and score equals the threshold (>= is inclusive)', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 6 }, 6);
    assert.equal(v.pass, true);
  });

  it('fails when ready but the score is below the threshold', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 5 }, 6);
    assert.equal(v.pass, false);
  });

  it('fails when not ready even with a perfect score — ready has veto', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 10 }, 6);
    assert.equal(v.pass, false);
  });

  it('fails when not ready even at threshold 0 — ready is always consulted', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 10 }, 0);
    assert.equal(v.pass, false);
  });

  it('passes when ready with score 0 at threshold 0', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 0 }, 0);
    assert.equal(v.pass, true);
  });

  it('echoes ready, quality_score, and threshold exactly as given', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 7 }, 4);
    assert.deepEqual(v, {
      pass: false,
      ready: false,
      quality_score: 7,
      threshold: 4,
    });
  });

  it('upholds the invariant pass === (ready && score >= threshold) across the grid', () => {
    for (const ready of [true, false]) {
      for (let score = 0; score <= 10; score++) {
        for (const threshold of [0, 3, 6, 10]) {
          const v = evaluateBriefGate({ ready, quality_score: score }, threshold);
          assert.equal(v.pass, ready === true && score >= threshold);
        }
      }
    }
  });
});
