import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { createLessonExtractorConsumer } from '../consumer.js';
import { main } from '../run.js';
import type { LessonExtractorCase } from '../caseSchema.js';
import { LESSON_EXTRACTOR_THRESHOLDS } from '../score.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/** Returns a minimal LLM response with the given number of lessons for the gate step. */
function gateJson(count = 1): string {
  const lessons = Array.from({ length: count }, (_, i) => ({
    category:     `category-${i + 1}`,
    observation:  `Observation ${i + 1}`,
    general_rule: `Rule ${i + 1} applies here.`,
  }));
  return wrapJson({ lessons });
}

/** Returns a valid judge LLM response. */
function judgeJson(overrides: Record<string, unknown> = {}): string {
  return wrapJson({
    total_lessons:        1,
    faithfulness:         0.9,
    usefulness:           0.8,
    coverage:             'full',
    hallucinated_lessons: 0,
    over_extraction:      false,
    reason:               'Test judgment.',
    ...overrides,
  });
}

const MINIMAL_TELEMETRY: LessonExtractorCase['telemetry'] = {
  epic_id:         'epic-consumer-test-001',
  final_status:    'done',
  decision_traces: [
    {
      id:        1,
      agent_id:  'agent-1',
      epic_id:   'epic-consumer-test-001',
      story_id:  'story-1',
      kind:      'plan',
      subject:   'task',
      rationale: 'Did the task correctly.',
      metadata:  null,
      timestamp: '2026-01-01T00:00:00Z',
    },
  ],
  agents: [
    { story_id: 'story-1', review_summary: 'All good.', log_tail: '[ok] done' },
  ],
  audit_tail: [
    {
      id:          1,
      agent_id:    'agent-1',
      action:      'bash',
      command:     'npm test',
      allowed:     true,
      policy_rule: null,
      detail:      'exit 0',
      timestamp:   '2026-01-01T00:00:01Z',
    },
  ],
};

const BASE_CASE: LessonExtractorCase = {
  id:        'le-consumer-test-001',
  source:    'rich',
  telemetry: MINIMAL_TELEMETRY,
  rubric: {
    expected_themes:       ['correct implementation improves reliability'],
    over_extraction_traps: ['Routine test passes should not generate lessons.'],
  },
  rationale: 'Basic consumer test case.',
};

/**
 * Creates a temp project root with a minimal SKILL.md at
 * skills/lesson-extractor/SKILL.md.
 */
function makeTempProjectRoot(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-consumer-test-'));
  const skillsDir = path.join(tmpDir, 'skills', 'lesson-extractor');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), '# Lesson Extractor\n\nExtract lessons.', 'utf8');
  return tmpDir;
}

function makeTmpFixture(cases: LessonExtractorCase[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'le-fixture-'));
  const file = path.join(tmpDir, 'lesson-extractor.yaml');
  fs.writeFileSync(file, yaml.dump({ cases }));
  return file;
}

// ── createLessonExtractorConsumer shape ────────────────────────────────────────

describe('createLessonExtractorConsumer — shape', () => {
  it('returns an object with all six GateEvalConsumer methods/fields', () => {
    const c = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    assert.equal(typeof c.loadCases, 'function');
    assert.equal(typeof c.runGate, 'function');
    assert.equal(typeof c.judge, 'function');
    assert.equal(typeof c.score, 'function');
    assert.equal(typeof c.verdict, 'function');
    assert.ok(c.thresholds !== undefined, 'thresholds present');
    assert.equal(c.thresholds.minScoredCases,           LESSON_EXTRACTOR_THRESHOLDS.minScoredCases);
    assert.equal(c.thresholds.maxGateFailureRate,       LESSON_EXTRACTOR_THRESHOLDS.maxGateFailureRate);
    assert.equal(c.thresholds.maxJudgeInconclusiveRate, LESSON_EXTRACTOR_THRESHOLDS.maxJudgeInconclusiveRate);
  });

  it('loadCases accepts a fixturePath and returns typed case objects', () => {
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const consumer = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    const cases = consumer.loadCases(fixturePath);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, 'le-consumer-test-001');
    assert.equal(cases[0].source, 'rich');
  });
});

// ── runGate wiring ─────────────────────────────────────────────────────────────

