import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scoreIntakeEval } from '../scoreIntakeEval.js';
import type {
  IntakeRunRecord,
  IntakeEvalCase,
} from '../intakeEvalTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCase(
  id: string,
  type: 'feature' | 'bug' | 'chore',
  size: 'story' | 'epic',
): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief: `Brief for ${id}.`,
    label: { type, size },
    rationale: `Rationale for ${id}.`,
  };
}

function makeRecord(
  c: IntakeEvalCase,
  predicted: { type: 'feature' | 'bug' | 'chore'; size: 'story' | 'epic' } | null,
  judgeResult?: { type: 'feature' | 'bug' | 'chore'; size: 'story' | 'epic'; grade: 'agree' | 'disagree'; reason?: string } | null,
): IntakeRunRecord {
  const classifier = predicted
    ? { ok: true as const, verdict: { ...predicted, confidence: 'high' as const, rationale: 'test' } }
    : { ok: false as const, reason: 'llm_error' as const, detail: 'test failure' };

  const judge =
    judgeResult === null
      ? { status: 'inconclusive' as const, detail: 'stub inconclusive' }
      : judgeResult !== undefined
        ? { status: 'ok' as const, result: { ...judgeResult, reason: judgeResult.reason ?? '' } }
        : { status: 'inconclusive' as const, detail: 'stub' };

  return { case: c, classifier, judge };
}

// ── ConfusionMatrix — raw counts, all labels present (FR-10) ─────────────────

describe('scoreIntakeEval — confusion matrix type axis', () => {
  it('initializes all 3×3 type cells to 0 even when chore count is 0', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    const { counts, labels } = typeAxis.confusion;

    assert.deepEqual(labels, ['feature', 'bug', 'chore'], 'type labels must be feature/bug/chore');

    // chore row must exist with all zeros
    assert.equal(counts['chore']['feature'], 0, 'chore→feature must be 0');
    assert.equal(counts['chore']['bug'], 0, 'chore→bug must be 0');
    assert.equal(counts['chore']['chore'], 0, 'chore→chore must be 0');
  });

  it('counts labeled→predicted correctly (raw counts)', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'feature', 'story'), { type: 'bug', size: 'story' }),  // feature labeled, bug predicted
      makeRecord(makeCase('c', 'bug', 'story'), { type: 'feature', size: 'story' }), // bug labeled, feature predicted
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    const { counts } = typeAxis.confusion;

    assert.equal(counts['feature']['feature'], 1, 'feature→feature: 1');
    assert.equal(counts['feature']['bug'], 1, 'feature→bug: 1');
    assert.equal(counts['bug']['feature'], 1, 'bug→feature: 1');
    assert.equal(counts['bug']['bug'], 0, 'bug→bug: 0');
  });

  it('classifier failures are excluded from confusion matrix counts', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'story'), null), // classifier failure
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    const { counts } = typeAxis.confusion;

    // Only one scored record (feature→feature=1)
    let total = 0;
    for (const row of Object.values(counts)) {
      for (const v of Object.values(row)) total += v;
    }
    assert.equal(total, 1, 'total matrix counts must equal number of scored records');
  });
});

describe('scoreIntakeEval — confusion matrix size axis', () => {
  it('initializes both story/epic cells including cross-confusions', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'feature', 'epic'), { type: 'feature', size: 'story' }), // epic labeled → story predicted
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;
    const { counts, labels } = sizeAxis.confusion;

    assert.deepEqual(labels, ['story', 'epic'], 'size labels must be story/epic');
    assert.equal(counts['story']['story'], 1, 'story→story: 1');
    assert.equal(counts['epic']['story'], 1, 'epic→story: 1 (under-sizing)');
    assert.equal(counts['epic']['epic'], 0, 'epic→epic: 0');
  });
});

// ── AxisReport fields — accuracy, agreement measures, disagreements ───────────

describe('scoreIntakeEval — AxisReport accuracy', () => {
  it('computes exact-match accuracy vs human label', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }), // correct both
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'chore', size: 'story' }),       // type wrong
      makeRecord(makeCase('c', 'chore', 'epic'), null),                                  // classifier failure
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.deepEqual(typeAxis.accuracy, { correct: 1, scored: 2 }, 'type: 1 correct out of 2 scored');
  });
});

