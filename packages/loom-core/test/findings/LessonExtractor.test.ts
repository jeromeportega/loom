import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockLLMClient } from '../../src/llm/MockLLMClient.js';
import { LessonExtractor } from '../../src/findings/LessonExtractor.js';
import type { EpicTelemetry } from '../../src/findings/LessonExtractor.js';
import { Lesson, LessonContent } from '../../src/findings/lesson.js';

/** Walk up until skills/lesson-extractor/SKILL.md is found. */
function findSkillMdPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'skills', 'lesson-extractor', 'SKILL.md');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('could not locate skills/lesson-extractor/SKILL.md');
}

const SKILL_MD_PATH = findSkillMdPath();
const MODEL = 'claude-test';

function makeTelemetry(overrides: Partial<EpicTelemetry> = {}): EpicTelemetry {
  return {
    epic_id: 'epic-005',
    final_status: 'done',
    decision_traces: [
      {
        id: 1, agent_id: 'agent-1', epic_id: 'epic-005', story_id: 'story-1',
        kind: 'thinking', subject: 'schema', rationale: 'evolving lesson schema',
        metadata: null, timestamp: '2026-01-01T00:00:00.000Z',
      },
    ],
    agents: [{ story_id: 'story-1', review_summary: 'LGTM', log_tail: 'tests passed' }],
    audit_tail: [],
    ...overrides,
  };
}

function lessonOnlyContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: 'schema-migration',
    observation: 'Zod schemas need explicit defaults for nullable fields.',
    general_rule: 'When adding nullable columns, set .default(null) in the zod schema.',
    ...overrides,
  };
}

function validLessonResponse(lessons: unknown[] = [lessonOnlyContent()]): string {
  return '```json\n' + JSON.stringify({ lessons }) + '\n```';
}

describe('LessonExtractor — cached system prefix + user message', () => {
  it('calls llm.complete with SKILL.md as a cacheable system block and telemetry as the user message', async () => {
    const llm = new MockLLMClient([validLessonResponse()]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    await extractor.extract(makeTelemetry());

    assert.equal(llm.requests.length, 1, 'exactly one LLM call on the happy path');
    const req = llm.requests[0];

    // System block carries SKILL.md content marked cacheable.
    assert.equal(req.system.length, 1, 'one system block');
    const skillMd = fs.readFileSync(SKILL_MD_PATH, 'utf8');
    assert.ok(
      req.system[0].text.startsWith(skillMd.trim().slice(0, 100)),
      'system block text must start with the SKILL.md content',
    );
    assert.equal(req.system[0].cache, true, 'system block must be marked cache: true');

    // Telemetry is the user message, not in the system block.
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
    const parsed = JSON.parse(req.messages[0].content) as EpicTelemetry;
    assert.equal(parsed.epic_id, 'epic-005');
    assert.equal(parsed.final_status, 'done');
  });

  it('allCacheableBlocksMarked() is true after a happy-path call', async () => {
    const llm = new MockLLMClient([validLessonResponse()]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });
    await extractor.extract(makeTelemetry());
    assert.equal(llm.allCacheableBlocksMarked(), true);
  });
});

describe('LessonExtractor — one batched call on the happy path', () => {
  it('calls llm.complete exactly once when the model returns well-formed output', async () => {
    const llm = new MockLLMClient([validLessonResponse()]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    const lessons = await extractor.extract(makeTelemetry());

    assert.equal(llm.requests.length, 1, 'exactly one LLM call on the happy path');
    assert.equal(lessons.length, 1);
  });
});

describe('LessonExtractor — pre-parse field stamping (FR-2 regression)', () => {
  it('stamps epic_id, created_at, applied_as, applied_ref before Lesson.parse succeeds (field-less model response)', async () => {
    // The model returns ONLY LessonContent fields — no epic_id, no created_at, etc.
    // The old reviewer bug: validating BEFORE stamping caused a ZodError on required fields.
    const fieldLessLesson = lessonOnlyContent();
    const llm = new MockLLMClient([validLessonResponse([fieldLessLesson])]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });
    const telemetry = makeTelemetry();

    const lessons = await extractor.extract(telemetry);

    assert.equal(lessons.length, 1, 'must return one lesson even though model omitted stamped fields');
    const lesson = lessons[0];
    assert.equal(lesson.epic_id, 'epic-005', 'epic_id must be stamped from telemetry');
    assert.ok(lesson.created_at && lesson.created_at.length > 0, 'created_at must be set');
    assert.equal(lesson.applied_as, null, 'applied_as must default to null');
    assert.equal(lesson.applied_ref, null, 'applied_ref must default to null');
    // LessonContent fields passed through intact
    assert.equal(lesson.category, 'schema-migration');
    assert.equal(lesson.general_rule, 'When adding nullable columns, set .default(null) in the zod schema.');
  });

  it('a raw LessonContent object (no stamped fields) is rejected by Lesson.parse directly', () => {
    // This confirms that Lesson.parse alone cannot validate a field-less model response.
    // It MUST go through the handler's stamp-then-parse path.
    const rawFromModel = lessonOnlyContent();
    const result = Lesson.safeParse(rawFromModel);
    assert.equal(
      result.success,
      false,
      'Lesson.parse must reject a field-less model response (proving stamp-before-parse is load-bearing)',
    );
  });
});

