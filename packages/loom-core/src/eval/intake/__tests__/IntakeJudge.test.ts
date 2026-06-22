import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from '../../../llm/LLMClient.js';
import { EMPTY_USAGE } from '../../../llm/LLMClient.js';
import { IntakeJudge, computeJudgeVsHumanAgreement } from '../IntakeJudge.js';
import type {
  IntakeVerdict,
  JudgeOutcome,
  IntakeRunRecord,
  IntakeEvalCase,
} from '../intakeEvalTypes.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PLANNING_MODEL = 'claude-opus-4-8';
const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

const SAMPLE_BRIEF = 'Add a new endpoint to allow users to export their data as CSV.';
const SAMPLE_VERDICT: IntakeVerdict = {
  type: 'feature',
  size: 'story',
  confidence: 'high',
  rationale: 'Small, well-defined feature with clear scope.',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function validJudgeJson(
  type: 'feature' | 'bug' | 'chore',
  size: 'story' | 'epic',
  grade: 'agree' | 'disagree',
  reason = 'Test reason.',
): string {
  return wrapJson({ type, size, grade, reason });
}

class ThrowingLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  constructor(private readonly message: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    throw new Error(this.message);
  }
}

function makeCase(
  id: string,
  type: 'feature' | 'bug' | 'chore',
  size: 'story' | 'epic',
): IntakeEvalCase {
  return {
    id,
    source: 'anchor',
    brief: `Brief ${id}.`,
    label: { type, size },
    rationale: `Rationale ${id}.`,
  };
}

function makeRecord(c: IntakeEvalCase, judgeOutcome: JudgeOutcome): IntakeRunRecord {
  return {
    case: c,
    classifier: {
      ok: true,
      verdict: { type: c.label.type, size: c.label.size, confidence: 'high', rationale: 'test' },
    },
    judge: judgeOutcome,
  };
}

const okOutcome = (
  type: 'feature' | 'bug' | 'chore',
  size: 'story' | 'epic',
): JudgeOutcome => ({
  status: 'ok',
  result: { type, size, grade: 'agree', reason: '' },
});

const inconclusive = (): JudgeOutcome => ({
  status: 'inconclusive',
  detail: 'test inconclusive',
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('IntakeJudge — happy path', () => {
  it('returns {status:ok, result} with schema-valid IntakeJudgeResult', async () => {
    const llm = new MockLLMClient([
      validJudgeJson('feature', 'story', 'agree', 'Correct classification.'),
    ]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') {
      assert.equal(outcome.result.type, 'feature');
      assert.equal(outcome.result.size, 'story');
      assert.equal(outcome.result.grade, 'agree');
      assert.equal(outcome.result.reason, 'Correct classification.');
    }
  });

  it('accepts disagree grade with reason', async () => {
    const llm = new MockLLMClient([
      validJudgeJson('bug', 'epic', 'disagree', 'Type is actually a bug fix.'),
    ]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'ok');
    if (outcome.status === 'ok') {
      assert.equal(outcome.result.grade, 'disagree');
      assert.equal(outcome.result.type, 'bug');
      assert.equal(outcome.result.size, 'epic');
    }
  });
});

// ── Exactly one call per invocation (NFR-1, FR-6) ────────────────────────────

describe('IntakeJudge — exactly one LLM call per judge() invocation (NFR-1, FR-6)', () => {
  it('makes exactly one LLM call per judge() call', async () => {
    const llm = new MockLLMClient([
      validJudgeJson('feature', 'story', 'agree'),
      validJudgeJson('bug', 'epic', 'disagree'),
    ]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);
    assert.equal(llm.requests.length, 1, 'first call: exactly one request');

    await judge.judge('Another brief.', { ...SAMPLE_VERDICT, type: 'bug', size: 'epic' });
    assert.equal(llm.requests.length, 2, 'second call: exactly two requests total');
  });
});

// ── Planning tier model (NFR-2, ADR-002) ─────────────────────────────────────

describe('IntakeJudge — planning-tier model (NFR-2, ADR-002)', () => {
  it('passes the planning-tier model to the LLM client', async () => {
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(
      llm.requests[0]?.model,
      PLANNING_MODEL,
      'must use the planning-tier model passed in opts',
    );
    assert.notEqual(
      llm.requests[0]?.model,
      TRIAGE_MODEL,
      'must NOT use the triage model',
    );
  });

  it('uses whatever model is provided — wiring to planning tier is callers responsibility', async () => {
    const customPlanningModel = 'claude-opus-4-7';
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: customPlanningModel });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(llm.requests[0]?.model, customPlanningModel);
  });
});

