import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { runLessonExtractorGate, resolveLessonExtractorSkillMd } from '../runGate.js';
import { DEFAULT_GATE_MODEL } from '../models.js';
import type { LessonExtractorCase } from '../caseSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/**
 * Creates a temp directory with a skills/lesson-extractor/SKILL.md file.
 * Returns the projectRoot (the temp directory path).
 */
function makeTempProjectRoot(skillMdContent: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-gate-test-'));
  const skillsDir = path.join(tmpDir, 'skills', 'lesson-extractor');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillMdContent, 'utf8');
  return tmpDir;
}

/** A minimal valid lesson payload as the LLM response. */
function lessonJson(count = 1): string {
  const lessons = Array.from({ length: count }, (_, i) => ({
    category: `test-category-${i + 1}`,
    observation: `Observation ${i + 1}`,
    general_rule: `Rule ${i + 1} should always apply.`,
  }));
  return wrapJson({ lessons });
}

function makeCase(overrides: Partial<LessonExtractorCase> = {}): LessonExtractorCase {
  return {
    id: 'le-gate-test-001',
    source: 'rich',
    telemetry: {
      epic_id: 'epic-gate-test-001',
      final_status: 'done',
      decision_traces: [
        {
          id: 1,
          agent_id: 'agent-1',
          epic_id: 'epic-gate-test-001',
          story_id: 'story-1',
          kind: 'plan',
          subject: 'task decomposition',
          rationale: 'Split work into parallel stories for efficiency.',
          metadata: null,
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      agents: [
        {
          story_id: 'story-1',
          review_summary: 'Delivered within scope.',
          log_tail: null,
        },
      ],
      audit_tail: [],
    },
    rubric: {
      expected_themes: ['parallelism', 'scope management'],
      over_extraction_traps: ['generic advice not grounded in evidence'],
    },
    rationale: 'A rich case with enough telemetry to exercise extraction.',
    ...overrides,
  };
}

const DUMMY_SKILL_MD = '# Lesson Extractor (probe)\nExtract structured lessons.';

// ── resolveLessonExtractorSkillMd ─────────────────────────────────────────────

describe('resolveLessonExtractorSkillMd', () => {
  it('resolves to skills/lesson-extractor/SKILL.md under projectRoot', () => {
    const resolved = resolveLessonExtractorSkillMd('/repo/root');
    assert.equal(resolved, path.resolve('/repo/root', 'skills/lesson-extractor/SKILL.md'));
  });

  it('resolves to an absolute path even when projectRoot is relative', () => {
    const resolved = resolveLessonExtractorSkillMd('relative/path');
    assert.ok(path.isAbsolute(resolved), 'must return an absolute path');
    assert.ok(resolved.endsWith('skills/lesson-extractor/SKILL.md'));
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('runLessonExtractorGate — happy path', () => {
  it('returns { status: ok, output: Lesson[] } when extractor succeeds', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([lessonJson(2)]);
    const c = makeCase();

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.length, 2, 'output must contain 2 lessons');
    assert.equal(result.output[0].category, 'test-category-1');
    assert.equal(result.output[1].category, 'test-category-2');
  });

  it('handler-stamped fields (epic_id, created_at, applied_as, applied_ref) are present', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    const lesson = result.output[0];
    assert.equal(lesson.epic_id, c.telemetry.epic_id, 'epic_id must be stamped from telemetry');
    assert.ok(typeof lesson.created_at === 'string' && lesson.created_at.length > 0, 'created_at must be set');
    assert.equal(lesson.applied_as, null, 'applied_as must default to null');
    assert.equal(lesson.applied_ref, null, 'applied_ref must default to null');
  });

  it('returns { status: ok, output: [] } for thin telemetry (empty arrays short-circuit)', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([]);
    const c = makeCase({
      source: 'thin',
      telemetry: {
        epic_id: 'epic-thin-001',
        final_status: 'done',
        decision_traces: [],
        agents: [],
        audit_tail: [],
      },
    });

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.output, [], 'thin telemetry must produce empty lesson array');
    assert.equal(llm.requests.length, 0, 'LLM must not be called for empty telemetry (short-circuit)');
  });
});

// ── Drives production, not a copy (ADR-002) ───────────────────────────────────

describe('runLessonExtractorGate — drives production LessonExtractor (ADR-002)', () => {
  it('mock LLM receives the SKILL.md content in the system prompt', async () => {
    const uniqueContent = '# Lesson Extractor Skill (probe-4e8f2c1a)\nExtract structured lessons.\n';
    const projectRoot = makeTempProjectRoot(uniqueContent);
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(llm.requests.length, 1, 'should have made exactly one LLM call');
    const systemText = llm.requests[0].system[0].text;
    assert.ok(
      systemText.startsWith(uniqueContent),
      'system prompt must begin with the SKILL.md content — proves the real LessonExtractor is used',
    );
  });

  it('system prompt block is marked cacheable (matching production LessonExtractor behavior)', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(llm.requests[0].system[0].cache, true, 'system block must be cache-marked');
  });

  it('uses deps.gateModel as the LLM model — proves the real extractor is wired', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const model = 'claude-haiku-test-probe-999';
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: model }, { projectRoot });

    assert.equal(llm.requests[0].model, model, 'LLM must be called with deps.gateModel');
  });
});

