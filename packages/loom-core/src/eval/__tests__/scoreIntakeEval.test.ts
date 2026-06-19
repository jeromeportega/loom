import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scoreIntakeEval, decideGate } from '../scoreIntakeEval.js';
import type {
  IntakeRunRecord,
  IntakeEvalCase,
  IntakeEvalReport,
  GateDecision,
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
  classifierReason?: 'timeout' | 'invalid_output' | 'llm_error',
): IntakeRunRecord {
  const classifier = predicted
    ? { ok: true as const, verdict: { ...predicted, confidence: 'high' as const, rationale: 'test' } }
    : { ok: false as const, reason: (classifierReason ?? 'llm_error') as 'timeout' | 'invalid_output' | 'llm_error', detail: 'test failure' };

  const judge =
    judgeResult === null
      ? { status: 'inconclusive' as const, detail: 'stub inconclusive' }
      : judgeResult !== undefined
        ? { status: 'ok' as const, result: { ...judgeResult, reason: judgeResult.reason ?? '' } }
        : { status: 'inconclusive' as const, detail: 'stub' };

  return { case: c, classifier, judge };
}

/** Build N identical passing records to satisfy the minScoredCases gate. */
function makePassingRecords(n: number): IntakeRunRecord[] {
  return Array.from({ length: n }, (_, i) =>
    makeRecord(
      makeCase(`pass-${i}`, 'feature', 'story'),
      { type: 'feature', size: 'story' },
      { type: 'feature', size: 'story', grade: 'agree' },
    ),
  );
}

/**
 * Build a partial report (Omit<IntakeEvalReport, 'overall'>) for decideGate tests.
 * Uses scoreIntakeEval on the given records to produce the partial shape.
 */
function partialReport(records: IntakeRunRecord[]): Omit<IntakeEvalReport, 'overall'> {
  const full = scoreIntakeEval(records);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { overall: _omit, ...rest } = full;
  return rest;
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
  // Disagreements = judge label ≠ human label (mirrors judgeVsHuman.disagree count).

  it('includes entry when judge disagrees with human label (judge=classifier, classifier wrong)', () => {
    // Human: bug. Classifier: feature (wrong). Judge: feature (agrees with classifier, disagrees with human).
    // Old code missed this case; new code correctly surfaces it as a disagreement.
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('case-x', 'bug', 'story'),
        { type: 'feature', size: 'story' },        // classifier predicts feature
        { type: 'feature', size: 'story', grade: 'agree', reason: 'Looks like a feature to me.' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;

    assert.equal(typeAxis.disagreements.length, 1, 'one disagreement (judge≠human)');
    const d = typeAxis.disagreements[0];
    assert.equal(d.caseId, 'case-x');
    assert.equal(d.labeled, 'bug');       // human label
    assert.equal(d.predicted, 'feature'); // classifier prediction
    assert.equal(d.judge, 'feature');     // judge agrees with classifier, not with human
    assert.equal(d.rationale, 'Looks like a feature to me.');
  });

  it('includes entry when judge disagrees with human even when judge=classifier', () => {
    // Same as above: both judge and classifier chose the wrong label.
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('case-y', 'chore', 'story'),
        { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree', reason: 'Expanding functionality.' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 1, 'disagreement when judge≠human label');
  });

  it('does NOT include entry when judge agrees with human label (even when judge≠classifier)', () => {
    // Human: bug. Classifier: feature (wrong). Judge: bug (agrees with human).
    // This is a classifier error caught by the judge, but NOT a judge-vs-human disagreement.
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('case-z', 'bug', 'story'),
        { type: 'feature', size: 'story' },
        { type: 'bug', size: 'story', grade: 'disagree', reason: 'This is clearly a bug fix.' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 0, 'no disagreement when judge agrees with human label');
  });

  it('records where judge agrees with both classifier and human are not in the disagreements list', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(
        makeCase('a', 'feature', 'story'),
        { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree', reason: '' },
      ),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 0, 'no disagreements when judge agrees with human');
  });

  it('inconclusive judge records are not in the disagreements list', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }, null),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.disagreements.length, 0, 'inconclusive judge produces no disagreement entry');
  });

  it('disagreements count matches judgeVsHuman.disagree count', () => {
    // Validates the count invariant: disagreements.length === judgeVsHuman.disagree.
    const records: IntakeRunRecord[] = [
      // Judge agrees with human (not a disagreement)
      makeRecord(makeCase('ok-1', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
      // Judge disagrees with human (classifier was wrong, judge agrees with classifier)
      makeRecord(makeCase('bad-1', 'bug', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),
      // Inconclusive judge (not counted in either)
      makeRecord(makeCase('inc-1', 'feature', 'story'), { type: 'feature', size: 'story' }, null),
    ];

    const report = scoreIntakeEval(records);
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(
      typeAxis.disagreements.length,
      typeAxis.judgeVsHuman.disagree,
      'disagreements array length must equal judgeVsHuman.disagree count',
    );
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
  it('counts inconclusive judges on scored (classifier.ok) records only', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' },
        { type: 'feature', size: 'story', grade: 'agree' }),  // ok judge, scored
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }, null), // inconclusive judge, scored → counts
      makeRecord(makeCase('c', 'chore', 'epic'), null),                                 // classifier fail → judge placeholder inconclusive, excluded
    ];

    const report = scoreIntakeEval(records);
    // Only record 'b' counts: scored + inconclusive judge. Record 'c' has classifier.ok=false
    // so its auto-inconclusive judge placeholder must NOT inflate the numerator.
    assert.equal(report.inconclusiveJudgeCount, 1, 'only scored records with inconclusive judge outcome count');
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

// ── failureCounts ─────────────────────────────────────────────────────────────

describe('scoreIntakeEval — failureCounts', () => {
  it('counts timeout, invalid_output, and llm_error failures separately', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }), // scored
      makeRecord(makeCase('b', 'bug', 'story'), null, undefined, 'timeout'),
      makeRecord(makeCase('c', 'chore', 'epic'), null, undefined, 'invalid_output'),
      makeRecord(makeCase('d', 'feature', 'epic'), null, undefined, 'llm_error'),
    ];

    const report = scoreIntakeEval(records);
    assert.deepEqual(report.failureCounts, {
      timeout: 1,
      invalid_output: 1,
      llm_error: 1,
      scored: 1,
      total: 4,
    });
  });

  it('all-success: scored == total, all failure types are 0', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }),
    ];

    const report = scoreIntakeEval(records);
    assert.deepEqual(report.failureCounts, {
      timeout: 0,
      invalid_output: 0,
      llm_error: 0,
      scored: 2,
      total: 2,
    });
  });

  it('all-fail: scored == 0', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), null, undefined, 'llm_error'),
      makeRecord(makeCase('b', 'bug', 'story'), null, undefined, 'llm_error'),
    ];

    const report = scoreIntakeEval(records);
    assert.deepEqual(report.failureCounts, {
      timeout: 0,
      invalid_output: 0,
      llm_error: 2,
      scored: 0,
      total: 2,
    });
  });
});

