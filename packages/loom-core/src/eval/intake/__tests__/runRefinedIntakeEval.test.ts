import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { runRefinedIntakeEval } from '../runRefinedIntakeEval.js';
import { scoreIntakeEval } from '../scoreIntakeEval.js';
import type {
  IntakeEvalCase,
  RefinedCaseResult,
  IntakeJudgeLike,
  IntakeVerdict,
  JudgeOutcome,
} from '../intakeEvalTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_MODEL = 'claude-opus-4-8';

function makeCase(
  id: string,
  type: 'feature' | 'bug' | 'chore' = 'feature',
  size: 'story' | 'epic' = 'story',
  brief = `Brief for ${id}`,
): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief,
    label: { type, size },
    rationale: `Rationale for ${id}`,
  };
}

function validVerdictJson(type: 'feature' | 'bug' | 'chore', size: 'story' | 'epic'): string {
  const v: IntakeVerdict = { type, size, confidence: 'high', rationale: 'Test.' };
  return JSON.stringify(v);
}

function okResult(c: IntakeEvalCase, qualityScore = 8): RefinedCaseResult {
  return { ok: true, case: c, qualityScore };
}

function failResult(
  caseId: string,
  reason: 'no_refined_brief' | 'refiner_error' = 'no_refined_brief',
): RefinedCaseResult {
  return { ok: false, caseId, reason, detail: `mock failure for ${caseId}` };
}

/** Judge spy: records every (brief, verdict) pair it receives. */
class SpyJudge implements IntakeJudgeLike {
  readonly briefs: string[] = [];
  private response: JudgeOutcome;

  constructor(response?: JudgeOutcome) {
    this.response = response ?? {
      status: 'ok',
      result: { type: 'feature', size: 'story', grade: 'agree', reason: '' },
    };
  }

  async judge(brief: string, _verdict: IntakeVerdict): Promise<JudgeOutcome> {
    this.briefs.push(brief);
    return this.response;
  }
}

/** Stub judge that always returns inconclusive — for tests where judge result doesn't matter. */
const inconclusiveJudge: IntakeJudgeLike = {
  async judge(): Promise<JudgeOutcome> {
    return { status: 'inconclusive', detail: 'stub' };
  },
};

// ── runRefinedIntakeEval — ok cases use the UNCHANGED runIntakeEval ───────────

describe('runRefinedIntakeEval — ok case: classifier receives refined brief (ADR-004)', () => {
  it('user message sent to classifier is the refined brief text, not raw', async () => {
    const rawCase = makeCase('a', 'feature', 'story', 'raw brief text');
    const refinedCase = { ...rawCase, brief: 'refined brief text' };
    const refined: RefinedCaseResult[] = [okResult(refinedCase)];

    const llm = new MockLLMClient([validVerdictJson('feature', 'story')]);
    const judge = new SpyJudge();

    await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge,
    });

    // classifyIntake places the brief as the user message content.
    const userMsg = llm.requests[0]?.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'classifier must have been called');
    assert.equal(userMsg.content, 'refined brief text', 'classifier receives the refined brief (ADR-004)');
    assert.notEqual(userMsg.content, 'raw brief text', 'must NOT receive the raw brief');
  });

  it('judge receives refined brief text, not raw (ADR-004)', async () => {
    const rawCase = makeCase('b', 'bug', 'story', 'original brief');
    const refinedCase = { ...rawCase, brief: 'improved brief' };
    const refined: RefinedCaseResult[] = [okResult(refinedCase)];

    const llm = new MockLLMClient([validVerdictJson('bug', 'story')]);
    const judge = new SpyJudge();

    await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge,
    });

    assert.equal(judge.briefs.length, 1, 'judge called once for ok case');
    assert.equal(judge.briefs[0], 'improved brief', 'judge receives refined brief (ADR-004)');
  });

  it('output record carries the refined case (with refined brief) as case field', async () => {
    const c = makeCase('id-ok', 'chore', 'epic', 'refined text');
    const refined: RefinedCaseResult[] = [okResult(c)];
    const llm = new MockLLMClient([validVerdictJson('chore', 'epic')]);

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].case.id, 'id-ok');
    assert.equal(records[0].case.brief, 'refined text');
    assert.equal(records[0].case.label.type, 'chore', 'label carried over (ADR-003)');
    assert.equal(records[0].case.label.size, 'epic', 'label carried over (ADR-003)');
    assert.ok(records[0].classifier.ok, 'classifier succeeded');
  });
});

