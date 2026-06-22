import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreLessonExtractor,
  lessonExtractorVerdict,
  LESSON_EXTRACTOR_THRESHOLDS,
} from '../score.js';
import type { LessonExtractorMetrics } from '../score.js';
import { decide } from '../../framework/decide.js';
import type { RunRecord } from '../../framework/types.js';
import type { Lesson } from '../../../findings/lesson.js';
import type { LessonExtractorJudgment } from '../judgeTypes.js';

// ── Record builders ───────────────────────────────────────────────────────────

function makeJudgment(overrides: Partial<LessonExtractorJudgment> = {}): LessonExtractorJudgment {
  return {
    total_lessons:        3,
    faithfulness:         0.9,
    usefulness:           0.8,
    coverage:             'full',
    hallucinated_lessons: 0,
    over_extraction:      false,
    reason:               'test',
    ...overrides,
  };
}

function okRecord(
  id: string,
  judgment: Partial<LessonExtractorJudgment> = {},
): RunRecord<Lesson[], LessonExtractorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'ok', output: [] },
    judge:  { status: 'ok', judgment: makeJudgment(judgment) },
  };
}

function gateFailedRecord(id: string): RunRecord<Lesson[], LessonExtractorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'failed', detail: 'error' },
    judge:  { status: 'skipped' },
  };
}

function judgeInconclusiveRecord(id: string): RunRecord<Lesson[], LessonExtractorJudgment> {
  return {
    caseId: id,
    gate:   { status: 'ok', output: [] },
    judge:  { status: 'inconclusive', detail: 'judge failed' },
  };
}

function passingMetrics(overrides: Partial<LessonExtractorMetrics> = {}): LessonExtractorMetrics {
  return {
    totalCases:           4,
    scoredCases:          4,
    gateFailures:         0,
    gateFailureRate:      0,
    judgeInconclusive:    0,
    judgeInconclusiveRate: 0,
    faithfulness:         0.90,
    usefulness:           0.80,
    coverage:             0.80,
    hallucinationRate:    0.05,
    overExtractionRate:   0.00,
    ...overrides,
  };
}

// ── Empty / zero ──────────────────────────────────────────────────────────────

describe('scoreLessonExtractor — empty input', () => {
  it('returns zero metrics for an empty record list', () => {
    const m = scoreLessonExtractor([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.usefulness, 0);
    assert.equal(m.coverage, 0);
    assert.equal(m.hallucinationRate, 0);
    assert.equal(m.overExtractionRate, 0);
  });

  it('returns zero lesson-extractor metrics when all gates failed', () => {
    const records = [gateFailedRecord('c1'), gateFailedRecord('c2')];
    const m = scoreLessonExtractor(records);
    assert.equal(m.totalCases, 2);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.gateFailures, 2);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.usefulness, 0);
    assert.equal(m.coverage, 0);
    assert.equal(m.hallucinationRate, 0);
    assert.equal(m.overExtractionRate, 0);
  });

  it('returns zero lesson-extractor metrics when all judges inconclusive', () => {
    const records = [judgeInconclusiveRecord('c1'), judgeInconclusiveRecord('c2')];
    const m = scoreLessonExtractor(records);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.usefulness, 0);
    assert.equal(m.coverage, 0);
    assert.equal(m.hallucinationRate, 0);
    assert.equal(m.overExtractionRate, 0);
  });
});

// ── Aggregation math — faithfulness ───────────────────────────────────────────

