import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBriefGate } from '../../src/brief/gate.js';

const THRESHOLD = 6;

// ── evaluateBriefGate — three-outcome routing ────────────────────────────────

describe('evaluateBriefGate — outcome routing', () => {
  it('score >= threshold AND ready: true → pass-clean, pass === true', () => {
    const verdict = evaluateBriefGate({ ready: true, quality_score: 8 }, THRESHOLD);
    assert.equal(verdict.outcome, 'pass-clean');
    assert.equal(verdict.pass, true);
  });

  it('score >= threshold AND ready: false → pass-with-clarifications, pass === false', () => {
    const verdict = evaluateBriefGate({ ready: false, quality_score: 8 }, THRESHOLD);
    assert.equal(verdict.outcome, 'pass-with-clarifications');
    assert.equal(verdict.pass, false);
  });

  it('score < threshold → below-threshold, pass === false', () => {
    const verdict = evaluateBriefGate({ ready: true, quality_score: 4 }, THRESHOLD);
    assert.equal(verdict.outcome, 'below-threshold');
    assert.equal(verdict.pass, false);
  });

  it('score < threshold with ready: false → below-threshold (threshold wins)', () => {
    const verdict = evaluateBriefGate({ ready: false, quality_score: 3 }, THRESHOLD);
    assert.equal(verdict.outcome, 'below-threshold');
    assert.equal(verdict.pass, false);
  });
});

// ── Boundary — exactly equal to threshold ────────────────────────────────────

describe('evaluateBriefGate — boundary (score === threshold)', () => {
  it('score EXACTLY equal to threshold AND ready: true → pass-clean (not below-threshold)', () => {
    const verdict = evaluateBriefGate({ ready: true, quality_score: THRESHOLD }, THRESHOLD);
    assert.equal(verdict.outcome, 'pass-clean');
    assert.equal(verdict.pass, true);
  });

  it('score EXACTLY equal to threshold AND ready: false → pass-with-clarifications (not below-threshold)', () => {
    const verdict = evaluateBriefGate({ ready: false, quality_score: THRESHOLD }, THRESHOLD);
    assert.equal(verdict.outcome, 'pass-with-clarifications');
    assert.equal(verdict.pass, false);
    assert.notEqual(verdict.outcome, 'below-threshold');
  });

  it('score one below threshold → below-threshold regardless of ready', () => {
    const verdict = evaluateBriefGate({ ready: true, quality_score: THRESHOLD - 1 }, THRESHOLD);
    assert.equal(verdict.outcome, 'below-threshold');
  });
});

// ── Back-compat invariant (ADR-4) ────────────────────────────────────────────

describe('evaluateBriefGate — back-compat: pass === (outcome === pass-clean)', () => {
  const cases: Array<{ ready: boolean; score: number }> = [
    { ready: true, score: 9 },   // pass-clean
    { ready: false, score: 8 },  // pass-with-clarifications
    { ready: true, score: 2 },   // below-threshold
    { ready: false, score: 2 },  // below-threshold
    { ready: true, score: THRESHOLD },   // boundary clean
    { ready: false, score: THRESHOLD },  // boundary with-clarifications
  ];
  for (const { ready, score } of cases) {
    it(`ready=${ready} score=${score}: pass === (outcome === 'pass-clean')`, () => {
      const verdict = evaluateBriefGate({ ready, quality_score: score }, THRESHOLD);
      assert.equal(verdict.pass, verdict.outcome === 'pass-clean');
    });
  }
});

// ── Echoed fields ─────────────────────────────────────────────────────────────

describe('evaluateBriefGate — echoed fields', () => {
  it('echoes ready, quality_score, and threshold verbatim', () => {
    const verdict = evaluateBriefGate({ ready: true, quality_score: 7 }, THRESHOLD);
    assert.equal(verdict.ready, true);
    assert.equal(verdict.quality_score, 7);
    assert.equal(verdict.threshold, THRESHOLD);
  });
});