// ── runRefinedIntakeEval — ok:false cases synthesize failure records ──────────

describe('runRefinedIntakeEval — ok:false case: synthesize failure record (ADR-005)', () => {
  it('failure record has classifier {ok:false, reason:llm_error, detail:"refiner: <reason>"}', async () => {
    const refined: RefinedCaseResult[] = [
      failResult('fail-case', 'no_refined_brief'),
    ];

    const llm = new MockLLMClient([]); // no LLM calls expected
    const judge = new SpyJudge();

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge,
    });

    assert.equal(records.length, 1, 'same N as input');
    const r = records[0];
    assert.ok(!r.classifier.ok, 'classifier must be ok:false');
    if (r.classifier.ok) return;
    assert.equal(r.classifier.reason, 'llm_error', 'reason must be llm_error (ADR-005)');
    assert.equal(
      r.classifier.detail,
      'refiner: no_refined_brief',
      'detail encodes the refiner reason',
    );
  });

  it('refiner_error variant is also encoded in the detail', async () => {
    const refined: RefinedCaseResult[] = [failResult('err-case', 'refiner_error')];

    const records = await runRefinedIntakeEval(refined, {
      llm: new MockLLMClient([]),
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.ok(!records[0].classifier.ok);
    if (records[0].classifier.ok) return;
    assert.equal(records[0].classifier.detail, 'refiner: refiner_error');
  });

  it('LLM is not called for a failure record', async () => {
    const refined: RefinedCaseResult[] = [failResult('no-llm')];
    const llm = new MockLLMClient([]);

    await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(llm.requests.length, 0, 'no LLM calls for a refiner failure case');
  });

  it('judge is not called for a failure record', async () => {
    const refined: RefinedCaseResult[] = [failResult('no-judge')];
    const judge = new SpyJudge();

    await runRefinedIntakeEval(refined, {
      llm: new MockLLMClient([]),
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge,
    });

    assert.equal(judge.briefs.length, 0, 'judge must not be called for a failure case');
  });
});

// ── runRefinedIntakeEval — order and N preservation ──────────────────────────

describe('runRefinedIntakeEval — output order and N match input', () => {
  it('mixed ok/fail: output length equals input length, order preserved', async () => {
    const cA = makeCase('a', 'feature', 'story', 'refined-a');
    const cC = makeCase('c', 'bug', 'epic', 'refined-c');

    const refined: RefinedCaseResult[] = [
      okResult(cA),
      failResult('b', 'no_refined_brief'),
      okResult(cC),
    ];

    const llm = new MockLLMClient([
      validVerdictJson('feature', 'story'), // for a
      validVerdictJson('bug', 'epic'),      // for c
    ]);

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 3, 'same N as input');
    assert.equal(records[0].case.id, 'a', 'first: ok case');
    assert.ok(records[0].classifier.ok);
    assert.ok(!records[1].classifier.ok, 'second: failure case');
    assert.equal(records[2].case.id, 'c', 'third: ok case');
    assert.ok(records[2].classifier.ok);
  });

  it('all ok:false: no LLM calls, N failure records returned', async () => {
    const refined: RefinedCaseResult[] = [
      failResult('x'),
      failResult('y'),
    ];
    const llm = new MockLLMClient([]);

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 2, 'same N even if all fail');
    assert.equal(llm.requests.length, 0, 'no LLM calls when all cases fail');
    assert.ok(!records[0].classifier.ok);
    assert.ok(!records[1].classifier.ok);
  });

  it('empty input returns empty output', async () => {
    const records = await runRefinedIntakeEval([], {
      llm: new MockLLMClient([]),
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 0);
  });
});

// ── same-axis scoring: feed to scoreIntakeEval (AC3) ─────────────────────────