describe('scoreLessonExtractor — faithfulness', () => {
  it('faithfulness = mean faithfulness over scored cases (exact)', () => {
    const records = [
      okRecord('c1', { faithfulness: 0.5 }),
      okRecord('c2', { faithfulness: 1.0 }),
      okRecord('c3', { faithfulness: 0.5 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.scoredCases, 3);
    const expected = (0.5 + 1.0 + 0.5) / 3;
    assert.ok(Math.abs(m.faithfulness - expected) < 1e-9, `expected ${expected}, got ${m.faithfulness}`);
  });

  it('faithfulness = 1.0 when all records have faithfulness=1', () => {
    const records = [
      okRecord('c1', { faithfulness: 1.0 }),
      okRecord('c2', { faithfulness: 1.0 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.faithfulness, 1.0);
  });

  it('faithfulness = 0.0 when all records have faithfulness=0', () => {
    const records = [
      okRecord('c1', { faithfulness: 0.0 }),
      okRecord('c2', { faithfulness: 0.0 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.faithfulness, 0.0);
  });
});

// ── Aggregation math — usefulness ─────────────────────────────────────────────

describe('scoreLessonExtractor — usefulness', () => {
  it('usefulness = mean usefulness over scored cases (exact)', () => {
    const records = [
      okRecord('c1', { usefulness: 0.6 }),
      okRecord('c2', { usefulness: 0.8 }),
    ];
    const m = scoreLessonExtractor(records);
    const expected = (0.6 + 0.8) / 2;
    assert.ok(Math.abs(m.usefulness - expected) < 1e-9, `expected ${expected}, got ${m.usefulness}`);
  });

  it('usefulness = 0 when all records have usefulness=0', () => {
    const records = [
      okRecord('c1', { usefulness: 0 }),
      okRecord('c2', { usefulness: 0 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.usefulness, 0);
  });
});

// ── Aggregation math — coverage mapping ───────────────────────────────────────

describe('scoreLessonExtractor — coverage', () => {
  it('coverage: full=1, partial=0.5, missing=0 — exact average from known inputs', () => {
    const records = [
      okRecord('c1', { coverage: 'full' }),
      okRecord('c2', { coverage: 'partial' }),
      okRecord('c3', { coverage: 'missing' }),
    ];
    const m = scoreLessonExtractor(records);
    // (1 + 0.5 + 0) / 3 = 0.5
    assert.ok(Math.abs(m.coverage - 0.5) < 1e-9, `expected 0.5, got ${m.coverage}`);
  });

  it('coverage = 1.0 when all records have coverage=full', () => {
    const records = [
      okRecord('c1', { coverage: 'full' }),
      okRecord('c2', { coverage: 'full' }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.coverage, 1.0);
  });

  it('coverage = 0.5 when all records have coverage=partial', () => {
    const records = [
      okRecord('c1', { coverage: 'partial' }),
      okRecord('c2', { coverage: 'partial' }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.coverage, 0.5);
  });

  it('coverage = 0.0 when all records have coverage=missing', () => {
    const records = [
      okRecord('c1', { coverage: 'missing' }),
      okRecord('c2', { coverage: 'missing' }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.coverage, 0.0);
  });
});

// ── Aggregation math — hallucinationRate ──────────────────────────────────────

describe('scoreLessonExtractor — hallucinationRate', () => {
  it('hallucinationRate = Σ hallucinated_lessons / Σ total_lessons (exact)', () => {
    const records = [
      okRecord('c1', { total_lessons: 4, hallucinated_lessons: 1 }),
      okRecord('c2', { total_lessons: 6, hallucinated_lessons: 2 }),
    ];
    const m = scoreLessonExtractor(records);
    // (1+2) / (4+6) = 3/10 = 0.3
    assert.ok(Math.abs(m.hallucinationRate - 0.3) < 1e-9, `expected 0.3, got ${m.hallucinationRate}`);
  });

  it('divide-by-zero guard: Σ total_lessons === 0 → hallucinationRate = 0, not NaN', () => {
    const records = [
      okRecord('c1', { total_lessons: 0, hallucinated_lessons: 0 }),
      okRecord('c2', { total_lessons: 0, hallucinated_lessons: 0 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.hallucinationRate, 0);
    assert.ok(!Number.isNaN(m.hallucinationRate), 'hallucinationRate must not be NaN');
  });

  it('hallucinationRate = 0 when no lessons are hallucinated', () => {
    const records = [
      okRecord('c1', { total_lessons: 3, hallucinated_lessons: 0 }),
      okRecord('c2', { total_lessons: 5, hallucinated_lessons: 0 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.hallucinationRate, 0);
  });

  it('hallucinationRate = 1.0 when all lessons are hallucinated', () => {
    const records = [
      okRecord('c1', { total_lessons: 3, hallucinated_lessons: 3 }),
      okRecord('c2', { total_lessons: 2, hallucinated_lessons: 2 }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.hallucinationRate, 1.0);
  });
});

// ── Aggregation math — overExtractionRate ─────────────────────────────────────

describe('scoreLessonExtractor — overExtractionRate', () => {
  it('overExtractionRate = fraction of scored cases with over_extraction === true (exact)', () => {
    const records = [
      okRecord('c1', { over_extraction: true }),
      okRecord('c2', { over_extraction: false }),
      okRecord('c3', { over_extraction: true }),
      okRecord('c4', { over_extraction: false }),
    ];
    const m = scoreLessonExtractor(records);
    // 2 out of 4 = 0.5
    assert.ok(Math.abs(m.overExtractionRate - 0.5) < 1e-9, `expected 0.5, got ${m.overExtractionRate}`);
  });

  it('overExtractionRate = 0 when no cases have over_extraction', () => {
    const records = [
      okRecord('c1', { over_extraction: false }),
      okRecord('c2', { over_extraction: false }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.overExtractionRate, 0);
  });

  it('overExtractionRate = 1.0 when all cases have over_extraction', () => {
    const records = [
      okRecord('c1', { over_extraction: true }),
      okRecord('c2', { over_extraction: true }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.overExtractionRate, 1.0);
  });
});

// ── CoreMetrics delegation ────────────────────────────────────────────────────

describe('scoreLessonExtractor — CoreMetrics fields populated correctly', () => {
  it('all six coreMetrics fields are present', () => {
    const m = scoreLessonExtractor([okRecord('c1')]);
    assert.ok('totalCases' in m);
    assert.ok('scoredCases' in m);
    assert.ok('gateFailures' in m);
    assert.ok('gateFailureRate' in m);
    assert.ok('judgeInconclusive' in m);
    assert.ok('judgeInconclusiveRate' in m);
  });

  it('gateFailureRate = gateFailures / totalCases', () => {
    const records = [
      okRecord('c1'),
      gateFailedRecord('c2'),
      gateFailedRecord('c3'),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.totalCases, 3);
    assert.equal(m.gateFailures, 2);
    assert.ok(Math.abs(m.gateFailureRate - 2 / 3) < 1e-9);
  });

  it('gate-failed and inconclusive records excluded from scored denominator', () => {
    const records = [
      okRecord('c1'),
      gateFailedRecord('c2'),
      judgeInconclusiveRecord('c3'),
      okRecord('c4'),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(m.totalCases, 4);
    assert.equal(m.scoredCases, 2);
    assert.equal(m.gateFailures, 1);
    assert.equal(m.judgeInconclusive, 1);
  });
});

// ── lessonExtractorVerdict — quality threshold bars ───────────────────────────

describe('lessonExtractorVerdict — quality threshold bars', () => {
  it('all thresholds clear → proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics()), 'proceed');
  });

  it('faithfulness < 0.80 → do-not-proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ faithfulness: 0.79 })), 'do-not-proceed');
  });

  it('faithfulness exactly 0.80 → proceed (boundary inclusive)', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ faithfulness: 0.80 })), 'proceed');
  });

  it('usefulness < 0.70 → do-not-proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ usefulness: 0.69 })), 'do-not-proceed');
  });

  it('usefulness exactly 0.70 → proceed (boundary inclusive)', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ usefulness: 0.70 })), 'proceed');
  });

  it('coverage < 0.70 → do-not-proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ coverage: 0.69 })), 'do-not-proceed');
  });

  it('coverage exactly 0.70 → proceed (boundary inclusive)', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ coverage: 0.70 })), 'proceed');
  });

  it('hallucinationRate > 0.10 → do-not-proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ hallucinationRate: 0.11 })), 'do-not-proceed');
  });

  it('hallucinationRate exactly 0.10 → proceed (boundary not exceeded)', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ hallucinationRate: 0.10 })), 'proceed');
  });

  it('overExtractionRate > 0.20 → do-not-proceed', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ overExtractionRate: 0.21 })), 'do-not-proceed');
  });

  it('overExtractionRate exactly 0.20 → proceed (boundary not exceeded)', () => {
    assert.equal(lessonExtractorVerdict(passingMetrics({ overExtractionRate: 0.20 })), 'proceed');
  });

  it('hallucinationRate alone just above 0.10 drives do-not-proceed (all other metrics pass)', () => {
    const m = passingMetrics({ hallucinationRate: 0.11 });
    assert.equal(lessonExtractorVerdict(m), 'do-not-proceed');
  });

  it('overExtractionRate alone above 0.20 drives do-not-proceed (all other metrics pass)', () => {
    const m = passingMetrics({ overExtractionRate: 0.21 });
    assert.equal(lessonExtractorVerdict(m), 'do-not-proceed');
  });
});