describe('scoreIntakeEval — AxisReport judgeVsClassifier', () => {
  it('counts agree/disagree/inconclusive per axis', () => {
    const records: IntakeRunRecord[] = [
      // judge agrees with classifier on type
      makeRecord(
        makeCase('a', 'feature', 'story'),
        { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' },
      ),
      // judge disagrees with classifier on type
      makeRecord(
        makeCase('b', 'bug', 'story'),
        { type: 'bug', size: 'story' },
        { type: 'feature', size: 'story', grade: 'disagree', reason: 'Actually a feature.' },
      ),
      // judge inconclusive
      makeRecord(makeCase('c', 'chore', 'epic'), { type: 'chore', size: 'epic' }, null),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.deepEqual(typeAxis.judgeVsClassifier, { agree: 1, disagree: 1, inconclusive: 1 });
  });
});

describe('scoreIntakeEval — AxisReport judgeVsHuman', () => {
  it('counts judge-vs-human agreement separately from judge-vs-classifier', () => {
    const records: IntakeRunRecord[] = [
      // judge agrees with human (feature), disagrees with classifier (bug)
      makeRecord(
        makeCase('a', 'feature', 'story'),
        { type: 'bug', size: 'story' },
        { type: 'feature', size: 'story', grade: 'disagree', reason: 'Classifier wrong.' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.deepEqual(typeAxis.judgeVsClassifier, { agree: 0, disagree: 1, inconclusive: 0 },
      'judge type≠classifier type → disagree');
    assert.deepEqual(typeAxis.judgeVsHuman, { agree: 1, disagree: 0, inconclusive: 0 },
      'judge type==human type → agree');
  });
});

describe('scoreIntakeEval — AxisReport disagreements', () => {
  it('includes full disagreement entry with caseId, labeled, predicted, judge, rationale', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('case-x', 'bug', 'story'),
        { type: 'feature', size: 'story' },        // classifier predicts feature
        { type: 'bug', size: 'story', grade: 'disagree', reason: 'This is clearly a bug fix.' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.equal(typeAxis.disagreements.length, 1, 'one disagreement');
    const d = typeAxis.disagreements[0];
    assert.equal(d.caseId, 'case-x');
    assert.equal(d.labeled, 'bug');      // human label
    assert.equal(d.predicted, 'feature'); // classifier
    assert.equal(d.judge, 'bug');         // judge's type
    assert.equal(d.rationale, 'This is clearly a bug fix.');
  });

  it('records where judge agrees with classifier are not in the disagreements list', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('a', 'feature', 'story'),
        { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree', reason: '' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 0, 'no disagreements when judge agrees with classifier');
  });

  it('inconclusive judge records are not in the disagreements list', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }, null),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 0, 'inconclusive judge produces no disagreement entry');
  });
});

// ── dangerousConfusions — epic→story under-sizing (ADR-006) ──────────────────

describe('scoreIntakeEval — dangerousConfusions', () => {
  it('surfaces epic→story under-sizing with count and caseIds', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }), // under-sized!
      makeRecord(makeCase('story-b', 'feature', 'story'), { type: 'feature', size: 'story' }), // correct
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;

    assert.equal(sizeAxis.dangerousConfusions.length, 1, 'one dangerous confusion entry');
    const dc = sizeAxis.dangerousConfusions[0];
    assert.equal(dc.from, 'epic');
    assert.equal(dc.to, 'story');
    assert.equal(dc.count, 1);
    assert.deepEqual(dc.caseIds, ['epic-a']);
  });

  it('accumulates multiple epic→story confusions', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('epic-1', 'feature', 'epic'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('epic-2', 'bug', 'epic'), { type: 'bug', size: 'story' }),
      makeRecord(makeCase('story-ok', 'feature', 'story'), { type: 'feature', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;

    const dc = sizeAxis.dangerousConfusions[0];
    assert.equal(dc.count, 2);
    assert.deepEqual(dc.caseIds.sort(), ['epic-1', 'epic-2'].sort());
  });

  it('no dangerousConfusions when no under-sizing occurs', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'epic'), { type: 'feature', size: 'epic' }),
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;
    assert.equal(sizeAxis.dangerousConfusions.length, 0, 'no dangerous confusions when none present');
  });

  it('type axis has no dangerous confusions', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'bug', size: 'story' }), // type mismatch but not dangerous
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.dangerousConfusions.length, 0, 'type axis has no defined dangerous confusions');
  });
});

// ── verdict — phrased against dangerous confusion counts, not accuracy (ADR-006) ─