// ── Inconclusive on outage (FR-9) ────────────────────────────────────────────

describe('IntakeJudge — inconclusive on outage (FR-9)', () => {
  it('returns {status:inconclusive} when client throws', async () => {
    const llm = new ThrowingLLMClient('simulated API outage');
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
    if (outcome.status === 'inconclusive') {
      assert.ok(
        outcome.detail.includes('simulated API outage'),
        `detail must carry the thrown error, got: ${outcome.detail}`,
      );
    }
  });

  it('never returns a synthesized agree result on outage (not SkillJudge permissive-accept)', async () => {
    const llm = new ThrowingLLMClient('timeout');
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
    // Must not carry score:999 or grade:agree — the SkillJudge permissive-accept sentinels
    assert.ok(!('score' in outcome), 'must not carry score field (SkillJudge sentinel)');
    if (outcome.status === 'inconclusive') {
      assert.ok(!('grade' in outcome), 'inconclusive must not have a grade field');
    }
  });
});

// ── Inconclusive on parse/validation failure ──────────────────────────────────

describe('IntakeJudge — inconclusive on parse/validation failure', () => {
  it('returns {status:inconclusive} on malformed JSON', async () => {
    const llm = new MockLLMClient(['not json at all']);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
  });

  it('returns {status:inconclusive} on non-conforming JSON (missing required fields)', async () => {
    const llm = new MockLLMClient([wrapJson({ type: 'feature' })]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
  });

  it('returns {status:inconclusive} on invalid enum value in type field', async () => {
    const llm = new MockLLMClient([
      wrapJson({ type: 'unknown-type', size: 'story', grade: 'agree', reason: '' }),
    ]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
  });

  it('returns {status:inconclusive} on invalid enum value in grade field', async () => {
    const llm = new MockLLMClient([
      wrapJson({ type: 'feature', size: 'story', grade: 'accept', reason: '' }),
    ]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
  });

  it('never returns a coerced verdict on validation failure', async () => {
    const llm = new MockLLMClient([wrapJson({ score: 999, verdict: 'accept' })]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    const outcome = await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(outcome.status, 'inconclusive');
  });
});

// ── Bundled prompt loaded (not an inline string) ──────────────────────────────

describe('IntakeJudge — bundled prompt (intake-judge.md) loaded via loadBundledPrompt', () => {
  it('system prompt is non-trivial content loaded from intake-judge.md', async () => {
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    const promptText = llm.requests[0]?.system[0]?.text ?? '';
    assert.ok(promptText.length > 100, 'system prompt must be loaded from file, not an empty or trivial string');
    assert.ok(
      promptText.includes('judge') || promptText.includes('classify') || promptText.includes('classifier'),
      `system prompt must contain rubric content from intake-judge.md, got first 200 chars: ${promptText.slice(0, 200)}`,
    );
  });

  it('system prompt is marked cache:true (prompt caching invariant)', async () => {
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(
      llm.requests[0]?.system[0]?.cache,
      true,
      'static rubric must be marked cache:true',
    );
  });
});

// ── Non-agentic mode request shape (AC1, AC2, FR-1, FR-3) ────────────────────

describe('IntakeJudge — non-agentic mode request shape (AC1, AC2)', () => {
  it('sets nonAgentic: { excludeDynamicSections: true } on the complete() call (FR-1)', async () => {
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.deepEqual(
      llm.requests[0]?.nonAgentic,
      { excludeDynamicSections: true },
      'complete() must carry nonAgentic: { excludeDynamicSections: true }',
    );
  });

  it('sets maxTokens to 512 on the complete() call (FR-3)', async () => {
    const llm = new MockLLMClient([validJudgeJson('feature', 'story', 'agree')]);
    const judge = new IntakeJudge({ llm, model: PLANNING_MODEL });

    await judge.judge(SAMPLE_BRIEF, SAMPLE_VERDICT);

    assert.equal(
      llm.requests[0]?.maxTokens,
      512,
      'complete() must carry maxTokens: 512',
    );
  });
});

// ── computeJudgeVsHumanAgreement — unit ──────────────────────────────────────

describe('computeJudgeVsHumanAgreement — type axis', () => {
  it('counts agrees and disagrees correctly for type axis', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')), // type agree
      makeRecord(makeCase('b', 'bug', 'story'), okOutcome('bug', 'story')),         // type agree
      makeRecord(makeCase('c', 'chore', 'epic'), okOutcome('feature', 'epic')),     // type disagree
    ];

    const result = computeJudgeVsHumanAgreement(records, 'type');
    assert.deepEqual(result, { agree: 2, disagree: 1, inconclusive: 0 });
  });

  it('excludes inconclusive from type agreement denominator (FR-9, ADR-001)', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')), // type agree
      makeRecord(makeCase('b', 'bug', 'story'), inconclusive()),                   // inconclusive
      makeRecord(makeCase('c', 'chore', 'epic'), okOutcome('chore', 'epic')),       // type agree
    ];

    const result = computeJudgeVsHumanAgreement(records, 'type');

    assert.deepEqual(result, { agree: 2, disagree: 0, inconclusive: 1 });
    assert.equal(
      result.agree + result.disagree,
      2,
      'denominator must exclude the inconclusive case',
    );
  });

  it('all inconclusive → agree:0 disagree:0 with correct inconclusive count', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), inconclusive()),
      makeRecord(makeCase('b', 'bug', 'epic'), inconclusive()),
    ];

    const result = computeJudgeVsHumanAgreement(records, 'type');
    assert.deepEqual(result, { agree: 0, disagree: 0, inconclusive: 2 });
  });

  it('all agree → 3/0', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')),
      makeRecord(makeCase('b', 'bug', 'epic'), okOutcome('bug', 'story')),   // size differs but type agrees
      makeRecord(makeCase('c', 'chore', 'story'), okOutcome('chore', 'epic')),
    ];

    const result = computeJudgeVsHumanAgreement(records, 'type');
    assert.deepEqual(result, { agree: 3, disagree: 0, inconclusive: 0 });
  });

  it('empty records → all zeros', () => {
    const result = computeJudgeVsHumanAgreement([], 'type');
    assert.deepEqual(result, { agree: 0, disagree: 0, inconclusive: 0 });
  });
});