// ── Telemetry passed through unchanged (observe-only) ─────────────────────────

describe('runLessonExtractorGate — telemetry passed through unchanged', () => {
  it('user message content equals JSON.stringify(c.telemetry)', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();
    const expectedContent = JSON.stringify(c.telemetry);

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(
      llm.requests[0].messages[0].content,
      expectedContent,
      'telemetry must be serialized and passed through to extract() unchanged',
    );
  });

  it('c.telemetry is not mutated after the gate runs', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();
    const snapshot = JSON.parse(JSON.stringify(c.telemetry));

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.deepEqual(c.telemetry, snapshot, 'gate must not mutate the case telemetry (observe-only)');
  });
});

// ── Failure path ──────────────────────────────────────────────────────────────

describe('runLessonExtractorGate — failure path', () => {
  it('returns { status: failed, detail } when the extractor throws (malformed output)', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    // LessonExtractor retries once — two garbage responses cause both attempts to fail and throw.
    const llm = new MockLLMClient(['not json at all', 'also garbage']);
    const c = makeCase();

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'failed', 'extractor throw must become { status: failed }');
    if (result.status !== 'failed') return;
    assert.ok(
      result.detail.includes('malformed output'),
      `detail must describe the failure; got: ${result.detail}`,
    );
  });

  it('never throws out of the gate — always returns ok or failed', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('simulated LLM outage'); },
    };
    const c = makeCase();

    const result = await runLessonExtractorGate(
      c, { llm: throwingLLM, gateModel: 'g' }, { projectRoot },
    );

    assert.equal(result.status, 'failed', 'LLM throw must not escape the gate');
    if (result.status !== 'failed') return;
    assert.ok(result.detail.includes('LLM outage'), `detail: ${result.detail}`);
  });

  it('detail is String(e) of the thrown error', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const llm = new MockLLMClient(['junk', 'junk']);
    const c = makeCase();

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0, 'detail must be a non-empty string');
  });

  it('missing SKILL.md causes { status: failed } without throwing', async () => {
    const projectRoot = '/nonexistent-path-that-definitely-does-not-exist-xyz';
    const llm = new MockLLMClient([]);
    const c = makeCase();

    const result = await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: 'g' }, { projectRoot });

    assert.equal(result.status, 'failed', 'missing SKILL.md must produce { status: failed }');
  });
});

// ── Model resolution (FR-7) ───────────────────────────────────────────────────

describe('runLessonExtractorGate — model resolution (FR-7)', () => {
  it('DEFAULT_GATE_MODEL is claude-haiku-4-5-20251001', () => {
    assert.equal(DEFAULT_GATE_MODEL, 'claude-haiku-4-5-20251001');
  });

  it('passes deps.gateModel directly to the extractor', async () => {
    const projectRoot = makeTempProjectRoot(DUMMY_SKILL_MD);
    const model = 'claude-sonnet-4-6';
    const llm = new MockLLMClient([lessonJson(1)]);
    const c = makeCase();

    await runLessonExtractorGate(c, { llm: llm as LLMClient, gateModel: model }, { projectRoot });

    assert.equal(llm.requests[0].model, model);
  });
});
