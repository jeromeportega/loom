import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../../llm/LLMClient.js';
import { runIntakeEval, computeAxisAccuracy } from '../runIntakeEval.js';
import type {
  IntakeEvalCase,
  IntakeRunRecord,
  IntakeJudgeLike,
  IntakeVerdict,
  JudgeOutcome,
} from '../intakeEvalTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** LLM client that throws on complete() — used to test runIntakeEval's try/catch guard. */
class ThrowingLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  constructor(private readonly message: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    throw new Error(this.message);
  }
}

const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_MODEL = 'claude-opus-4-8';

function makeCase(id: string, type: 'feature' | 'bug' | 'chore', size: 'story' | 'epic'): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief: `Test brief for case ${id}.`,
    label: { type, size },
    rationale: `Test rationale for case ${id}.`,
  };
}

function validVerdictJson(type: 'feature' | 'bug' | 'chore', size: 'story' | 'epic'): string {
  const verdict: IntakeVerdict = { type, size, confidence: 'high', rationale: 'Test classifier output.' };
  return JSON.stringify(verdict);
}

/** Inconclusive stub for tests where judge result does not matter. */
const inconclusiveJudge: IntakeJudgeLike = {
  async judge(): Promise<JudgeOutcome> {
    return { status: 'inconclusive', detail: 'stub — judge not under test' };
  },
};

function makeRecord(
  c: IntakeEvalCase,
  predicted: { type: 'feature' | 'bug' | 'chore'; size: 'story' | 'epic' } | null,
): IntakeRunRecord {
  return {
    case: c,
    classifier: predicted
      ? { ok: true, verdict: { ...predicted, confidence: 'high', rationale: 'test' } }
      : { ok: false, reason: 'llm_error', detail: 'test failure' },
    judge: { status: 'inconclusive', detail: 'stub' },
  };
}

// ── runIntakeEval — integration (fake LLM, no network) ────────────────────────

describe('runIntakeEval — exactly one classifier call per case (NFR-1, FR-4)', () => {
  it('issues exactly one classifier call for a single case', async () => {
    const cases = [makeCase('a', 'feature', 'story')];
    const llm = new MockLLMClient([validVerdictJson('feature', 'story')]);

    await runIntakeEval(cases, { llm, classifierModel: TRIAGE_MODEL, judgeModel: JUDGE_MODEL, judge: inconclusiveJudge });

    assert.equal(llm.requests.length, 1, 'exactly one LLM call for one case');
  });

  it('issues exactly N classifier calls for N cases', async () => {
    const cases = [
      makeCase('a', 'feature', 'story'),
      makeCase('b', 'bug', 'story'),
      makeCase('c', 'chore', 'epic'),
    ];
    const llm = new MockLLMClient([
      validVerdictJson('feature', 'story'),
      validVerdictJson('bug', 'story'),
      validVerdictJson('chore', 'epic'),
    ]);

    await runIntakeEval(cases, { llm, classifierModel: TRIAGE_MODEL, judgeModel: JUDGE_MODEL, judge: inconclusiveJudge });

    assert.equal(llm.requests.length, cases.length, `classifier call count must equal case count`);
  });
});

describe('runIntakeEval — classifier model (FR-4 model check)', () => {
  it('invokes classifyIntake with classifierModel = triage_model', async () => {
    const cases = [makeCase('a', 'feature', 'story')];
    const llm = new MockLLMClient([validVerdictJson('feature', 'story')]);
    const customModel = 'claude-haiku-4-5-20251001';

    await runIntakeEval(cases, { llm, classifierModel: customModel, judgeModel: JUDGE_MODEL, judge: inconclusiveJudge });

    assert.equal(
      llm.requests[0]?.model,
      customModel,
      'classifier must use the model specified in deps.classifierModel',
    );
  });
});