describe('runRefinedIntakeEval + scoreIntakeEval — same-axis scoring (AC3)', () => {
  it('produces IntakeEvalReport with per-axis accuracy, confusion matrix, and gate', async () => {
    // Build 6 ok cases so gate thresholds are satisfied (MIN_SCORED_CASES=5).
    // scoredCases = ok classifier + conclusive judge — so we need an ok judge.
    const cases: IntakeEvalCase[] = [
      makeCase('a', 'feature', 'story', 'ra'),
      makeCase('b', 'bug', 'story', 'rb'),
      makeCase('c', 'chore', 'epic', 'rc'),
      makeCase('d', 'feature', 'epic', 'rd'),
      makeCase('e', 'bug', 'story', 're'),
      makeCase('f', 'feature', 'story', 'rf'),
    ];
    const refined: RefinedCaseResult[] = cases.map(c => okResult(c));

    // Classifier: all correct on type; c and d are epic but predicted 'story' (dangerous).
    const llm = new MockLLMClient([
      validVerdictJson('feature', 'story'), // a: type ✓ size ✓
      validVerdictJson('bug', 'story'),     // b: type ✓ size ✓
      validVerdictJson('chore', 'story'),   // c: type ✓ size ✗ (epic→story dangerous!)
      validVerdictJson('feature', 'story'), // d: type ✓ size ✗ (epic→story dangerous!)
      validVerdictJson('bug', 'story'),     // e: type ✓ size ✓
      validVerdictJson('feature', 'story'), // f: type ✓ size ✓
    ]);

    // Use a judge that returns ok so scoredCases reaches MIN_SCORED_CASES (5).
    const agreeingJudge: IntakeJudgeLike = {
      async judge(_brief, verdict): Promise<JudgeOutcome> {
        return { status: 'ok', result: { type: verdict.type, size: verdict.size, grade: 'agree', reason: '' } };
      },
    };

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: agreeingJudge,
    });

    const report = scoreIntakeEval(records, {
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
    });

    // per-axis accuracy (AC3)
    const typeAxis = report.axes.find(a => a.axis === 'type');
    const sizeAxis = report.axes.find(a => a.axis === 'size');
    assert.ok(typeAxis, 'report must have type axis');
    assert.ok(sizeAxis, 'report must have size axis');
    assert.equal(typeAxis.accuracy.scored, 6, 'all 6 cases scored on type');
    assert.equal(typeAxis.accuracy.correct, 6, 'all type predictions correct');
    assert.equal(sizeAxis.accuracy.scored, 6, 'all 6 cases scored on size');
    assert.ok(sizeAxis.accuracy.correct < 6, 'some size predictions wrong (c and d are epic)');

    // confusion matrix (AC3)
    assert.ok(sizeAxis.confusion.counts['epic']['story'] > 0, 'epic→story under-sizing appears in matrix');

    // epic→story under-sizing count (AC3)
    assert.ok(sizeAxis.dangerousConfusions.length > 0, 'dangerousConfusions is non-empty');
    const underSizing = sizeAxis.dangerousConfusions.find(d => d.from === 'epic' && d.to === 'story');
    assert.ok(underSizing, 'epic→story dangerous confusion present');
    assert.equal(underSizing!.count, 2, 'two epic→story under-sizing cases (c and d)');

    // fail-closed gate (AC3): epic→story under-sizing triggers do-not-proceed
    assert.equal(report.gate.decision, 'do-not-proceed', 'gate must block on epic→story confusion');

    // generatedFromCases = N
    assert.equal(report.generatedFromCases, 6, 'report reflects all N cases');
  });

  it('fail-closed: refiner-failure record excluded from accuracy but counted (AC3)', async () => {
    // 5 ok cases + 1 failure → 5 scored, 1 excluded, N=6
    const okCases: IntakeEvalCase[] = [
      makeCase('a', 'feature', 'story', 'ra'),
      makeCase('b', 'bug', 'story', 'rb'),
      makeCase('c', 'chore', 'story', 'rc'),
      makeCase('d', 'feature', 'story', 'rd'),
      makeCase('e', 'feature', 'story', 're'),
    ];
    const refined: RefinedCaseResult[] = [
      ...okCases.map(c => okResult(c)),
      failResult('f', 'no_refined_brief'),
    ];

    const llm = new MockLLMClient(
      okCases.map(c => validVerdictJson(c.label.type, c.label.size)),
    );

    const records = await runRefinedIntakeEval(refined, {
      llm,
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 6, 'N=6 including failure record');

    const report = scoreIntakeEval(records, {
      classifierModel: CLASSIFIER_MODEL,
      judgeModel: JUDGE_MODEL,
    });

    // Failure is excluded from scored
    const typeAxis = report.axes.find(a => a.axis === 'type')!;
    assert.equal(typeAxis.accuracy.scored, 5, 'failure excluded from scored count');

    // Failure is counted in failureCounts
    assert.ok(
      report.failureCounts.classifier.llm_error > 0,
      'failure record counted in classifier failure tally',
    );

    // generatedFromCases still N=6
    assert.equal(report.generatedFromCases, 6, 'total count includes failure case');
  });
});
