import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { judgeLessonExtraction } from '../judge.js';
import type { LessonExtractorCase } from '../caseSchema.js';
import type { Lesson } from '../../../findings/lesson.js';
import { DEFAULT_JUDGE_MODEL } from '../../framework/models.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

const HAPPY_JUDGMENT = {
  total_lessons:        3,
  faithfulness:         0.8,
  usefulness:           0.75,
  coverage:             'partial',
  hallucinated_lessons: 0,
  over_extraction:      false,
  reason:               'Good extraction but missing one expected theme.',
};

function makeCase(overrides: Partial<LessonExtractorCase> = {}): LessonExtractorCase {
  return {
    id:     'le-test-001',
    source: 'rich',
    telemetry: {
      epic_id:         'epic-test-001',
      final_status:    'done',
      decision_traces: [],
      agents:          [],
      audit_tail:      [],
    },
    rubric: {
      expected_themes:       ['error-handling', 'test-coverage'],
      over_extraction_traps: ['micro-optimizations'],
    },
    rationale: 'A test case for judge unit tests.',
    ...overrides,
  };
}

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    epic_id:     'epic-test-001',
    category:    'testing',
    observation: 'Tests were added for all critical paths.',
    general_rule: 'Always write tests before considering a story complete.',
    applied_as:  null,
    applied_ref: null,
    created_at:  '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeOutput(count = 3): Lesson[] {
  return Array.from({ length: count }, (_, i) =>
    makeLesson({ category: `cat-${i}`, observation: `Observation ${i}.`, general_rule: `Rule ${i}.` }),
  );
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('judgeLessonExtraction — happy path', () => {
  it('returns { status: ok, judgment } with valid fields on well-formed mock response', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    const j = result.judgment;
    assert.ok(j.faithfulness >= 0 && j.faithfulness <= 1, 'faithfulness must be ∈ [0,1]');
    assert.ok(j.usefulness >= 0 && j.usefulness <= 1, 'usefulness must be ∈ [0,1]');
    assert.ok(['full', 'partial', 'missing'].includes(j.coverage), 'coverage must be enum');
    assert.ok(Number.isInteger(j.hallucinated_lessons), 'hallucinated_lessons must be an integer');
    assert.ok(Number.isInteger(j.total_lessons), 'total_lessons must be an integer');
    assert.ok(j.hallucinated_lessons <= j.total_lessons, 'hallucinated_lessons must not exceed total_lessons');
    assert.equal(typeof j.over_extraction, 'boolean', 'over_extraction must be boolean');
    assert.ok(j.reason.length > 0, 'reason must be non-empty');
  });

  it('surfaces all judgment fields exactly from the mock response', async () => {
    const judgment = { ...HAPPY_JUDGMENT, coverage: 'full', faithfulness: 0.9, usefulness: 0.85 };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.faithfulness, 0.9);
    assert.equal(result.judgment.usefulness, 0.85);
    assert.equal(result.judgment.coverage, 'full');
    assert.equal(result.judgment.reason, judgment.reason);
  });
});

// ── Rubric is actually used ───────────────────────────────────────────────────

describe('judgeLessonExtraction — rubric is used in the prompt', () => {
  it('includes expected_themes in the prompt sent to the LLM', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    const c = makeCase({
      rubric: {
        expected_themes:       ['theme-alpha', 'theme-beta'],
        over_extraction_traps: ['trap-one'],
      },
    });
    await judgeLessonExtraction(c, makeOutput(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('theme-alpha'), 'prompt must contain expected_themes[0]');
    assert.ok(userMsg.includes('theme-beta'), 'prompt must contain expected_themes[1]');
  });

  it('includes over_extraction_traps in the prompt sent to the LLM', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    const c = makeCase({
      rubric: {
        expected_themes:       ['theme-1'],
        over_extraction_traps: ['trap-unique-xyz-987'],
      },
    });
    await judgeLessonExtraction(c, makeOutput(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('trap-unique-xyz-987'), 'prompt must contain over_extraction_traps');
  });

  it('includes extracted lessons in the prompt sent to the LLM', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    const lessons = [makeLesson({ general_rule: 'unique-rule-string-abc123' })];
    await judgeLessonExtraction(makeCase(), lessons, { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('unique-rule-string-abc123'), 'prompt must contain extracted lessons');
  });

  it('includes telemetry from c.telemetry in the prompt (required for faithfulness scoring)', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    const c = makeCase({
      telemetry: {
        epic_id:         'epic-test-001',
        final_status:    'done',
        decision_traces: [{
          id:        1,
          agent_id:  null,
          epic_id:   null,
          story_id:  null,
          kind:      'decision',
          subject:   null,
          rationale: 'unique-trace-rationale-faithfulness-xyz',
          metadata:  null,
          timestamp: '2026-01-01T00:00:00.000Z',
        }],
        agents:     [],
        audit_tail: [],
      },
    });
    await judgeLessonExtraction(c, makeOutput(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('unique-trace-rationale-faithfulness-xyz'), 'prompt must contain telemetry decision_traces for faithfulness scoring');
  });
});

// ── Both flags exercised ──────────────────────────────────────────────────────