describe('scoreIntakeEval — verdict.statement references dangerous-cell count', () => {
  it('size axis statement mentions 0 epic→story confusions when bar is cleared', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'epic'), { type: 'feature', size: 'epic' }),
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;

    assert.ok(sizeAxis.verdict.clearsBar, 'clearsBar must be true when no dangerous confusions');
    assert.ok(
      sizeAxis.verdict.statement.includes('0'),
      `statement must reference the count 0, got: "${sizeAxis.verdict.statement}"`,
    );
    assert.ok(
      sizeAxis.verdict.statement.toLowerCase().includes('epic') ||
      sizeAxis.verdict.statement.includes('→'),
      `statement must mention epic→story context, got: "${sizeAxis.verdict.statement}"`,
    );
  });

  it('size axis statement mentions count when bar is NOT cleared', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('epic-b', 'bug', 'epic'), { type: 'bug', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    const sizeAxis = report.axes.find(a => a.axis === 'size')!;

    assert.ok(!sizeAxis.verdict.clearsBar, 'clearsBar must be false when dangerous confusions exist');
    assert.ok(
      sizeAxis.verdict.statement.includes('2'),
      `statement must reference the count 2, got: "${sizeAxis.verdict.statement}"`,
    );
  });

  it('type axis statement references dangerous confusion count (0)', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'bug', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.ok(typeAxis.verdict.clearsBar, 'type axis always clears bar (no dangerous confusions defined)');
    assert.ok(
      typeAxis.verdict.statement.includes('0'),
      `type axis statement must reference count 0, got: "${typeAxis.verdict.statement}"`,
    );
  });
});

// ── inconclusiveJudgeCount ────────────────────────────────────────────────────

describe('scoreIntakeEval — inconclusiveJudgeCount', () => {
  it('counts records with inconclusive judge status', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),  // ok
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }, null), // inconclusive
      makeRecord(makeCase('c', 'chore', 'epic'), null),                                 // classifier fail → inconclusive
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.inconclusiveJudgeCount, 2, 'two inconclusive judge outcomes');
  });

  it('is 0 when all judges returned ok', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.inconclusiveJudgeCount, 0);
  });
});

// ── overall proceed + statement ───────────────────────────────────────────────

describe('scoreIntakeEval — overall', () => {
  it('proceed=true when both axes clear their bar', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    assert.ok(report.overall.proceed, 'proceed must be true when no dangerous confusions');
  });

  it('proceed=false when size axis has epic→story confusion', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    assert.ok(!report.overall.proceed, 'proceed must be false when epic→story confusion present');
  });

  it('overall statement references dangerous confusion count (not a headline percentage)', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    assert.ok(
      report.overall.statement.includes('1'),
      `overall statement must reference the dangerous confusion count 1, got: "${report.overall.statement}"`,
    );
  });

  it('proceed statement references 0 when bar is cleared', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    assert.ok(
      report.overall.statement.includes('0'),
      `overall proceed statement should reference 0 dangerous confusions, got: "${report.overall.statement}"`,
    );
  });
});

// ── meta (model names) ────────────────────────────────────────────────────────

describe('scoreIntakeEval — metadata fields', () => {
  it('classifierModel and judgeModel default to "unknown"', () => {
    const report = scoreIntakeEval([]);
    assert.equal(report.classifierModel, 'unknown');
    assert.equal(report.judgeModel, 'unknown');
  });

  it('accepts model names via meta parameter', () => {
    const report = scoreIntakeEval([], { classifierModel: 'claude-haiku-4-5-20251001', judgeModel: 'claude-opus-4-8' });
    assert.equal(report.classifierModel, 'claude-haiku-4-5-20251001');
    assert.equal(report.judgeModel, 'claude-opus-4-8');
  });

  it('generatedFromCases reflects record count', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'epic'), { type: 'bug', size: 'epic' }),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.generatedFromCases, 2);
  });
});

// ── axes order ────────────────────────────────────────────────────────────────

describe('scoreIntakeEval — axes order', () => {
  it('axes array has type first, then size', () => {
    const report = scoreIntakeEval([]);
    assert.equal(report.axes.length, 2);
    assert.equal(report.axes[0].axis, 'type');
    assert.equal(report.axes[1].axis, 'size');
  });
});

// ── failureCounts — breakdown by classifier reason and judgeInconclusive ─────