describe('runIntakeEval — classifier failure handling', () => {
  it('records classifier failure as {ok:false} on the run record', async () => {
    const cases = [makeCase('a', 'feature', 'story')];
    // Returning non-JSON triggers invalid_output from classifyIntake
    const llm = new MockLLMClient(['not valid json at all']);

    const records = await runIntakeEval(cases, {
      llm,
      classifierModel: TRIAGE_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].classifier.ok, false, 'classifier result must be {ok:false}');
    if (!records[0].classifier.ok) {
      assert.ok(
        records[0].classifier.reason === 'invalid_output' ||
          records[0].classifier.reason === 'llm_error' ||
          records[0].classifier.reason === 'timeout',
        `reason must be one of the allowed values, got: ${records[0].classifier.reason}`,
      );
    }
  });

  it('records judge as inconclusive when classifier fails — no judge call', async () => {
    const cases = [makeCase('a', 'feature', 'story')];
    const llm = new MockLLMClient(['not valid json']);

    let judgeCallCount = 0;
    const spyJudge: IntakeJudgeLike = {
      async judge(): Promise<JudgeOutcome> {
        judgeCallCount++;
        return { status: 'ok', result: { type: 'feature', size: 'story', grade: 'agree', reason: '' } };
      },
    };

    const records = await runIntakeEval(cases, {
      llm,
      classifierModel: TRIAGE_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: spyJudge,
    });

    assert.equal(records[0].judge.status, 'inconclusive', 'judge must be inconclusive on classifier failure');
    assert.equal(judgeCallCount, 0, 'judge must NOT be called when classifier fails');
    if (records[0].judge.status === 'inconclusive') {
      assert.ok(
        records[0].judge.detail.includes('classifier_failure'),
        `detail should indicate classifier_failure, got: ${records[0].judge.detail}`,
      );
    }
  });

  it('records remain accurate across mixed success/failure cases', async () => {
    const cases = [makeCase('a', 'feature', 'story'), makeCase('b', 'bug', 'epic')];
    const llm = new MockLLMClient([
      'not valid json',                     // case a → attempt 1, classifier failure
      'not valid json',                     // case a → retry (MAX_CLASSIFY_RETRIES=1), still failure
      validVerdictJson('bug', 'epic'),      // case b → success
    ]);

    let judgeCallCount = 0;
    const spyJudge: IntakeJudgeLike = {
      async judge(): Promise<JudgeOutcome> {
        judgeCallCount++;
        return { status: 'inconclusive', detail: 'stub' };
      },
    };

    const records = await runIntakeEval(cases, {
      llm,
      classifierModel: TRIAGE_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: spyJudge,
    });

    assert.equal(records.length, 2);
    assert.equal(records[0].classifier.ok, false, 'first case should fail after exhausting retries');
    assert.equal(records[1].classifier.ok, true, 'second case should succeed');
    // case a used 2 LLM calls (1 initial + 1 retry), case b used 1 — 3 total
    assert.equal(llm.requests.length, 3, 'failed case uses up to 1+MAX_CLASSIFY_RETRIES calls');
    assert.equal(judgeCallCount, 1, 'judge called only for the successful case');
  });
});