describe('judgeLessonExtraction — hallucination and over-extraction flags', () => {
  it('hallucinated_lessons > 0 is parsed and returned', async () => {
    const judgment = { ...HAPPY_JUDGMENT, total_lessons: 5, hallucinated_lessons: 2 };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(5), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.hallucinated_lessons, 2);
    assert.equal(result.judgment.total_lessons, 5);
  });

  it('over_extraction: true is parsed and returned', async () => {
    const judgment = { ...HAPPY_JUDGMENT, over_extraction: true };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.over_extraction, true);
  });

  it('over_extraction: false is parsed and returned', async () => {
    const judgment = { ...HAPPY_JUDGMENT, over_extraction: false };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.over_extraction, false);
  });
});

// ── Invariant: hallucinated_lessons ≤ total_lessons ──────────────────────────

describe('judgeLessonExtraction — hallucinated_lessons ≤ total_lessons invariant', () => {
  it('returns inconclusive when hallucinated_lessons > total_lessons (schema rejects)', async () => {
    const judgment = { ...HAPPY_JUDGMENT, total_lessons: 3, hallucinated_lessons: 5 };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(3), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'invariant violation must not produce a fabricated ok');
  });

  it('accepts when hallucinated_lessons === total_lessons', async () => {
    const judgment = { ...HAPPY_JUDGMENT, total_lessons: 3, hallucinated_lessons: 3 };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(3), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
  });

  it('accepts when hallucinated_lessons === 0 and total_lessons > 0', async () => {
    const judgment = { ...HAPPY_JUDGMENT, total_lessons: 2, hallucinated_lessons: 0 };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(2), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
  });
});

// ── Fail-closed ───────────────────────────────────────────────────────────────

describe('judgeLessonExtraction — fail-closed: inconclusive on bad/absent output', () => {
  it('returns inconclusive on malformed judge JSON', async () => {
    const llm = new MockLLMClient(['not valid json at all']);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'parse failure must not produce a fabricated verdict');
  });

  it('returns inconclusive on out-of-enum coverage value', async () => {
    const judgment = { ...HAPPY_JUDGMENT, coverage: 'excellent' };
    const llm = new MockLLMClient([wrapJson(judgment)]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on missing required fields', async () => {
    const llm = new MockLLMClient([wrapJson({ faithfulness: 0.8, reason: 'ok' })]);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on LLM throw', async () => {
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('LLM outage'); },
    };
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm: throwingLLM, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
    if (result.status !== 'inconclusive') return;
    assert.ok(result.detail.includes('LLM outage'));
  });

  it('returns inconclusive on empty string response', async () => {
    const llm = new MockLLMClient(['']);
    const result = await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});

// ── Wired through framework's LLM-as-judge step ──────────────────────────────

describe('judgeLessonExtraction — wired through framework JudgeDeps seam', () => {
  it('calls deps.llm.complete() with deps.judgeModel (uses the framework seam, not a bespoke client)', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'my-judge-model' });
    assert.equal(llm.requests.length, 1, 'exactly one LLM request must be made');
    assert.equal(llm.requests[0].model, 'my-judge-model', 'must pass judgeModel to deps.llm');
  });

  it('sends exactly one LLM request per invocation', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(llm.requests.length, 1);
  });

  it('system prompt is cached (cache: true on system block)', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_JUDGMENT)]);
    await judgeLessonExtraction(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.ok(llm.allCacheableBlocksMarked(), 'system prompt block must have cache: true');
  });
});

// ── Model defaults ────────────────────────────────────────────────────────────

describe('model defaults', () => {
  it('DEFAULT_JUDGE_MODEL is claude-opus-4-8', () => {
    assert.equal(DEFAULT_JUDGE_MODEL, 'claude-opus-4-8');
  });

  it('DEFAULT_JUDGE_MODEL differs from gate haiku default (mitigates circularity)', () => {
    const GATE_DEFAULT = 'claude-haiku-4-5-20251001';
    assert.notEqual(DEFAULT_JUDGE_MODEL, GATE_DEFAULT, 'judge and gate defaults must be distinct');
  });
});

// ── Persona guard ─────────────────────────────────────────────────────────────

describe('persona guard — lesson-extractor-judge.md exists and is distinct', () => {
  function findPersonaDir(): string {
    const candidates = [
      path.resolve(__dirname, '../../../../personas'),
      path.resolve(process.cwd(), 'personas'),
      path.resolve(process.cwd(), 'packages/loom-core/personas'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    throw new Error(`personas/ dir not found. Tried: ${candidates.join(', ')}`);
  }

  it('lesson-extractor-judge.md exists', () => {
    const dir = findPersonaDir();
    const file = path.join(dir, 'lesson-extractor-judge.md');
    assert.ok(fs.existsSync(file), `Missing: ${file}`);
  });

  it('lesson-extractor-judge.md is non-empty', () => {
    const dir = findPersonaDir();
    const content = fs.readFileSync(path.join(dir, 'lesson-extractor-judge.md'), 'utf8');
    assert.ok(content.length > 0, 'persona file must not be empty');
  });

  it('lesson-extractor-judge.md does not contain {{CONTEXT}} production template variable', () => {
    const dir = findPersonaDir();
    const content = fs.readFileSync(path.join(dir, 'lesson-extractor-judge.md'), 'utf8');
    assert.ok(!content.includes('{{CONTEXT}}'), 'judge persona must not reuse the production template');
  });
});