describe('scoreIntakeEval — failureCounts', () => {
  it('all zeros when every case has ok classifier and ok judge', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
    ];

    const report = scoreIntakeEval(records);
    assert.deepEqual(report.failureCounts, {
      classifier: { llm_error: 0, timeout: 0, invalid_output: 0 },
      judgeInconclusive: 0,
    });
  });

  it('counts llm_error, timeout, invalid_output classifier failures separately', () => {
    const caseA = makeCase('a', 'feature', 'story');
    const caseB = makeCase('b', 'bug', 'story');
    const caseC = makeCase('c', 'chore', 'epic');

    const records: IntakeRunRecord[] = [
      { case: caseA, classifier: { ok: false, reason: 'llm_error', detail: 'err' },
        judge: { status: 'inconclusive', detail: 'classifier_failure: llm_error' } },
      { case: caseB, classifier: { ok: false, reason: 'timeout', detail: 'timed out' },
        judge: { status: 'inconclusive', detail: 'classifier_failure: timeout' } },
      { case: caseC, classifier: { ok: false, reason: 'invalid_output', detail: 'bad json' },
        judge: { status: 'inconclusive', detail: 'classifier_failure: invalid_output' } },
    ];

    const report = scoreIntakeEval(records);
    assert.deepEqual(report.failureCounts.classifier, {
      llm_error: 1,
      timeout: 1,
      invalid_output: 1,
    });
  });

  it('counts judgeInconclusive including those caused by classifier failure', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), null),      // classifier fail → judge inconclusive
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }, null), // judge inconclusive independently
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.failureCounts.judgeInconclusive, 2, 'both records produce inconclusive judge');
    assert.equal(report.failureCounts.classifier.llm_error, 1, 'one classifier failure');
  });

  it('judgeInconclusive does not double-count ok judge records', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }, null),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.failureCounts.judgeInconclusive, 1, 'only the inconclusive judge is counted');
  });
});

// ── scoredCases — ok classifier AND conclusive judge ─────────────────────────

describe('scoreIntakeEval — scoredCases', () => {
  it('is 0 when records array is empty', () => {
    const report = scoreIntakeEval([]);
    assert.equal(report.scoredCases, 0);
  });

  it('counts only records with ok classifier AND ok judge', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),   // scored
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }, null),  // ok classifier, inconclusive judge → NOT scored
      makeRecord(makeCase('c', 'chore', 'epic'), null),         // classifier fail → NOT scored
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.scoredCases, 1, 'only the fully-graded case counts as scored');
  });

  it('counts all records when every classifier and judge succeeds', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
      makeRecord(makeCase('b', 'bug', 'epic'), { type: 'bug', size: 'epic' },
        { type: 'bug', size: 'epic', grade: 'agree' }),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.scoredCases, 2);
  });
});

// ── gate — fail-closed (FR-9, FR-10) ─────────────────────────────────────────