describe('LessonExtractor — schema evolution', () => {
  it('Lesson.parse accepts the FR-6 shape', () => {
    const fr6 = {
      category: 'test-coverage',
      observation: 'Scoping tests to one package kept CI fast.',
      general_rule: 'Run the narrowest test selector while iterating.',
      epic_id: 'epic-005',
      created_at: new Date().toISOString(),
      applied_as: null,
      applied_ref: null,
    };
    assert.equal(Lesson.safeParse(fr6).success, true);
  });

  it('Lesson.parse rejects the old kind/summary/context shape', () => {
    const oldShape = {
      kind: 'worked-well',
      summary: 'Tests passed.',
      context: 'Ran the suite.',
    };
    assert.equal(
      Lesson.safeParse(oldShape).success,
      false,
      'old kind/summary/context shape must not parse as a Lesson',
    );
  });

  it('LessonContent does not have a kind field', () => {
    assert.equal(
      'kind' in LessonContent.shape,
      false,
      'no remaining kind field in LessonContent — old enum is fully removed',
    );
  });

  it('Lesson does not have a kind field', () => {
    assert.equal(
      'kind' in Lesson.shape,
      false,
      'no remaining kind field in Lesson — old enum is fully removed',
    );
  });
});

describe('LessonExtractor — malformed output → exactly one repair', () => {
  it('retries once on non-JSON first response, returns lessons on valid second response', async () => {
    const llm = new MockLLMClient([
      'This is not JSON at all.',
      validLessonResponse(),
    ]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    const lessons = await extractor.extract(makeTelemetry());

    assert.equal(llm.requests.length, 2, 'exactly two LLM calls: one original + one repair');
    assert.equal(lessons.length, 1, 'lessons returned from the valid second response');
  });

  it('retries once on schema-invalid JSON first response, returns lessons on valid second response', async () => {
    const invalidJson = '```json\n{"lessons": [{"bad_field": "oops"}]}\n```';
    const llm = new MockLLMClient([invalidJson, validLessonResponse()]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    const lessons = await extractor.extract(makeTelemetry());

    assert.equal(llm.requests.length, 2, 'exactly two calls on schema-invalid first response');
    assert.equal(lessons.length, 1);
  });

  it('throws after exactly two malformed responses (no infinite retry)', async () => {
    const llm = new MockLLMClient([
      'not json',
      'also not json',
    ]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    await assert.rejects(
      () => extractor.extract(makeTelemetry()),
      /malformed output/i,
    );
    assert.equal(llm.requests.length, 2, 'exactly two calls before giving up');
  });

  it('does not make a third call when both attempts fail', async () => {
    const llm = new MockLLMClient(['bad', 'bad']);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    try { await extractor.extract(makeTelemetry()); } catch { /* expected */ }

    assert.equal(llm.requests.length, 2, 'no more than two calls regardless of failure count');
  });
});

describe('LessonExtractor — empty lessons array', () => {
  it('returns [] without throwing when model returns {lessons: []}', async () => {
    const llm = new MockLLMClient(['```json\n{"lessons":[]}\n```']);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });

    const lessons = await extractor.extract(makeTelemetry());

    assert.equal(lessons.length, 0);
    assert.equal(llm.requests.length, 1, 'exactly one call even for empty result');
  });
});

describe('LessonExtractor — empty contract (FR-5)', () => {
  it('returns [] without calling the LLM when all telemetry arrays are empty', async () => {
    const llm = new MockLLMClient([]);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });
    const emptyTelemetry: EpicTelemetry = {
      epic_id: 'epic-005',
      final_status: 'done',
      decision_traces: [],
      agents: [],
      audit_tail: [],
    };

    const lessons = await extractor.extract(emptyTelemetry);

    assert.equal(lessons.length, 0);
    assert.equal(llm.requests.length, 0, 'no LLM call when all arrays are empty');
  });

  it('calls the LLM when at least one telemetry array is non-empty', async () => {
    const llm = new MockLLMClient(['```json\n{"lessons":[]}\n```']);
    const extractor = new LessonExtractor({ llm, model: MODEL, skillMdPath: SKILL_MD_PATH });
    const telemetryWithAgents: EpicTelemetry = {
      epic_id: 'epic-005',
      final_status: 'done',
      decision_traces: [],
      agents: [{ story_id: 'story-1', review_summary: null, log_tail: null }],
      audit_tail: [],
    };

    await extractor.extract(telemetryWithAgents);

    assert.equal(llm.requests.length, 1, 'LLM called when agents array is non-empty');
  });
});
