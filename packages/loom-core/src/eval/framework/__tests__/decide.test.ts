import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../decide.js';
import type { CoreMetrics, EvalThresholds } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMetrics(overrides: Partial<CoreMetrics> = {}): CoreMetrics {
  return {
    totalCases: 10,
    scoredCases: 8,
    gateFailures: 1,
    gateFailureRate: 0.1,
    judgeInconclusive: 1,
    judgeInconclusiveRate: 0.1,
    ...overrides,
  };
}

const DEFAULT_THRESHOLDS: EvalThresholds = {
  minScoredCases: 5,
  maxGateFailureRate: 0.25,
  maxJudgeInconclusiveRate: 0.25,
};

const proceedVerdict = (_m: CoreMetrics) => 'proceed' as const;
const doNotProceedVerdict = (_m: CoreMetrics) => 'do-not-proceed' as const;

// ── Threshold 1: scoredCases < minScoredCases → inconclusive ─────────────────

describe('decide — scoredCases < minScoredCases → inconclusive (checked first)', () => {
  it('returns inconclusive when scoredCases is below minScoredCases', () => {
    const metrics = makeMetrics({ scoredCases: 4 });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(result.reasons.length > 0, 'reasons must be non-empty');
    assert.ok(
      result.reasons[0].includes('scoredCases') && result.reasons[0].includes('minScoredCases'),
      `reason must name the tripped threshold, got: ${result.reasons[0]}`,
    );
  });

  it('checked FIRST: scoredCases check fires even when gateFailureRate is also too high', () => {
    const metrics = makeMetrics({
      scoredCases: 2,
      gateFailureRate: 0.9, // also above threshold
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
      result.reasons[0].includes('scoredCases'),
      'first fired threshold must be scoredCases, not gateFailureRate',
    );
  });

  it('passes through when scoredCases equals minScoredCases (boundary — equal is not over)', () => {
    const metrics = makeMetrics({
      scoredCases: 5, // equal to min, not below
      gateFailureRate: 0.1,
      judgeInconclusiveRate: 0.1,
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.notEqual(result.verdict, 'inconclusive', 'equal to min must NOT trigger inconclusive');
    assert.equal(result.verdict, 'proceed');
  });
});

// ── Threshold 2: gateFailureRate > maxGateFailureRate → inconclusive ──────────

describe('decide — gateFailureRate > maxGateFailureRate → inconclusive (checked second)', () => {
  it('returns inconclusive when gateFailureRate exceeds maxGateFailureRate', () => {
    const metrics = makeMetrics({ gateFailureRate: 0.30 });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
      result.reasons[0].includes('gateFailureRate') && result.reasons[0].includes('maxGateFailureRate'),
      `reason must name gateFailureRate threshold, got: ${result.reasons[0]}`,
    );
  });

  it('passes through when gateFailureRate equals maxGateFailureRate (boundary)', () => {
    const metrics = makeMetrics({ gateFailureRate: 0.25 }); // equal to max, not over
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.notEqual(result.verdict, 'inconclusive', 'equal to max must NOT trigger inconclusive');
  });

  it('checked SECOND: gateFailureRate check fires only after scoredCases passes', () => {
    const metrics = makeMetrics({
      scoredCases: 6,   // passes first check (>= 5)
      gateFailureRate: 0.35, // fails second check
      judgeInconclusiveRate: 0.5, // would also fail third
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
      result.reasons[0].includes('gateFailureRate'),
      'second check fires when first passes, got: ' + result.reasons[0],
    );
  });
});

// ── Threshold 3: judgeInconclusiveRate > maxJudgeInconclusiveRate → inconclusive

describe('decide — judgeInconclusiveRate > maxJudgeInconclusiveRate → inconclusive (third)', () => {
  it('returns inconclusive when judgeInconclusiveRate exceeds maxJudgeInconclusiveRate', () => {
    const metrics = makeMetrics({ judgeInconclusiveRate: 0.30 });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
      result.reasons[0].includes('judgeInconclusiveRate') && result.reasons[0].includes('maxJudgeInconclusiveRate'),
      `reason must name judgeInconclusiveRate threshold, got: ${result.reasons[0]}`,
    );
  });

  it('passes through when judgeInconclusiveRate equals maxJudgeInconclusiveRate (boundary)', () => {
    const metrics = makeMetrics({ judgeInconclusiveRate: 0.25 }); // equal to max
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.notEqual(result.verdict, 'inconclusive', 'equal to max must NOT trigger inconclusive');
  });

  it('checked THIRD: fires only after first two checks pass', () => {
    const metrics = makeMetrics({
      scoredCases: 6,          // passes first (>= 5)
      gateFailureRate: 0.20,   // passes second (<= 0.25)
      judgeInconclusiveRate: 0.30, // fails third
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'inconclusive');
    assert.ok(
      result.reasons[0].includes('judgeInconclusiveRate'),
      'third check fires when first two pass, got: ' + result.reasons[0],
    );
  });
});

// ── Delegate to consumer verdict when all thresholds pass ────────────────────

describe('decide — delegates to consumer verdict when all structural checks pass', () => {
  it('returns proceed when consumer verdict is proceed and all checks pass', () => {
    const metrics = makeMetrics({
      scoredCases: 8,
      gateFailureRate: 0.1,
      judgeInconclusiveRate: 0.1,
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, proceedVerdict);
    assert.equal(result.verdict, 'proceed');
    assert.deepEqual(result.reasons, [], 'reasons must be empty when verdict comes from consumer');
  });

  it('returns do-not-proceed when consumer verdict is do-not-proceed and all checks pass', () => {
    const metrics = makeMetrics({
      scoredCases: 8,
      gateFailureRate: 0.1,
      judgeInconclusiveRate: 0.1,
    });
    const result = decide(metrics, DEFAULT_THRESHOLDS, doNotProceedVerdict);
    assert.equal(result.verdict, 'do-not-proceed');
    assert.deepEqual(result.reasons, []);
  });

  it('consumer verdict receives the full metrics object', () => {
    let capturedMetrics: CoreMetrics | undefined;
    const metrics = makeMetrics({ scoredCases: 7 });
    decide(metrics, DEFAULT_THRESHOLDS, (m) => {
      capturedMetrics = m;
      return 'proceed';
    });
    assert.deepEqual(capturedMetrics, metrics, 'consumer verdict receives the exact metrics passed in');
  });
});

// ── reasons[] names the tripped threshold ────────────────────────────────────

describe('decide — reasons[] names the tripped threshold', () => {
  it('reason for scoredCases includes both scoredCases and minScoredCases values', () => {
    const metrics = makeMetrics({ scoredCases: 3 });
    const thresholds: EvalThresholds = { ...DEFAULT_THRESHOLDS, minScoredCases: 10 };
    const result = decide(metrics, thresholds, proceedVerdict);
    assert.ok(result.reasons[0].includes('3'), 'reason includes actual value 3');
    assert.ok(result.reasons[0].includes('10'), 'reason includes threshold value 10');
  });

  it('reason for gateFailureRate includes rate and max values', () => {
    const metrics = makeMetrics({ gateFailureRate: 0.5 });
    const thresholds: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxGateFailureRate: 0.2 };
    const result = decide(metrics, thresholds, proceedVerdict);
    assert.ok(result.reasons[0].includes('gateFailureRate'), 'reason names gateFailureRate');
    assert.ok(result.reasons[0].includes('maxGateFailureRate'), 'reason names maxGateFailureRate');
  });

  it('reason for judgeInconclusiveRate includes rate and max values', () => {
    const metrics = makeMetrics({ judgeInconclusiveRate: 0.4 });
    const thresholds: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxJudgeInconclusiveRate: 0.1 };
    const result = decide(metrics, thresholds, proceedVerdict);
    assert.ok(result.reasons[0].includes('judgeInconclusiveRate'), 'reason names judgeInconclusiveRate');
    assert.ok(result.reasons[0].includes('maxJudgeInconclusiveRate'), 'reason names maxJudgeInconclusiveRate');
  });
});

// ── Configurable thresholds — AC3 ────────────────────────────────────────────

describe('decide — configurable thresholds (AC3)', () => {
  it('different minScoredCases thresholds produce different outcomes', () => {
    const metrics = makeMetrics({ scoredCases: 7 });

    const loose: EvalThresholds = { ...DEFAULT_THRESHOLDS, minScoredCases: 5 };
    const strict: EvalThresholds = { ...DEFAULT_THRESHOLDS, minScoredCases: 10 };

    assert.equal(decide(metrics, loose, proceedVerdict).verdict, 'proceed');
    assert.equal(decide(metrics, strict, proceedVerdict).verdict, 'inconclusive');
  });

  it('different maxGateFailureRate thresholds produce different outcomes', () => {
    const metrics = makeMetrics({ gateFailureRate: 0.3 });

    const loose: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxGateFailureRate: 0.5 };
    const strict: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxGateFailureRate: 0.1 };

    assert.equal(decide(metrics, loose, proceedVerdict).verdict, 'proceed');
    assert.equal(decide(metrics, strict, proceedVerdict).verdict, 'inconclusive');
  });

  it('different maxJudgeInconclusiveRate thresholds produce different outcomes', () => {
    const metrics = makeMetrics({ judgeInconclusiveRate: 0.2 });

    const loose: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxJudgeInconclusiveRate: 0.5 };
    const strict: EvalThresholds = { ...DEFAULT_THRESHOLDS, maxJudgeInconclusiveRate: 0.1 };

    assert.equal(decide(metrics, loose, proceedVerdict).verdict, 'proceed');
    assert.equal(decide(metrics, strict, proceedVerdict).verdict, 'inconclusive');
  });
});