describe('createLessonExtractorConsumer — runGate', () => {
  it('returns { status: ok, output: Lesson[] } on a clean gate response', async () => {
    const projectRoot = makeTempProjectRoot();
    const llm = new MockLLMClient([gateJson(1)]);
    const consumer = createLessonExtractorConsumer({ projectRoot });
    const result = await consumer.runGate(BASE_CASE, { llm, gateModel: 'test-model' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.ok(Array.isArray(result.output), 'output is array');
    assert.equal(result.output.length, 1);
    assert.equal(result.output[0].category, 'category-1');
  });

  it('returns { status: ok, output: [] } for an empty lesson set', async () => {
    const projectRoot = makeTempProjectRoot();
    const llm = new MockLLMClient([gateJson(0)]);
    const consumer = createLessonExtractorConsumer({ projectRoot });
    const result = await consumer.runGate(BASE_CASE, { llm, gateModel: 'test-model' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.output, []);
  });

  it('maps LLM throw to { status: failed }', async () => {
    const projectRoot = makeTempProjectRoot();
    const failLLM = { async complete() { throw new Error('LLM outage'); } };
    const consumer = createLessonExtractorConsumer({ projectRoot });
    const result = await consumer.runGate(BASE_CASE, { llm: failLLM as any, gateModel: 'g' });
    assert.equal(result.status, 'failed');
  });
});

// ── judge wiring ───────────────────────────────────────────────────────────────

describe('createLessonExtractorConsumer — judge', () => {
  const MOCK_GATE_OUTPUT: import('../../../findings/lesson.js').Lesson[] = [];

  it('returns ok judgment with all LessonExtractorJudgment fields', async () => {
    const llm = new MockLLMClient([judgeJson({ total_lessons: 0, hallucinated_lessons: 0 })]);
    const consumer = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    const result = await consumer.judge(BASE_CASE, MOCK_GATE_OUTPUT, { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(typeof result.judgment.faithfulness, 'number');
    assert.equal(typeof result.judgment.usefulness, 'number');
    assert.ok(['full', 'partial', 'missing'].includes(result.judgment.coverage));
    assert.equal(typeof result.judgment.hallucinated_lessons, 'number');
    assert.equal(typeof result.judgment.over_extraction, 'boolean');
    assert.equal(typeof result.judgment.reason, 'string');
  });

  it('maps LLM outage to { status: inconclusive }', async () => {
    const failLLM = { async complete() { throw new Error('timeout'); } };
    const consumer = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    const result = await consumer.judge(BASE_CASE, MOCK_GATE_OUTPUT, { llm: failLLM as any, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});

// ── score wiring ───────────────────────────────────────────────────────────────

describe('createLessonExtractorConsumer — score', () => {
  it('delegates to scoreLessonExtractor and returns LessonExtractorMetrics', () => {
    const consumer = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    const m = consumer.score([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.faithfulness, 0);
    assert.equal(m.usefulness, 0);
    assert.equal(m.coverage, 0);
    assert.equal(m.hallucinationRate, 0);
    assert.equal(m.overExtractionRate, 0);
  });

  it('perCase records flow through to the verdict', () => {
    const consumer = createLessonExtractorConsumer({ projectRoot: '/tmp' });
    // High-quality records → proceed
    const records = Array.from({ length: 3 }, (_, i) => ({
      caseId: `case-${i}`,
      gate:   { status: 'ok' as const, output: [] as import('../../../findings/lesson.js').Lesson[] },
      judge:  {
        status:   'ok' as const,
        judgment: {
          total_lessons:        0,
          faithfulness:         0.95,
          usefulness:           0.90,
          coverage:             'full' as const,
          hallucinated_lessons: 0,
          over_extraction:      false,
          reason:               'high quality',
        },
      },
    }));
    const m = consumer.score(records);
    assert.ok(m.faithfulness >= 0.80, 'faithfulness above threshold');
    assert.ok(m.usefulness >= 0.70, 'usefulness above threshold');
    const verdict = consumer.verdict(m);
    assert.equal(verdict, 'proceed');
  });
});

// ── main() — end-to-end with MockLLMClient ────────────────────────────────────

describe('main() — end-to-end with MockLLMClient', () => {
  it('returns EvalReport with all four aggregate metrics + decision + perCase + markdown', async () => {
    const projectRoot = makeTempProjectRoot();
    const fixturePath = makeTmpFixture([
      { ...BASE_CASE, id: 'le-e2e-001' },
      { ...BASE_CASE, id: 'le-e2e-002', source: 'thin' },
      { ...BASE_CASE, id: 'le-e2e-003' },
    ]);

    // Each case: one gate call + one judge call (scored cases get both)
    const responses = Array.from({ length: 3 }, () => [
      gateJson(1),
      judgeJson({ total_lessons: 1, faithfulness: 0.9, usefulness: 0.8, coverage: 'full', hallucinated_lessons: 0 }),
    ]).flat();
    const llm = new MockLLMClient(responses);

    const report = await main({ llm, fixturePath, projectRoot, gateModel: 'g', judgeModel: 'j' });

    // All four aggregate metrics present (AC: single invocation returns all four)
    assert.equal(typeof report.metrics.faithfulness,    'number', 'faithfulness metric present');
    assert.equal(typeof report.metrics.usefulness,      'number', 'usefulness metric present');
    assert.equal(typeof report.metrics.coverage,        'number', 'coverage metric present');
    assert.equal(typeof report.metrics.hallucinationRate, 'number', 'hallucinationRate metric present');
    assert.equal(typeof report.metrics.overExtractionRate, 'number', 'overExtractionRate metric present');

    // decision + perCase + markdown present
    assert.ok(report.decision !== undefined, 'decision present');
    assert.ok(['proceed', 'do-not-proceed', 'inconclusive'].includes(report.decision.verdict));
    assert.ok(Array.isArray(report.perCase), 'perCase is array');
    assert.equal(report.perCase.length, 3);
    assert.equal(typeof report.markdown, 'string');
    assert.ok(report.markdown.includes('Lesson-Extractor Eval Report'), 'markdown has title');
    assert.ok(report.markdown.includes(report.decision.verdict), 'markdown contains verdict');
  });

  it('report side-effect: writes .loom/eval/lesson-extractor-report.{md,json}', async () => {
    const projectRoot = makeTempProjectRoot();
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson(1),
      judgeJson({ total_lessons: 1, hallucinated_lessons: 0 }),
    ]);

    await main({ llm, fixturePath, projectRoot, gateModel: 'g', judgeModel: 'j' });

    const reportDir = path.join(projectRoot, '.loom', 'eval');
    const mdPath   = path.join(reportDir, 'lesson-extractor-report.md');
    const jsonPath = path.join(reportDir, 'lesson-extractor-report.json');

    assert.ok(fs.existsSync(mdPath),   'lesson-extractor-report.md written');
    assert.ok(fs.existsSync(jsonPath), 'lesson-extractor-report.json written');

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.ok(parsed.metrics !== undefined,  'JSON has metrics');
    assert.ok(parsed.decision !== undefined, 'JSON has decision');
    assert.ok(Array.isArray(parsed.perCase), 'JSON has perCase array');

    const md = fs.readFileSync(mdPath, 'utf8');
    assert.ok(md.includes('Faithfulness'), 'markdown contains Faithfulness metric');
    assert.ok(md.includes('Hallucination rate'), 'markdown contains Hallucination rate metric');
  });

  it('uses only the injected MockLLMClient — no real client constructed', async () => {
    const projectRoot = makeTempProjectRoot();
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson(1),
      judgeJson({ total_lessons: 1, hallucinated_lessons: 0 }),
    ]);

    const report = await main({ llm, fixturePath, projectRoot, gateModel: 'g', judgeModel: 'j' });
    assert.ok(report !== undefined, 'report produced with mock only');
  });

  it('too few scored cases → inconclusive / do-not-proceed (fail-closed)', async () => {
    // 1 case: scoredCases(1) < minScoredCases(2) → inconclusive
    const projectRoot = makeTempProjectRoot();
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson(1),
      judgeJson({ total_lessons: 1, hallucinated_lessons: 0 }),
    ]);

    const { decision } = await main({ llm, fixturePath, projectRoot, gateModel: 'g', judgeModel: 'j' });
    assert.ok(
      decision.verdict === 'inconclusive' || decision.verdict === 'do-not-proceed',
      `expected fail-closed verdict, got: ${decision.verdict}`,
    );
  });

  it('gate sequential call order: gate first, then judge, for each case', async () => {
    const projectRoot = makeTempProjectRoot();
    const cases: LessonExtractorCase[] = Array.from({ length: 3 }, (_, i) => ({
      ...BASE_CASE,
      id: `le-order-${i}`,
    }));
    const fixturePath = makeTmpFixture(cases);
    const responses = cases.flatMap(() => [
      gateJson(1),
      judgeJson({ total_lessons: 1, hallucinated_lessons: 0 }),
    ]);
    const llm = new MockLLMClient(responses);

    await main({ llm, fixturePath, projectRoot, gateModel: 'gate-model', judgeModel: 'judge-model' });

    assert.equal(llm.requests.length, 6, '3 gate + 3 judge calls');
    for (let i = 0; i < cases.length; i++) {
      assert.equal(llm.requests[i * 2].model,     'gate-model',  `call ${i * 2} must be gate`);
      assert.equal(llm.requests[i * 2 + 1].model, 'judge-model', `call ${i * 2 + 1} must be judge`);
    }
  });
});

// ── Sub-barrel surface (structural) ───────────────────────────────────────────

describe('sub-barrel surface — src/eval/lesson-extractor/index.ts', () => {
  it('re-exports createLessonExtractorConsumer from consumer.js', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.createLessonExtractorConsumer, 'function');
  });

  it('re-exports core schema and loader symbols', async () => {
    const mod = await import('../index.js');
    assert.ok(mod.LessonExtractorCaseSchema !== undefined, 'LessonExtractorCaseSchema exported');
    assert.equal(typeof mod.loadLessonExtractorCases, 'function', 'loadLessonExtractorCases exported');
  });

  it('re-exports model resolution symbols', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.resolveLessonExtractorModels, 'function', 'resolveLessonExtractorModels exported');
    assert.ok(mod.DEFAULT_GATE_MODEL !== undefined, 'DEFAULT_GATE_MODEL exported');
  });

  it('re-exports scorer and thresholds', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.scoreLessonExtractor, 'function', 'scoreLessonExtractor exported');
    assert.ok(mod.LESSON_EXTRACTOR_THRESHOLDS !== undefined, 'LESSON_EXTRACTOR_THRESHOLDS exported');
    assert.equal(typeof mod.lessonExtractorVerdict, 'function', 'lessonExtractorVerdict exported');
  });

  it('re-exports runGate and judge symbols', async () => {
    const mod = await import('../index.js');
    assert.equal(typeof mod.runLessonExtractorGate, 'function', 'runLessonExtractorGate exported');
    assert.equal(typeof mod.judgeLessonExtraction, 'function', 'judgeLessonExtraction exported');
  });
});