describe('runIntakeEval — LLM client throws (defensive try/catch guard)', () => {
  it('converts a thrown exception to {ok:false} and continues for remaining cases', async () => {
    const cases = [makeCase('a', 'feature', 'story'), makeCase('b', 'bug', 'epic')];
    const llm = new ThrowingLLMClient('simulated network error');

    const records = await runIntakeEval(cases, {
      llm,
      classifierModel: TRIAGE_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records.length, 2, 'all cases must have a record even when LLM throws');
    assert.equal(records[0].classifier.ok, false, 'thrown exception → {ok:false}');
    assert.equal(records[1].classifier.ok, false, 'thrown exception → {ok:false}');
    if (!records[0].classifier.ok) {
      assert.equal(records[0].classifier.reason, 'llm_error');
      assert.ok(
        records[0].classifier.detail.includes('simulated network error'),
        `detail should carry the thrown error message, got: ${records[0].classifier.detail}`,
      );
    }
    assert.equal(llm.requests.length, 2, 'one LLM call per case even when each throws');
  });
});

describe('runIntakeEval — returns IntakeRunRecord with full case context', () => {
  it('each record contains the original case object', async () => {
    const cases = [makeCase('anchor-test', 'bug', 'story')];
    const llm = new MockLLMClient([validVerdictJson('bug', 'story')]);

    const records = await runIntakeEval(cases, {
      llm,
      classifierModel: TRIAGE_MODEL,
      judgeModel: JUDGE_MODEL,
      judge: inconclusiveJudge,
    });

    assert.equal(records[0].case.id, 'anchor-test');
    assert.equal(records[0].case.label.type, 'bug');
    assert.equal(records[0].case.label.size, 'story');
  });
});

// ── computeAxisAccuracy — unit ────────────────────────────────────────────────

describe('computeAxisAccuracy — type axis', () => {
  it('all-correct: 3/3', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }),
      makeRecord(makeCase('c', 'chore', 'epic'), { type: 'chore', size: 'epic' }),
    ];
    const result = computeAxisAccuracy(records, 'type');
    assert.deepEqual(result, { correct: 3, scored: 3 });
  });

  it('all-wrong: 0/3', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'bug', size: 'story' }),    // wrong type
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'chore', size: 'story' }),     // wrong type
      makeRecord(makeCase('c', 'chore', 'epic'), { type: 'feature', size: 'epic' }),   // wrong type
    ];
    const result = computeAxisAccuracy(records, 'type');
    assert.deepEqual(result, { correct: 0, scored: 3 });
  });

  it('mixed: 2/3 correct', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }), // correct
      makeRecord(makeCase('b', 'bug', 'story'), { type: 'bug', size: 'story' }),         // correct
      makeRecord(makeCase('c', 'chore', 'epic'), { type: 'feature', size: 'epic' }),    // wrong type
    ];
    const result = computeAxisAccuracy(records, 'type');
    assert.deepEqual(result, { correct: 2, scored: 3 });
  });

  it('classifier failure excluded from scored count', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }), // correct
      makeRecord(makeCase('b', 'bug', 'story'), null),                                   // classifier failure
      makeRecord(makeCase('c', 'chore', 'epic'), { type: 'chore', size: 'epic' }),       // correct
    ];
    const result = computeAxisAccuracy(records, 'type');
    assert.deepEqual(result, { correct: 2, scored: 2 }, 'failure excluded from scored count');
  });

  it('all failures → 0/0', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), null),
      makeRecord(makeCase('b', 'bug', 'story'), null),
    ];
    const result = computeAxisAccuracy(records, 'type');
    assert.deepEqual(result, { correct: 0, scored: 0 });
  });

  it('empty records → 0/0', () => {
    const result = computeAxisAccuracy([], 'type');
    assert.deepEqual(result, { correct: 0, scored: 0 });
  });
});

describe('computeAxisAccuracy — size axis', () => {
  it('all-correct: 2/2', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }),
      makeRecord(makeCase('b', 'bug', 'epic'), { type: 'bug', size: 'epic' }),
    ];
    const result = computeAxisAccuracy(records, 'size');
    assert.deepEqual(result, { correct: 2, scored: 2 });
  });

  it('all-wrong: 0/2', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'epic' }), // size wrong
      makeRecord(makeCase('b', 'bug', 'epic'), { type: 'bug', size: 'story' }),         // size wrong
    ];
    const result = computeAxisAccuracy(records, 'size');
    assert.deepEqual(result, { correct: 0, scored: 2 });
  });

  it('type axis accuracy is independent of size axis accuracy', () => {
    // case a: type correct, size wrong
    // case b: type wrong, size correct
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'epic' }), // type ✓ size ✗
      makeRecord(makeCase('b', 'bug', 'epic'), { type: 'chore', size: 'epic' }),        // type ✗ size ✓
    ];
    const typeResult = computeAxisAccuracy(records, 'type');
    const sizeResult = computeAxisAccuracy(records, 'size');
    assert.deepEqual(typeResult, { correct: 1, scored: 2 }, 'type: only first case correct');
    assert.deepEqual(sizeResult, { correct: 1, scored: 2 }, 'size: only second case correct');
  });

  it('classifier failure excluded from size scored count', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), { type: 'feature', size: 'story' }), // correct
      makeRecord(makeCase('b', 'bug', 'epic'), null),                                    // failure
    ];
    const result = computeAxisAccuracy(records, 'size');
    assert.deepEqual(result, { correct: 1, scored: 1 }, 'failure excluded from size scored count');
  });
});