// ── thresholds ────────────────────────────────────────────────────────────────

describe('scoreIntakeEval — thresholds recorded in report', () => {
  it('report contains recorded thresholds matching the canonical values (ADR-013)', () => {
    const report = scoreIntakeEval([]);
    assert.equal(report.thresholds.minScoredCases, 18, 'minScoredCases must be 18');
    assert.equal(report.thresholds.maxClassifierFailureRate, 0.10, 'maxClassifierFailureRate must be 0.10');
    assert.equal(report.thresholds.maxJudgeInconclusiveRate, 0.10, 'maxJudgeInconclusiveRate must be 0.10');
  });
});

// ── overall — tri-state decision ──────────────────────────────────────────────

describe('scoreIntakeEval — overall.decision (tri-state gate)', () => {
  it('is INCONCLUSIVE when scored < minScoredCases (even if no confusions)', () => {
    // 17 passing records — one short of the 18 minimum
    const records = makePassingRecords(17);
    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'INCONCLUSIVE',
      'fewer than 18 scored cases must yield INCONCLUSIVE');
  });

  it('is PROCEED when 18+ records all pass with no dangerous confusions', () => {
    const records = makePassingRecords(18);
    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'PROCEED',
      '18 clean passing records must yield PROCEED');
  });

  it('is DO_NOT_PROCEED when size axis has epic→story confusion (with 18+ records)', () => {
    const records = [
      ...makePassingRecords(17),
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'DO_NOT_PROCEED',
      'epic→story confusion with enough scored cases yields DO_NOT_PROCEED');
  });

  it('overall statement is non-empty', () => {
    const report = scoreIntakeEval(makePassingRecords(18));
    assert.ok(report.overall.statement.length > 0, 'overall statement must be non-empty');
  });

  it('DO_NOT_PROCEED statement references failing axis verdict (not a hardcoded epic→story count)', () => {
    // 18 passing + 1 epic→story confusion → sizeAxis fails to clear bar
    const records = [
      ...makePassingRecords(17),
      makeRecord(makeCase('epic-a', 'feature', 'epic'), { type: 'feature', size: 'story' }),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'DO_NOT_PROCEED');
    // Statement must reference the size-axis context (not misreport via the wrong axis)
    assert.ok(
      report.overall.statement.includes('epic') || report.overall.statement.includes('under-sizing'),
      `statement must mention the failing axis reason, got: "${report.overall.statement}"`,
    );
    // Must NOT produce the old misleading "0 epic→story under-sizing" phrasing for the sizeAxis case
    assert.ok(
      !report.overall.statement.startsWith('DO NOT PROCEED: 0 epic→story'),
      `statement must not hardcode a count from the wrong axis, got: "${report.overall.statement}"`,
    );
  });
});

