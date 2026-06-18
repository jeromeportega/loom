import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBriefGate } from '../brief/gate.js';

const THRESHOLD = 6;

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
      outcome: 'pass-with-clarifications',
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

  it('back-compat invariant: pass === (outcome === pass-clean) for all combinations', () => {
    for (const ready of [true, false]) {
      for (let score = 0; score <= 10; score++) {
        for (const threshold of [0, 3, 6, 10]) {
          const v = evaluateBriefGate({ ready, quality_score: score }, threshold);
          assert.equal(v.pass, v.outcome === 'pass-clean');
        }
      }
    }
  });
});

// ── Three-outcome routing ──────────────────────────────────────────────────────

describe('evaluateBriefGate — outcome routing', () => {
  it('score >= threshold AND ready: true → pass-clean, pass === true', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 8 }, THRESHOLD);
    assert.equal(v.outcome, 'pass-clean');
    assert.equal(v.pass, true);
  });

  it('score >= threshold AND ready: false → pass-with-clarifications, pass === false', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 8 }, THRESHOLD);
    assert.equal(v.outcome, 'pass-with-clarifications');
    assert.equal(v.pass, false);
  });

  it('score < threshold → below-threshold, pass === false', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 4 }, THRESHOLD);
    assert.equal(v.outcome, 'below-threshold');
    assert.equal(v.pass, false);
  });

  it('score < threshold with ready: false → below-threshold (threshold wins)', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 3 }, THRESHOLD);
    assert.equal(v.outcome, 'below-threshold');
    assert.equal(v.pass, false);
  });
});

// ── Boundary: score exactly equal to threshold ─────────────────────────────────

describe('evaluateBriefGate — boundary (score === threshold)', () => {
  it('score EXACTLY equal to threshold AND ready: true → pass-clean (not below-threshold)', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: THRESHOLD }, THRESHOLD);
    assert.equal(v.outcome, 'pass-clean');
    assert.equal(v.pass, true);
  });

  it('score EXACTLY equal to threshold AND ready: false → pass-with-clarifications (not below-threshold)', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: THRESHOLD }, THRESHOLD);
    assert.equal(v.outcome, 'pass-with-clarifications');
    assert.equal(v.pass, false);
    assert.notEqual(v.outcome, 'below-threshold');
  });

  it('score one below threshold → below-threshold regardless of ready', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: THRESHOLD - 1 }, THRESHOLD);
    assert.equal(v.outcome, 'below-threshold');
  });
});
