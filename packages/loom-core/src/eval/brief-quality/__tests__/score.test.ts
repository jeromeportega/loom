import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scoreBriefQuality } from '../score.js';
import type { RunRecord } from '../../framework/types.js';
import type { BriefRefinement } from '../../../brief/types.js';
import type { BriefQualityJudgment } from '../judgeTypes.js';

// ── Record builders ───────────────────────────────────────────────────────────

type FidelityLabel = 'faithful' | 'partial' | 'fabricated';

function makeRefinement(quality_score = 8): BriefRefinement {
  return {
    ready: true,
    original: 'brief',
    quality_score,
    critique: {
      strong_points: [],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

function okRecord(
  id: string,
  readiness_correct: boolean,
  quality_in_band: boolean,
  critique_fidelity: FidelityLabel,
): RunRecord<BriefRefinement, BriefQualityJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: makeRefinement() },
    judge: {
      status: 'ok',
      judgment: { readiness_correct, quality_in_band, critique_fidelity, reason: 'test' },
    },
  };
}

function gateFailedRecord(id: string): RunRecord<BriefRefinement, BriefQualityJudgment> {
  return {
    caseId: id,
    gate: { status: 'failed', detail: 'error' },
    judge: { status: 'skipped' },
  };
}

function judgeInconclusiveRecord(id: string): RunRecord<BriefRefinement, BriefQualityJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: makeRefinement() },
    judge: { status: 'inconclusive', detail: 'judge failed' },
  };
}

// ── Empty / zero ──────────────────────────────────────────────────────────────

describe('scoreBriefQuality — empty input', () => {
  it('returns zero metrics for an empty record list', () => {
    const m = scoreBriefQuality([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.readinessAccuracy, 0);
    assert.equal(m.qualityBandAgreement, 0);
    assert.equal(m.critiqueQuality, 0);
  });

  it('returns zero brief-quality metrics when all gates failed', () => {
    const records = [gateFailedRecord('c1'), gateFailedRecord('c2')];
    const m = scoreBriefQuality(records);
    assert.equal(m.totalCases, 2);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.readinessAccuracy, 0);
    assert.equal(m.qualityBandAgreement, 0);
    assert.equal(m.critiqueQuality, 0);
  });

  it('returns zero brief-quality metrics when all judges inconclusive', () => {
    const records = [judgeInconclusiveRecord('c1'), judgeInconclusiveRecord('c2')];
    const m = scoreBriefQuality(records);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.readinessAccuracy, 0);
    assert.equal(m.qualityBandAgreement, 0);
    assert.equal(m.critiqueQuality, 0);
  });
});

// ── Happy path: all scored ────────────────────────────────────────────────────

describe('scoreBriefQuality — all-ok records', () => {
  it('readinessAccuracy = readiness_correct / scoredCases', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      okRecord('c2', true, true, 'faithful'),
      okRecord('c3', false, true, 'faithful'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.scoredCases, 3);
    assert.ok(Math.abs(m.readinessAccuracy - 2 / 3) < 1e-9, `expected ~0.667, got ${m.readinessAccuracy}`);
  });

  it('qualityBandAgreement = quality_in_band / scoredCases', () => {
    const records = [
      okRecord('c1', true, true,  'faithful'),
      okRecord('c2', true, false, 'faithful'),
      okRecord('c3', true, true,  'faithful'),
      okRecord('c4', true, false, 'faithful'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.scoredCases, 4);
    assert.ok(Math.abs(m.qualityBandAgreement - 0.5) < 1e-9);
  });

  it('critiqueQuality = (faithful + 0.5 * partial) / scoredCases', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      okRecord('c2', true, true, 'partial'),
      okRecord('c3', true, true, 'fabricated'),
      okRecord('c4', true, true, 'faithful'),
    ];
    const m = scoreBriefQuality(records);
    // faithful=2, partial=1, fabricated=1 → (2 + 0.5*1) / 4 = 2.5/4 = 0.625
    assert.ok(Math.abs(m.critiqueQuality - 0.625) < 1e-9);
  });

  it('all faithful → critiqueQuality = 1.0', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      okRecord('c2', true, true, 'faithful'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.critiqueQuality, 1.0);
  });

  it('all fabricated → critiqueQuality = 0.0', () => {
    const records = [
      okRecord('c1', true, true, 'fabricated'),
      okRecord('c2', true, true, 'fabricated'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.critiqueQuality, 0.0);
  });

  it('all partial → critiqueQuality = 0.5', () => {
    const records = [
      okRecord('c1', true, true, 'partial'),
      okRecord('c2', true, true, 'partial'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.critiqueQuality, 0.5);
  });
});

// ── Denominator: scoredCases excludes failed/skipped/inconclusive ─────────────

describe('scoreBriefQuality — mixed records: denominator uses only scoredCases', () => {
  it('gate-failed cases do not count in readinessAccuracy denominator', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      gateFailedRecord('c2'),
      okRecord('c3', false, true, 'faithful'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.totalCases, 3);
    assert.equal(m.scoredCases, 2);
    // readiness: 1 correct out of 2 scored
    assert.ok(Math.abs(m.readinessAccuracy - 0.5) < 1e-9);
  });

  it('inconclusive judge outcomes do not count in critiqueQuality denominator', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      judgeInconclusiveRecord('c2'),
      okRecord('c3', true, true, 'partial'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.scoredCases, 2);
    // critiqueQuality: (1 faithful + 0.5*1 partial) / 2 = 1.5/2 = 0.75
    assert.ok(Math.abs(m.critiqueQuality - 0.75) < 1e-9);
  });

  it('all three axes use the same scoredCases denominator', () => {
    // 4 total: 2 ok, 1 gate-failed, 1 inconclusive
    const records = [
      okRecord('c1', true, true,  'faithful'),
      okRecord('c2', false, false, 'fabricated'),
      gateFailedRecord('c3'),
      judgeInconclusiveRecord('c4'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.totalCases, 4);
    assert.equal(m.scoredCases, 2);
    assert.equal(m.gateFailures, 1);
    assert.equal(m.judgeInconclusive, 1);
    // readiness: 1/2, quality: 1/2, critique: 1/2 (1 faithful + 0*fabricated)/2
    assert.ok(Math.abs(m.readinessAccuracy    - 0.5) < 1e-9);
    assert.ok(Math.abs(m.qualityBandAgreement - 0.5) < 1e-9);
    assert.ok(Math.abs(m.critiqueQuality      - 0.5) < 1e-9);
  });
});

// ── coreMetrics delegation ────────────────────────────────────────────────────

describe('scoreBriefQuality — coreMetrics fields populated correctly', () => {
  it('gateFailureRate = gateFailures / totalCases', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      gateFailedRecord('c2'),
      gateFailedRecord('c3'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.totalCases, 3);
    assert.equal(m.gateFailures, 2);
    assert.ok(Math.abs(m.gateFailureRate - 2 / 3) < 1e-9);
  });

  it('judgeInconclusiveRate = judgeInconclusive / (totalCases - gateFailures)', () => {
    const records = [
      okRecord('c1', true, true, 'faithful'),
      judgeInconclusiveRecord('c2'),
      judgeInconclusiveRecord('c3'),
    ];
    const m = scoreBriefQuality(records);
    assert.equal(m.judgeInconclusive, 2);
    assert.ok(Math.abs(m.judgeInconclusiveRate - 2 / 3) < 1e-9);
  });
});
