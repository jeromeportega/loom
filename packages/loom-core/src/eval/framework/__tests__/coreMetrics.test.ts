import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coreMetrics } from '../coreMetrics.js';
import type { RunRecord } from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecord(
  id: string,
  gateStatus: 'ok' | 'failed',
  judgeStatus: 'ok' | 'inconclusive' | 'skipped',
): RunRecord<{ v: string }, { pass: boolean }> {
  const gate =
    gateStatus === 'ok'
      ? ({ status: 'ok', output: { v: 'x' } } as const)
      : ({ status: 'failed', detail: 'err' } as const);

  const judge =
    judgeStatus === 'ok'
      ? ({ status: 'ok', judgment: { pass: true } } as const)
      : judgeStatus === 'inconclusive'
        ? ({ status: 'inconclusive', detail: 'unknown' } as const)
        : ({ status: 'skipped' } as const);

  return { caseId: id, gate, judge };
}

// ── Empty records ─────────────────────────────────────────────────────────────

describe('coreMetrics — empty records', () => {
  it('returns all zeros without dividing by zero', () => {
    const m = coreMetrics([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 0);
    assert.equal(m.gateFailureRate, 0);
    assert.equal(m.judgeInconclusive, 0);
    assert.equal(m.judgeInconclusiveRate, 0);
  });
});

// ── All cases gate-failed (denominator edge case) ─────────────────────────────

describe('coreMetrics — all cases gate-failed', () => {
  it('judgeInconclusiveRate is 0 when denominator is 0 (no judge ran)', () => {
    const records = [
      makeRecord('a', 'failed', 'skipped'),
      makeRecord('b', 'failed', 'skipped'),
    ];
    const m = coreMetrics(records);

    assert.equal(m.totalCases, 2);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.gateFailureRate, 1);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.judgeInconclusive, 0);
    assert.equal(m.judgeInconclusiveRate, 0, 'must not divide by zero when all gates fail');
  });
});

// ── scoredCases — gate ok AND judge ok only ───────────────────────────────────

describe('coreMetrics — scoredCases', () => {
  it('counts only gate-ok + judge-ok records', () => {
    const records = [
      makeRecord('a', 'ok', 'ok'),           // scored
      makeRecord('b', 'ok', 'inconclusive'), // not scored
      makeRecord('c', 'failed', 'skipped'),  // not scored
    ];
    const m = coreMetrics(records);
    assert.equal(m.scoredCases, 1, 'only gate-ok + judge-ok counts as scored');
  });

  it('is 0 when all judges are inconclusive', () => {
    const records = [
      makeRecord('a', 'ok', 'inconclusive'),
      makeRecord('b', 'ok', 'inconclusive'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.scoredCases, 0);
  });

  it('equals totalCases when all gates ok and all judges ok', () => {
    const records = [
      makeRecord('a', 'ok', 'ok'),
      makeRecord('b', 'ok', 'ok'),
      makeRecord('c', 'ok', 'ok'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.scoredCases, 3);
    assert.equal(m.totalCases, 3);
  });
});

// ── gateFailureRate ───────────────────────────────────────────────────────────

describe('coreMetrics — gateFailureRate', () => {
  it('equals gateFailures / totalCases', () => {
    const records = [
      makeRecord('a', 'ok', 'ok'),
      makeRecord('b', 'failed', 'skipped'),
      makeRecord('c', 'failed', 'skipped'),
      makeRecord('d', 'ok', 'ok'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.gateFailureRate, 0.5);
  });

  it('is 0 when no gate failures', () => {
    const records = [makeRecord('a', 'ok', 'ok')];
    const m = coreMetrics(records);
    assert.equal(m.gateFailureRate, 0);
  });

  it('is 1 when all gates fail', () => {
    const records = [
      makeRecord('a', 'failed', 'skipped'),
      makeRecord('b', 'failed', 'skipped'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.gateFailureRate, 1);
  });
});

// ── judgeInconclusiveRate ─────────────────────────────────────────────────────

describe('coreMetrics — judgeInconclusiveRate', () => {
  it('equals judgeInconclusive / (totalCases - gateFailures)', () => {
    // 4 cases: 1 gate failure, 3 gate-ok; 1 of the gate-ok has inconclusive judge
    const records = [
      makeRecord('a', 'ok', 'ok'),
      makeRecord('b', 'ok', 'inconclusive'),
      makeRecord('c', 'ok', 'ok'),
      makeRecord('d', 'failed', 'skipped'),
    ];
    const m = coreMetrics(records);

    assert.equal(m.judgeInconclusive, 1);
    // denominator = 4 - 1 = 3
    assert.ok(Math.abs(m.judgeInconclusiveRate - 1 / 3) < 1e-10, `expected ~0.333, got ${m.judgeInconclusiveRate}`);
  });

  it('is 0 when all gate-ok cases have ok judges', () => {
    const records = [
      makeRecord('a', 'ok', 'ok'),
      makeRecord('b', 'ok', 'ok'),
      makeRecord('c', 'failed', 'skipped'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.judgeInconclusiveRate, 0);
  });

  it('is 1 when all gate-ok judges are inconclusive', () => {
    const records = [
      makeRecord('a', 'ok', 'inconclusive'),
      makeRecord('b', 'ok', 'inconclusive'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.judgeInconclusiveRate, 1);
  });

  it('gate-failed cases (judge=skipped) are excluded from judgeInconclusive count', () => {
    // gate-failed → judge=skipped, not inconclusive
    const records = [
      makeRecord('a', 'failed', 'skipped'),
      makeRecord('b', 'ok', 'ok'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.judgeInconclusive, 0, 'skipped judge is not inconclusive');
    assert.equal(m.judgeInconclusiveRate, 0);
  });
});

// ── totalCases ────────────────────────────────────────────────────────────────

describe('coreMetrics — totalCases', () => {
  it('reflects the length of the records array', () => {
    const records = [
      makeRecord('a', 'ok', 'ok'),
      makeRecord('b', 'failed', 'skipped'),
      makeRecord('c', 'ok', 'inconclusive'),
    ];
    const m = coreMetrics(records);
    assert.equal(m.totalCases, 3);
  });
});
