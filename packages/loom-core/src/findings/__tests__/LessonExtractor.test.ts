/**
 * Non-agentic mode request shape tests for LessonExtractor (story-033-003).
 * Mirrors the IntakeClassifier regression test pattern (IntakeClassifier.test.ts:193-202).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { LessonExtractor } from '../LessonExtractor.js';
import type { EpicTelemetry } from '../LessonExtractor.js';

// ── FakeLLM ──────────────────────────────────────────────────────────────────

class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private queue: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.queue = [...responses];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLLM: no more scripted responses');
    if (next instanceof Error) throw next;
    return {
      text: next,
      model: req.model,
      stopReason: 'end_turn',
      usage: {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        requestCount: 1, costUsd: 0,
      },
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

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

function makeTelemetry(overrides: Partial<EpicTelemetry> = {}): EpicTelemetry {
  return {
    epic_id: 'epic-033',
    final_status: 'done',
    decision_traces: [
      {
        id: 1, agent_id: 'agent-1', epic_id: 'epic-033', story_id: 'story-1',
        kind: 'thinking', subject: 'schema', rationale: 'migrating to non-agentic mode',
        metadata: null, timestamp: '2026-01-01T00:00:00.000Z',
      },
    ],
    agents: [{ story_id: 'story-1', review_summary: 'LGTM', log_tail: 'tests passed' }],
    audit_tail: [],
    ...overrides,
  };
}

function validLessonResponse(count = 1): string {
  const lessons = Array.from({ length: count }, (_, i) => ({
    category: 'schema-migration',
    observation: `Observation ${i + 1}`,
    general_rule: `Rule ${i + 1}: apply consistently`,
  }));
  return '```json\n' + JSON.stringify({ lessons }) + '\n```';
}

/**
 * Worst-case payload: 10 lessons each with all optional fields populated,
 * representing a large but realistic epic (one lesson per story, ~10-story epic).
 * Used to validate the 2048 token ceiling is not undersized (AC2/FR-3).
 */
const WORST_CASE_LESSONS = Array.from({ length: 10 }, (_, i) => ({
  category: `schema-migration-${i}`,
  observation: `Observation ${i}: worker needed two attempts due to schema drift in the shared findings module.`,
  general_rule: `Rule ${i}: when migrating a shared schema, validate all consumers before landing the change.`,
  root_cause: `Root cause ${i}: the zod schema lacked an explicit default for nullable fields.`,
  evidence: `Evidence ${i}: audit row lesson_extractor_called followed by ZodError on lessons field.`,
}));
const WORST_CASE_RESPONSE = '```json\n' + JSON.stringify({ lessons: WORST_CASE_LESSONS }) + '\n```';

function makeExtractor(llm: LLMClient): LessonExtractor {
  return new LessonExtractor({ llm, model: 'haiku', skillMdPath: SKILL_MD_PATH });
}

// ── non-agentic mode request shape (AC1, AC2) ────────────────────────────────

describe('LessonExtractor — non-agentic mode request shape', () => {
  it('sets nonAgentic: { excludeDynamicSections: true } on the complete() call (AC1)', async () => {
    const fake = new FakeLLM([validLessonResponse()]);
    await makeExtractor(fake).extract(makeTelemetry());
    const req = fake.calls[0];
    assert.deepEqual(
      req.nonAgentic,
      { excludeDynamicSections: true },
      'complete() must carry nonAgentic: { excludeDynamicSections: true }',
    );
  });

  it('maxTokens is 2048 (AC2)', async () => {
    const fake = new FakeLLM([validLessonResponse()]);
    await makeExtractor(fake).extract(makeTelemetry());
    assert.equal(fake.calls[0].maxTokens, 2048, 'maxTokens must be exactly 2048');
  });

  it('2048 tokens is sufficient for a worst-case lessons payload (AC2/FR-3)', () => {
    // At ~4 chars per token, 2048 tokens ≈ 8192 chars.
    // A payload exceeding this would likely truncate mid-lesson and cause a parse error.
    const charLen = WORST_CASE_RESPONSE.length;
    const estTokens = Math.ceil(charLen / 4);
    assert.ok(
      estTokens <= 2048,
      `Worst-case payload is ~${estTokens} tokens (${charLen} chars) — 2048 may be undersized`,
    );
  });
});

// ── both attempts carry nonAgentic + maxTokens (AC1, AC2, both-attempts) ─────

describe('LessonExtractor — repair attempt also carries nonAgentic + maxTokens', () => {
  it('second (repair) attempt also carries nonAgentic: { excludeDynamicSections: true } and maxTokens=2048', async () => {
    // Force the first attempt to return malformed output so the repair fires.
    const fake = new FakeLLM(['not json at all', validLessonResponse()]);
    await makeExtractor(fake).extract(makeTelemetry());

    assert.equal(fake.calls.length, 2, 'must have two calls: initial + repair');
    for (const [i, req] of fake.calls.entries()) {
      assert.deepEqual(
        req.nonAgentic,
        { excludeDynamicSections: true },
        `call[${i}] must carry nonAgentic: { excludeDynamicSections: true }`,
      );
      assert.equal(req.maxTokens, 2048, `call[${i}] must carry maxTokens=2048`);
    }
  });
});

// ── static system prompt (AC3) ───────────────────────────────────────────────

describe('LessonExtractor — system prompt is self-contained (AC3)', () => {
  it('system block contains no cwd/env/git/memory dynamic placeholders', async () => {
    const fake = new FakeLLM([validLessonResponse()]);
    await makeExtractor(fake).extract(makeTelemetry());
    const req = fake.calls[0];
    const systemText = req.system.map(b => b.text).join('\n');

    const dynamicPatterns = [
      /\bcwd\b/i,
      /\bpwd\b/i,
      /working directory/i,
      /git status/i,
      /git branch/i,
      /process\.env/i,
      /\$HOME/i,
      /\$PATH/i,
      /memory path/i,
    ];

    for (const pattern of dynamicPatterns) {
      assert.ok(
        !pattern.test(systemText),
        `System prompt must not contain dynamic placeholder matching ${pattern}`,
      );
    }
  });

  it('system block is marked cache:true (prompt caching applied)', async () => {
    const fake = new FakeLLM([validLessonResponse()]);
    await makeExtractor(fake).extract(makeTelemetry());
    const req = fake.calls[0];
    assert.ok(req.system.length > 0, 'system must have at least one block');
    assert.equal(req.system[0].cache, true, 'first system block must be marked cache:true');
  });
});
