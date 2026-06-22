import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scoreSkillJudge, skillJudgeVerdict, SKILL_JUDGE_THRESHOLDS } from '../score.js';
import type { RunRecord } from '../../framework/types.js';
import type { JudgeResult } from '../../../skills/SkillJudge.js';
import type { SkillJudgeJudgment } from '../judgeTypes.js';

// ── Record builders ────────────────────────────────────────────────────────────

function makeJudgeResult(verdict: 'accept' | 'reject' = 'accept', score = 8): JudgeResult {
  return { score, verdict, reason: 'test' };
}

function makeJudgment(
  decision_correct: boolean,
  band_in_range: boolean,
  independent_verdict: 'accept' | 'reject' = 'accept',
  band_defensible = true,
): SkillJudgeJudgment {
  return { decision_correct, band_in_range, independent_verdict, band_defensible, reason: 'test' };
}

function okRecord(
  id: string,
  decision_correct: boolean,
  band_in_range: boolean,
  independent_verdict: 'accept' | 'reject' = 'accept',
  gateVerdict: 'accept' | 'reject' = 'accept',
  gateScore = 8,
): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: makeJudgeResult(gateVerdict, gateScore) },
    judge: { status: 'ok', judgment: makeJudgment(decision_correct, band_in_range, independent_verdict) },
  };
}

function gateFailedRecord(
  id: string,
  detail = 'generic error',
): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return {
    caseId: id,
    gate: { status: 'failed', detail },
    judge: { status: 'skipped' },
  };
}

function failOpenRecord(id: string): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return gateFailedRecord(id, 'fail-open');
}

function judgeInconclusiveRecord(id: string): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return {
    caseId: id,
    gate: { status: 'ok', output: makeJudgeResult() },
    judge: { status: 'inconclusive', detail: 'judge failed' },
  };
}

// ── Empty / zero ───────────────────────────────────────────────────────────────

describe('scoreSkillJudge — empty input', () => {
  it('returns zero metrics for an empty record list', () => {
    const m = scoreSkillJudge([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.decisionAccuracy, 0);
    assert.equal(m.bandAgreement, 0);
    assert.equal(m.independentAgreement, 0);
    assert.equal(m.failOpenObserved, 0);
  });

  it('returns zero skill-judge metrics when all gates failed', () => {
    const records = [gateFailedRecord('c1'), gateFailedRecord('c2')];
    const m = scoreSkillJudge(records);
    assert.equal(m.totalCases, 2);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.decisionAccuracy, 0);
    assert.equal(m.bandAgreement, 0);
    assert.equal(m.independentAgreement, 0);
  });

  it('returns zero skill-judge metrics when all judges inconclusive', () => {
    const records = [judgeInconclusiveRecord('c1'), judgeInconclusiveRecord('c2')];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.decisionAccuracy, 0);
    assert.equal(m.bandAgreement, 0);
    assert.equal(m.independentAgreement, 0);
  });
});

// ── decisionAccuracy ──────────────────────────────────────────────────────────

describe('scoreSkillJudge — decisionAccuracy', () => {
  it('decisionAccuracy = decision_correct / scoredCases on a known record set (3/4)', () => {
    const records = [
      okRecord('c1', true, true),
      okRecord('c2', true, true),
      okRecord('c3', true, true),
      okRecord('c4', false, true),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 4);
    assert.ok(Math.abs(m.decisionAccuracy - 3 / 4) < 1e-9, `expected 0.75, got ${m.decisionAccuracy}`);
  });

  it('decisionAccuracy = 1.0 when all records are correct', () => {
    const records = [
      okRecord('c1', true, true),
      okRecord('c2', true, true),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.decisionAccuracy, 1.0);
  });

  it('decisionAccuracy = 0.0 when no records are correct', () => {
    const records = [
      okRecord('c1', false, true),
      okRecord('c2', false, true),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.decisionAccuracy, 0.0);
  });
});

// ── bandAgreement ─────────────────────────────────────────────────────────────