describe('scoreIntakeEval — gate: inconclusive when below minimum scored cases', () => {
  it('is inconclusive when records is empty', () => {
    const report = scoreIntakeEval([]);
    assert.equal(report.gate.decision, 'inconclusive');
    assert.ok(report.gate.statement.toLowerCase().includes('inconclusive') ||
      report.gate.statement.toLowerCase().includes('minimum'),
      `statement should mention minimum, got: "${report.gate.statement}"`);
  });

  it('is inconclusive when scoredCases < minScoredCases (fewer than 5)', () => {
    // 4 fully-scored records — one short of the minimum
    const records: IntakeRunRecord[] = Array.from({ length: 4 }, (_, i) =>
      makeRecord(makeCase(`a${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
    );

    const report = scoreIntakeEval(records);
    assert.equal(report.gate.decision, 'inconclusive');
    assert.ok(
      report.gate.statement.includes('4'),
      `statement should mention scored count 4, got: "${report.gate.statement}"`,
    );
  });

  it('is NOT inconclusive for the min-scored-cases reason when exactly at the threshold', () => {
    // 5 fully-scored records — exactly at MIN_SCORED_CASES
    const records: IntakeRunRecord[] = Array.from({ length: 5 }, (_, i) =>
      makeRecord(makeCase(`a${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
    );

    const report = scoreIntakeEval(records);
    // Should not be inconclusive due to insufficient scored cases; quality bar is met here
    assert.equal(report.gate.decision, 'proceed');
  });

  it('gate.minScoredCases is documented (non-zero positive integer)', () => {
    const report = scoreIntakeEval([]);
    assert.ok(
      Number.isInteger(report.gate.minScoredCases) && report.gate.minScoredCases > 0,
      'minScoredCases must be a positive integer',
    );
  });
});

describe('scoreIntakeEval — gate: inconclusive when classifier failure rate is high', () => {
  it('is inconclusive when more than 25% of classifiers fail', () => {
    // 10 records: 3 classifier failures (30% > 25%), 7 ok
    // Give enough ok records for scoredCases to pass the minimum
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        makeRecord(makeCase(`ok${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeRecord(makeCase(`fail${i}`, 'bug', 'story'), null),  // classifier fail
      ),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.gate.decision, 'inconclusive',
      'high classifier failure rate must yield inconclusive, not proceed');
    assert.ok(
      report.gate.statement.toLowerCase().includes('classifier failure') ||
      report.gate.statement.toLowerCase().includes('failure rate'),
      `statement should mention failure rate, got: "${report.gate.statement}"`,
    );
  });

  it('proceeds when classifier failure rate is at or below 25%', () => {
    // 8 records: 2 classifier failures (25% = at threshold), 6 ok
    // The at-threshold case should NOT trigger the inconclusive path
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeRecord(makeCase(`ok${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRecord(makeCase(`fail${i}`, 'bug', 'story'), null),
      ),
    ];

    const report = scoreIntakeEval(records);
    // 25% is exactly the threshold; >25% triggers inconclusive, 25% does not
    assert.notEqual(report.gate.decision, 'inconclusive',
      '25% failure rate must not trigger the high-failure-rate inconclusive path');
  });
});

describe('scoreIntakeEval — gate: inconclusive when judge-inconclusive rate is high', () => {
  it('is inconclusive when more than 25% of judges are inconclusive (classifier ok)', () => {
    // 8 records: 3 judge-inconclusive (37.5% > 25%), 5 ok classifier+judge
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeRecord(makeCase(`ok${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeRecord(makeCase(`inconc${i}`, 'bug', 'story'), { type: 'bug', size: 'story' }, null),
      ),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.gate.decision, 'inconclusive',
      'high judge-inconclusive rate must yield inconclusive');
    assert.ok(
      report.gate.statement.toLowerCase().includes('inconclusive'),
      `statement should mention inconclusive, got: "${report.gate.statement}"`,
    );
  });
});

describe('scoreIntakeEval — gate: proceed and do-not-proceed decisions', () => {
  function make5GoodRecords(): IntakeRunRecord[] {
    return Array.from({ length: 5 }, (_, i) =>
      makeRecord(makeCase(`good${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
    );
  }

  it('is proceed when quality bar is met, scoredCases >= minimum, and failure rates are low', () => {
    const report = scoreIntakeEval(make5GoodRecords());
    assert.equal(report.gate.decision, 'proceed');
    assert.ok(report.gate.statement.toLowerCase().includes('proceed'));
  });

  it('is do-not-proceed when epic→story under-sizing is detected and failure rates are acceptable', () => {
    // 4 good records + 1 epic→story confusion = 5 scored cases; 0 classifier failures
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeRecord(makeCase(`good${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' }),
      ),
      makeRecord(makeCase('epic-fail', 'feature', 'epic'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'epic', grade: 'disagree', reason: 'Under-sized.' }),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.gate.decision, 'do-not-proceed');
    assert.ok(
      report.gate.statement.toLowerCase().includes('do-not-proceed') ||
      report.gate.statement.toLowerCase().includes('failed') ||
      report.gate.statement.toLowerCase().includes('under-sizing'),
      `statement should mention do-not-proceed or failure, got: "${report.gate.statement}"`,
    );
  });

  it('gate statement for proceed mentions scored case count', () => {
    const report = scoreIntakeEval(make5GoodRecords());
    assert.ok(
      report.gate.statement.includes('5'),
      `proceed statement must reference scored count 5, got: "${report.gate.statement}"`,
    );
  });

  it('gate statement for do-not-proceed mentions the under-sizing count', () => {
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeRecord(makeCase(`good${i}`, 'feature', 'story'), { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' }),
      ),
      makeRecord(makeCase('epic-fail', 'feature', 'epic'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'epic', grade: 'disagree', reason: 'Under-sized.' }),
    ];

    const report = scoreIntakeEval(records);
    assert.ok(
      report.gate.statement.includes('1'),
      `do-not-proceed statement must reference the confusion count 1, got: "${report.gate.statement}"`,
    );
  });
});