// ── decideGate — pure gate function (canonical all-22-fail case) ──────────────

describe('decideGate — INCONCLUSIVE when all cases fail (scored=0)', () => {
  it('all-22-fail: scored=0, decision is INCONCLUSIVE, never PROCEED', () => {
    const failedRecords: IntakeRunRecord[] = Array.from({ length: 22 }, (_, i) =>
      makeRecord(makeCase(`case-${i}`, 'feature', 'story'), null, undefined, 'llm_error'),
    );
    const report = scoreIntakeEval(failedRecords);

    assert.equal(report.failureCounts.scored, 0, 'scored must be 0 when all classifier calls fail');
    assert.equal(report.failureCounts.total, 22, 'total must be 22');
    assert.equal(report.failureCounts.llm_error, 22, 'all failures must be classified as llm_error');
    assert.notEqual(report.overall.decision, 'PROCEED', 'PROCEED is impossible when scored=0');
    assert.equal(report.overall.decision, 'INCONCLUSIVE',
      'all-22-fail must yield INCONCLUSIVE (not DO_NOT_PROCEED)');
    assert.ok(
      report.overall.statement.toLowerCase().includes('0') ||
      report.overall.statement.includes('scored'),
      `statement must surface the 0-scored-cases reason, got: "${report.overall.statement}"`,
    );
  });
});

describe('decideGate — failure-reason counts surfaced in statement', () => {
  it('INCONCLUSIVE statement names the failure breakdown when scored < min', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), null, undefined, 'timeout'),
      makeRecord(makeCase('b', 'bug', 'story'), null, undefined, 'invalid_output'),
    ];

    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'INCONCLUSIVE');
    assert.ok(
      report.overall.statement.includes('timeout') || report.overall.statement.includes('invalid_output'),
      `INCONCLUSIVE statement must include failure breakdown, got: "${report.overall.statement}"`,
    );
  });
});

describe('decideGate — classifierFailureRate threshold', () => {
  it('DO_NOT_PROCEED when classifier failure rate exceeds 10% with enough scored cases', () => {
    // 18 scored + 3 failed = 21 total; 3/21 ≈ 14.3% > 10%
    const records: IntakeRunRecord[] = [
      ...makePassingRecords(18),
      makeRecord(makeCase('f1', 'feature', 'story'), null, undefined, 'llm_error'),
      makeRecord(makeCase('f2', 'bug', 'story'), null, undefined, 'llm_error'),
      makeRecord(makeCase('f3', 'chore', 'epic'), null, undefined, 'llm_error'),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.overall.decision, 'DO_NOT_PROCEED',
      'high classifier failure rate with enough scored cases must yield DO_NOT_PROCEED');
  });

  it('PROCEED when classifier failure rate is exactly at threshold boundary (≤10%) with 18+ scored', () => {
    // 18 scored + 2 failed = 20 total; 2/20 = 10.0% which is NOT > 10%
    const records: IntakeRunRecord[] = [
      ...makePassingRecords(18),
      makeRecord(makeCase('f1', 'feature', 'story'), null, undefined, 'llm_error'),
      makeRecord(makeCase('f2', 'bug', 'story'), null, undefined, 'llm_error'),
    ];
    const report = scoreIntakeEval(records);
    // 2/20 = 10% exactly — not > 10% — and no dangerous confusions → PROCEED
    assert.notEqual(report.overall.decision, 'DO_NOT_PROCEED',
      '10% failure rate (= threshold, not >) must not trigger DO_NOT_PROCEED for this reason');
  });
});