describe('scoreSkillJudge — bandAgreement', () => {
  it('bandAgreement = band_in_range / scoredCases on known inputs', () => {
    const records = [
      okRecord('c1', true, true),
      okRecord('c2', true, false),
      okRecord('c3', true, true),
      okRecord('c4', true, false),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 4);
    assert.ok(Math.abs(m.bandAgreement - 0.5) < 1e-9);
  });

  it('bandAgreement = 1.0 when all records are in band', () => {
    const records = [
      okRecord('c1', true, true),
      okRecord('c2', true, true),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.bandAgreement, 1.0);
  });
});

// ── independentAgreement ──────────────────────────────────────────────────────

describe('scoreSkillJudge — independentAgreement', () => {
  it('independentAgreement = (independent_verdict === gate.verdict) / scoredCases', () => {
    const records = [
      // gate=accept, ind=accept → match
      okRecord('c1', true, true, 'accept', 'accept'),
      // gate=accept, ind=accept → match
      okRecord('c2', true, true, 'accept', 'accept'),
      // gate=reject, ind=accept → no match
      okRecord('c3', false, false, 'accept', 'reject'),
      // gate=reject, ind=reject → match
      okRecord('c4', false, false, 'reject', 'reject'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 4);
    // 3 matches out of 4
    assert.ok(Math.abs(m.independentAgreement - 3 / 4) < 1e-9, `expected 0.75, got ${m.independentAgreement}`);
  });

  it('independentAgreement = 1.0 when all independent verdicts agree with gate', () => {
    const records = [
      okRecord('c1', true, true, 'accept', 'accept'),
      okRecord('c2', false, false, 'reject', 'reject'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.independentAgreement, 1.0);
  });

  it('independentAgreement = 0.0 when no independent verdicts agree with gate', () => {
    const records = [
      okRecord('c1', false, false, 'reject', 'accept'),
      okRecord('c2', false, false, 'accept', 'reject'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.independentAgreement, 0.0);
  });
});

// ── failOpenObserved ──────────────────────────────────────────────────────────

describe('scoreSkillJudge — failOpenObserved', () => {
  it('failOpenObserved = count of records with gate.detail === fail-open', () => {
    const records = [
      okRecord('c1', true, true),
      failOpenRecord('c2'),
      failOpenRecord('c3'),
      gateFailedRecord('c4', 'llm timeout'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.failOpenObserved, 2);
  });

  it('fail-open records do NOT count as scored accepts (gate.status is failed)', () => {
    const records = [
      okRecord('c1', true, true),
      failOpenRecord('c2'),
      failOpenRecord('c3'),
    ];
    const m = scoreSkillJudge(records);
    // Only c1 is scored; c2 and c3 are gate failures
    assert.equal(m.scoredCases, 1);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.failOpenObserved, 2);
  });

  it('failOpenObserved = 0 when no fail-open records exist', () => {
    const records = [
      okRecord('c1', true, true),
      gateFailedRecord('c2', 'other error'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.failOpenObserved, 0);
  });

  it('generic gate failures are not counted as fail-open', () => {
    const records = [
      gateFailedRecord('c1', 'timeout'),
      gateFailedRecord('c2', 'rate-limit'),
      failOpenRecord('c3'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.gateFailures, 3);
    assert.equal(m.failOpenObserved, 1);
  });
});

// ── CoreMetrics delegation ────────────────────────────────────────────────────

describe('scoreSkillJudge — CoreMetrics fields populated correctly', () => {
  it('gateFailureRate = gateFailures / totalCases', () => {
    const records = [
      okRecord('c1', true, true),
      gateFailedRecord('c2'),
      gateFailedRecord('c3'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.totalCases, 3);
    assert.equal(m.gateFailures, 2);
    assert.ok(Math.abs(m.gateFailureRate - 2 / 3) < 1e-9);
  });

  it('judgeInconclusiveRate = judgeInconclusive / (totalCases - gateFailures)', () => {
    const records = [
      okRecord('c1', true, true),
      judgeInconclusiveRecord('c2'),
      judgeInconclusiveRecord('c3'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.judgeInconclusive, 2);
    assert.ok(Math.abs(m.judgeInconclusiveRate - 2 / 3) < 1e-9);
  });

  it('all six coreMetrics fields are present', () => {
    const m = scoreSkillJudge([okRecord('c1', true, true)]);
    assert.ok('totalCases' in m);
    assert.ok('scoredCases' in m);
    assert.ok('gateFailures' in m);
    assert.ok('gateFailureRate' in m);
    assert.ok('judgeInconclusive' in m);
    assert.ok('judgeInconclusiveRate' in m);
  });
});

// ── Mixed records ─────────────────────────────────────────────────────────────

describe('scoreSkillJudge — mixed records: denominator uses only scoredCases', () => {
  it('gate-failed and inconclusive records excluded from scored denominator', () => {
    const records = [
      okRecord('c1', true, true, 'accept', 'accept'),
      gateFailedRecord('c2'),
      judgeInconclusiveRecord('c3'),
      okRecord('c4', false, false, 'reject', 'accept'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.totalCases, 4);
    assert.equal(m.scoredCases, 2);
    assert.equal(m.gateFailures, 1);
    assert.equal(m.judgeInconclusive, 1);
    // decisionAccuracy: 1/2 (c1 correct, c4 incorrect)
    assert.ok(Math.abs(m.decisionAccuracy - 0.5) < 1e-9);
    // bandAgreement: 1/2 (c1 in range, c4 not)
    assert.ok(Math.abs(m.bandAgreement - 0.5) < 1e-9);
    // independentAgreement: c1 (accept==accept=match), c4 (reject!=accept=no match) → 1/2
    assert.ok(Math.abs(m.independentAgreement - 0.5) < 1e-9);
  });
});

// ── skillJudgeVerdict ─────────────────────────────────────────────────────────

describe('skillJudgeVerdict — SKILL_JUDGE_THRESHOLDS precedence', () => {
  it('SKILL_JUDGE_THRESHOLDS has expected values', () => {
    assert.equal(SKILL_JUDGE_THRESHOLDS.minScoredCases, 5);
    assert.equal(SKILL_JUDGE_THRESHOLDS.maxGateFailureRate, 0.25);
    assert.equal(SKILL_JUDGE_THRESHOLDS.maxJudgeInconclusiveRate, 0.25);
  });

  function makeMetrics(overrides: Partial<{
    scoredCases: number;
    gateFailureRate: number;
    judgeInconclusiveRate: number;
  }> = {}) {
    return {
      totalCases:           10,
      scoredCases:          overrides.scoredCases ?? 6,
      gateFailures:         0,
      gateFailureRate:      overrides.gateFailureRate ?? 0,
      judgeInconclusive:    0,
      judgeInconclusiveRate: overrides.judgeInconclusiveRate ?? 0,
      decisionAccuracy:     1.0,
      bandAgreement:        1.0,
      independentAgreement: 1.0,
      failOpenObserved:     0,
    };
  }

  it('all thresholds clear → proceed', () => {
    const m = makeMetrics({ scoredCases: 6, gateFailureRate: 0.0, judgeInconclusiveRate: 0.0 });
    assert.equal(skillJudgeVerdict(m), 'proceed');
  });

  it('fewer than 5 scored cases → do-not-proceed (fail-closed)', () => {
    const m = makeMetrics({ scoredCases: 4 });
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('exactly 5 scored cases → proceed (boundary inclusive)', () => {
    const m = makeMetrics({ scoredCases: 5 });
    assert.equal(skillJudgeVerdict(m), 'proceed');
  });

  it('gate failure rate > 0.25 → do-not-proceed (driven by fail-opens)', () => {
    const m = makeMetrics({ gateFailureRate: 0.26 });
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('gate failure rate exactly 0.25 → proceed (boundary not exceeded)', () => {
    const m = makeMetrics({ gateFailureRate: 0.25 });
    assert.equal(skillJudgeVerdict(m), 'proceed');
  });

  it('judge inconclusive rate > 0.25 → do-not-proceed', () => {
    const m = makeMetrics({ judgeInconclusiveRate: 0.26 });
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('judge inconclusive rate exactly 0.25 → proceed (boundary not exceeded)', () => {
    const m = makeMetrics({ judgeInconclusiveRate: 0.25 });
    assert.equal(skillJudgeVerdict(m), 'proceed');
  });

  it('scoredCases=0 → do-not-proceed (0 < minScoredCases)', () => {
    const m = makeMetrics({ scoredCases: 0 });
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });
});