// ── AC-mandated pair: degraded → fail, good → pass ────────────────────────────

describe('scoreLessonExtractor + lessonExtractorVerdict — AC pair', () => {
  it('deliberately degraded record set → do-not-proceed', () => {
    const records = [
      okRecord('c1', {
        faithfulness:         0.3,
        usefulness:           0.3,
        coverage:             'missing',
        total_lessons:        5,
        hallucinated_lessons: 4,
        over_extraction:      true,
      }),
      okRecord('c2', {
        faithfulness:         0.2,
        usefulness:           0.2,
        coverage:             'missing',
        total_lessons:        5,
        hallucinated_lessons: 3,
        over_extraction:      true,
      }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(lessonExtractorVerdict(m), 'do-not-proceed');
  });

  it('known-good record set → proceed', () => {
    const records = [
      okRecord('c1', {
        faithfulness:         0.95,
        usefulness:           0.90,
        coverage:             'full',
        total_lessons:        4,
        hallucinated_lessons: 0,
        over_extraction:      false,
      }),
      okRecord('c2', {
        faithfulness:         0.85,
        usefulness:           0.80,
        coverage:             'full',
        total_lessons:        3,
        hallucinated_lessons: 0,
        over_extraction:      false,
      }),
    ];
    const m = scoreLessonExtractor(records);
    assert.equal(lessonExtractorVerdict(m), 'proceed');
  });
});

// ── Fail-closed structural via decide() ──────────────────────────────────────

describe('LESSON_EXTRACTOR_THRESHOLDS', () => {
  it('has expected values (minScoredCases=2, ADR-006)', () => {
    assert.equal(LESSON_EXTRACTOR_THRESHOLDS.minScoredCases, 2);
    assert.equal(LESSON_EXTRACTOR_THRESHOLDS.maxGateFailureRate, 0.25);
    assert.equal(LESSON_EXTRACTOR_THRESHOLDS.maxJudgeInconclusiveRate, 0.25);
  });
});

describe('decide() + LESSON_EXTRACTOR_THRESHOLDS — structural fail-closed', () => {
  it('scoredCases = 0 → inconclusive (never proceed by omission)', () => {
    const d = decide(passingMetrics({ scoredCases: 0 }), LESSON_EXTRACTOR_THRESHOLDS, lessonExtractorVerdict);
    assert.equal(d.verdict, 'inconclusive');
  });

  it('scoredCases = 1 (< 2) → inconclusive', () => {
    const d = decide(passingMetrics({ scoredCases: 1 }), LESSON_EXTRACTOR_THRESHOLDS, lessonExtractorVerdict);
    assert.equal(d.verdict, 'inconclusive');
    assert.ok(d.reasons.some(r => r.includes('scoredCases')));
  });

  it('scoredCases exactly 2 → structural check passes (not inconclusive on count alone)', () => {
    const d = decide(passingMetrics({ scoredCases: 2 }), LESSON_EXTRACTOR_THRESHOLDS, lessonExtractorVerdict);
    assert.notEqual(d.verdict, 'inconclusive');
  });

  it('gateFailureRate > 0.25 → inconclusive', () => {
    // totalCases=6, gateFailures=2, scoredCases=4 → gateFailureRate=2/6≈0.333>0.25; self-consistent
    const d = decide(
      passingMetrics({ totalCases: 6, gateFailures: 2, scoredCases: 4, gateFailureRate: 2 / 6 }),
      LESSON_EXTRACTOR_THRESHOLDS,
      lessonExtractorVerdict,
    );
    assert.equal(d.verdict, 'inconclusive');
  });

  it('gateFailureRate exactly 0.25 → not inconclusive on gateFailureRate alone', () => {
    // totalCases=4, gateFailures=1, scoredCases=3 → gateFailureRate=1/4=0.25; self-consistent
    const d = decide(
      passingMetrics({ totalCases: 4, gateFailures: 1, scoredCases: 3, gateFailureRate: 0.25 }),
      LESSON_EXTRACTOR_THRESHOLDS,
      lessonExtractorVerdict,
    );
    assert.notEqual(d.verdict, 'inconclusive');
  });

  it('judgeInconclusiveRate > 0.25 → inconclusive', () => {
    // totalCases=6, judgeInconclusive=2, scoredCases=4 → judgeInconclusiveRate=2/6≈0.333>0.25; self-consistent
    const d = decide(
      passingMetrics({ totalCases: 6, judgeInconclusive: 2, scoredCases: 4, judgeInconclusiveRate: 2 / 6 }),
      LESSON_EXTRACTOR_THRESHOLDS,
      lessonExtractorVerdict,
    );
    assert.equal(d.verdict, 'inconclusive');
  });

  it('judgeInconclusiveRate exactly 0.25 → not inconclusive on judgeInconclusiveRate alone', () => {
    // totalCases=4, judgeInconclusive=1, scoredCases=3 → judgeInconclusiveRate=1/4=0.25; self-consistent
    const d = decide(
      passingMetrics({ totalCases: 4, judgeInconclusive: 1, scoredCases: 3, judgeInconclusiveRate: 0.25 }),
      LESSON_EXTRACTOR_THRESHOLDS,
      lessonExtractorVerdict,
    );
    assert.notEqual(d.verdict, 'inconclusive');
  });

  it('all structural clear + quality clear → proceed', () => {
    const d = decide(passingMetrics(), LESSON_EXTRACTOR_THRESHOLDS, lessonExtractorVerdict);
    assert.equal(d.verdict, 'proceed');
    assert.deepEqual(d.reasons, []);
  });

  it('all structural clear + quality fail (faithfulness below bar) → do-not-proceed', () => {
    const d = decide(passingMetrics({ faithfulness: 0.50 }), LESSON_EXTRACTOR_THRESHOLDS, lessonExtractorVerdict);
    assert.equal(d.verdict, 'do-not-proceed');
  });
});