describe('computeJudgeVsHumanAgreement — size axis', () => {
  it('counts agrees and disagrees correctly for size axis', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')), // size agree
      makeRecord(makeCase('b', 'bug', 'epic'), okOutcome('bug', 'story')),          // size disagree
    ];

    const result = computeJudgeVsHumanAgreement(records, 'size');
    assert.deepEqual(result, { agree: 1, disagree: 1, inconclusive: 0 });
  });

  it('excludes inconclusive from size agreement denominator', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')), // size agree
      makeRecord(makeCase('b', 'bug', 'epic'), inconclusive()),                     // inconclusive
    ];

    const result = computeJudgeVsHumanAgreement(records, 'size');

    assert.deepEqual(result, { agree: 1, disagree: 0, inconclusive: 1 });
    assert.equal(
      result.agree + result.disagree,
      1,
      'denominator must exclude the inconclusive case',
    );
  });

  it('type axis and size axis are independent', () => {
    // case a: type agree, size disagree  (judge says 'feature'/'epic', human says 'feature'/'story')
    // case b: type disagree, size agree  (judge says 'bug'/'epic', human says 'chore'/'epic')
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'epic')),
      makeRecord(makeCase('b', 'chore', 'epic'), okOutcome('bug', 'epic')),
    ];

    const typeResult = computeJudgeVsHumanAgreement(records, 'type');
    const sizeResult = computeJudgeVsHumanAgreement(records, 'size');

    assert.deepEqual(typeResult, { agree: 1, disagree: 1, inconclusive: 0 }, 'type: case a agrees, case b disagrees');
    assert.deepEqual(sizeResult, { agree: 1, disagree: 1, inconclusive: 0 }, 'size: case a disagrees, case b agrees');
  });

  it('mixed ok and inconclusive outcomes', () => {
    const records: IntakeRunRecord[] = [
      makeRecord(makeCase('a', 'feature', 'story'), okOutcome('feature', 'story')), // size agree
      makeRecord(makeCase('b', 'bug', 'epic'), inconclusive()),                     // inconclusive
      makeRecord(makeCase('c', 'chore', 'story'), okOutcome('chore', 'epic')),      // size disagree
    ];

    const result = computeJudgeVsHumanAgreement(records, 'size');
    assert.deepEqual(result, { agree: 1, disagree: 1, inconclusive: 1 });
  });
});
