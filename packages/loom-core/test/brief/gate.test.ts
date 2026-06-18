import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBriefGate } from '../../src/brief/gate.js';

const THRESHOLD = 6;

// ── Three-outcome routing ──────────────────────────────────────────────────────

describe('evaluateBriefGate — three-outcome routing', () => {
  it('score >= threshold AND ready: true → pass-clean, pass === true (FR-6)', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 8 }, THRESHOLD);
    assert.equal(v.outcome, 'pass-clean');
    assert.equal(v.pass, true);
  });

  it('score >= threshold AND ready: false → pass-with-clarifications, pass === false', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 8 }, THRESHOLD);
    assert.equal(v.outcome, 'pass-with-clarifications');
    assert.equal(v.pass, false);
  });

  it('score < threshold → below-threshold, pass === false (FR-8)', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 4 }, THRESHOLD);
    assert.equal(v.outcome, 'below-threshold');
    assert.equal(v.pass, false);
  });

  it('score < threshold with ready: false → below-threshold (threshold check wins)', () => {
    const v = evaluateBriefGate({ ready: false, quality_score: 3 }, THRESHOLD);
    assert.equal(v.outcome, 'below-threshold');
    assert.equal(v.pass, false);
  });
});

// ── Boundary: score exactly equal to threshold ─────────────────────────────────

describe('evaluateBriefGate — boundary (score === threshold)', () => {
  it('score EXACTLY equal to threshold AND ready: true → pass-clean (inclusive)', () => {
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

// ── Back-compat: pass === (outcome === 'pass-clean') ─────────────────────────────

describe('evaluateBriefGate — back-compat invariant (ADR-4)', () => {
  it('pass === (outcome === pass-clean) holds for all three outcomes', () => {
    const cases: Array<{ ready: boolean; score: number; expectedOutcome: string }> = [
      { ready: true, score: 9, expectedOutcome: 'pass-clean' },
      { ready: false, score: 9, expectedOutcome: 'pass-with-clarifications' },
      { ready: true, score: 2, expectedOutcome: 'below-threshold' },
      { ready: false, score: 2, expectedOutcome: 'below-threshold' },
    ];
    for (const { ready, score, expectedOutcome } of cases) {
      const v = evaluateBriefGate({ ready, quality_score: score }, THRESHOLD);
      assert.equal(v.outcome, expectedOutcome);
      assert.equal(v.pass, v.outcome === 'pass-clean', `pass invariant failed for outcome ${v.outcome}`);
    }
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
});

// ── Edge: minScore=0 ─────────────────────────────────────────────────────────────

describe('evaluateBriefGate — minScore=0 (no-threshold mode)', () => {
  it('minScore=0 AND ready: true, score: 0 → pass-clean', () => {
    const v = evaluateBriefGate({ ready: true, quality_score: 0 }, 0);
    assert.equal(v.outcome, 'pass-clean');
    assert.equal(v.pass, true);
  });

  it('minScore=0 AND ready: false → pass-with-clarifications, not below-threshold', () => {
    // Operators who set min_brief_quality_score: 0 still see exit 3 (not exit 1)
    // when the refiner returns ready: false. The threshold check passes (0 >= 0),
    // so routing falls to the ready flag.
    const v = evaluateBriefGate({ ready: false, quality_score: 0 }, 0);
    assert.equal(v.outcome, 'pass-with-clarifications');
    assert.equal(v.pass, false);
    assert.notEqual(v.outcome, 'below-threshold');
  });
});