describe('decideGate — judgeInconclusiveRate threshold', () => {
  it('INCONCLUSIVE when judge inconclusive rate exceeds 10% with enough scored cases', () => {
    // 18 scored, 0 classifier failures, 3 inconclusive judges = 3/18 ≈ 16.7% > 10%
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 15 }, (_, i) =>
        makeRecord(
          makeCase(`ok-${i}`, 'feature', 'story'),
          { type: 'feature', size: 'story' },
          { type: 'feature', size: 'story', grade: 'agree' },
        ),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        makeRecord(
          makeCase(`inc-${i}`, 'feature', 'story'),
          { type: 'feature', size: 'story' },
          null, // inconclusive judge
        ),
      ),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.failureCounts.scored, 18, 'all 18 classifiers succeeded');
    assert.equal(report.inconclusiveJudgeCount, 3, '3 inconclusive judges');
    assert.equal(report.overall.decision, 'INCONCLUSIVE',
      'high judge inconclusive rate must yield INCONCLUSIVE');
  });

  it('INCONCLUSIVE when judge inconclusive rate exceeds 10% — denominator is scored, not total', () => {
    // Setup: 18 scored + 2 classifier failures (ok judge to keep failure rate ≤10%).
    // inconclusiveJudgeCount = 2 (explicit inconclusive judges on scored records).
    // correct denominator:  2 / 18 ≈ 11.1% > 10% → INCONCLUSIVE
    // buggy denominator:    2 / 20  = 10.0%       → exactly at threshold, NOT > 10% → would silently PROCEED
    const okJudge = { type: 'feature' as const, size: 'story' as const, grade: 'agree' as const };
    const records: IntakeRunRecord[] = [
      ...Array.from({ length: 16 }, (_, i) =>
        makeRecord(makeCase(`ok-${i}`, 'feature', 'story'), { type: 'feature', size: 'story' }, okJudge),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRecord(makeCase(`inc-${i}`, 'feature', 'story'), { type: 'feature', size: 'story' }, null),
      ),
      // 2 classifier failures with an explicit ok judge so they do NOT inflate inconclusiveJudgeCount
      // and keep classifier failure rate at 2/20 = 10% (not > 10%, so no DO_NOT_PROCEED from that check)
      ...Array.from({ length: 2 }, (_, i) =>
        makeRecord(makeCase(`fail-${i}`, 'feature', 'story'), null, okJudge, 'llm_error'),
      ),
    ];
    const report = scoreIntakeEval(records);
    assert.equal(report.failureCounts.scored, 18, '18 classifiers succeeded');
    assert.equal(report.failureCounts.total, 20, '20 total records');
    assert.equal(report.inconclusiveJudgeCount, 2, '2 inconclusive judges');
    assert.equal(report.overall.decision, 'INCONCLUSIVE',
      '2/18 ≈ 11.1% must yield INCONCLUSIVE; wrong denominator 2/20 = 10.0% would not trigger the gate');
  });
});

describe('decideGate — throws when axes are incomplete', () => {
  it('throws when axes array is empty', () => {
    const pr = partialReport(makePassingRecords(20));
    const emptyAxes = { ...pr, axes: [] };
    assert.throws(
      () => decideGate(emptyAxes),
      /decideGate: axes must include both/,
      'empty axes array must throw a descriptive error',
    );
  });

  it('throws when axes array is missing the "size" entry', () => {
    const pr = partialReport(makePassingRecords(20));
    const typeOnly = { ...pr, axes: pr.axes.filter(a => a.axis === 'type') };
    assert.throws(
      () => decideGate(typeOnly),
      /decideGate: axes must include both/,
    );
  });
});

describe('decideGate — direct invocation with partial report', () => {
  it('PROCEED when partial report has all conditions passing', () => {
    const recs = makePassingRecords(20);
    const pr = partialReport(recs);
    const result = decideGate(pr);
    assert.equal(result.decision, 'PROCEED');
  });

  it('INCONCLUSIVE when scored < minScoredCases even with zero failures', () => {
    const recs = makePassingRecords(10);
    const pr = partialReport(recs);
    const result = decideGate(pr);
    assert.equal(result.decision, 'INCONCLUSIVE');
  });

  it('decision and statement are consistent (statement mentions the decision)', () => {
    const recs = makePassingRecords(18);
    const pr = partialReport(recs);
    const result = decideGate(pr);
    assert.ok(
      result.statement.toUpperCase().includes(result.decision.replaceAll('_', ' ')),
      `statement must include the decision word, got: "${result.statement}"`,
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