// ── Top-barrel constraint (ADR-001 / dogfooding S41) ─────────────────────────

describe('top-barrel constraint — src/eval/index.ts gains ZERO new lines', () => {
  it('does not re-export lesson-extractor wildcard from src/eval/index.ts', async () => {
    // The top barrel must have no wildcard export for lesson-extractor.
    // Verify by importing from the top barrel and checking that consumer symbols
    // are NOT present there (they must be imported via deep import only).
    const topBarrel = await import('../../index.js');
    // createLessonExtractorConsumer is only reachable by deep import, not top barrel
    assert.equal(
      (topBarrel as Record<string, unknown>)['createLessonExtractorConsumer'],
      undefined,
      'createLessonExtractorConsumer must NOT be in top barrel (ADR-001)',
    );
    assert.equal(
      (topBarrel as Record<string, unknown>)['scoreLessonExtractor'],
      undefined,
      'scoreLessonExtractor must NOT be in top barrel (ADR-001)',
    );
  });
});

// ── Zero-framework-edits smoke test ───────────────────────────────────────────

describe('createLessonExtractorConsumer — zero framework edits (smoke)', () => {
  it('runGateEval loops through consumer methods without modifying framework', async () => {
    const { runGateEval } = await import('../../framework/runGateEval.js');
    const { decide }      = await import('../../framework/decide.js');

    const projectRoot = makeTempProjectRoot();
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson(1),
      judgeJson({ total_lessons: 1, hallucinated_lessons: 0 }),
    ]);

    const consumer = createLessonExtractorConsumer({ projectRoot });
    const cases    = consumer.loadCases(fixturePath);
    const deps     = { llm, gateModel: 'g', judgeModel: 'j' };

    const perCase  = await runGateEval(cases, consumer, deps);
    const metrics  = consumer.score(perCase);
    const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));

    assert.equal(perCase.length, 1);
    assert.ok(metrics !== undefined);
    assert.ok(decision !== undefined);
  });
});
