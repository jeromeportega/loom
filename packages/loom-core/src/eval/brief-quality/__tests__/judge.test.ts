import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { judgeBriefQuality, scoreInBand } from '../judge.js';
import type { BriefQualityCase } from '../caseSchema.js';
import type { BriefRefinement } from '../../../brief/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function makeLLMJudgment(
  readiness_correct: boolean,
  critique_fidelity: 'faithful' | 'partial' | 'fabricated',
  reason = 'Test reason.',
): string {
  return wrapJson({ readiness_correct, critique_fidelity, reason });
}

function makeCase(overrides: Partial<BriefQualityCase> = {}): BriefQualityCase {
  return {
    id:              'bq-test-001',
    source:          'anchor',
    category:        'plan-ready',
    brief:           'Add a --version flag to the CLI.',
    expected_ready:  true,
    expected_band:   'high',
    critique_themes: ['clear scope', 'testable acceptance criterion'],
    rationale:       'Classic single-concern CLI addition.',
    ...overrides,
  };
}

function makeRefinement(overrides: Partial<BriefRefinement> = {}): BriefRefinement {
  return {
    ready:         true,
    original:      'Add a --version flag to the CLI.',
    quality_score: 8,
    critique: {
      strong_points:      ['well-bounded scope'],
      ambiguities:        [],
      missing_scope:      [],
      untestable_claims:  [],
      hidden_complexity:  [],
    },
    questions: [],
    delta: {
      added_sections:      [],
      clarifications:      [],
      flagged_assumptions: [],
    },
    ...overrides,
  };
}

const DEPS = { llm: new MockLLMClient([]) as LLMClient, judgeModel: 'judge-model' };

// ── Persona prompt wiring ─────────────────────────────────────────────────────

describe('judgeBriefQuality — prompt wiring', () => {
  it('uses the brief-quality-judge persona (cache: true on system block)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    assert.equal(llm.requests.length, 1);
    assert.ok(llm.allCacheableBlocksMarked(), 'system prompt block should be cached');
  });

  it('passes judgeModel to the LLM request', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'my-judge-model' });
    assert.equal(llm.requests[0].model, 'my-judge-model');
  });

  it('includes the brief text in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    await judgeBriefQuality(makeCase({ brief: 'Unique brief text XYZ.' }), makeRefinement(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content;
    assert.ok(userMsg.includes('Unique brief text XYZ.'), 'brief should appear in user message');
  });

  it('includes expected_ready and expected_band in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    await judgeBriefQuality(makeCase({ expected_ready: false, expected_band: 'low' }), makeRefinement(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content;
    assert.ok(userMsg.includes('expected_ready: false'));
    assert.ok(userMsg.includes('expected_band: low'));
  });

  it('includes BriefRefiner ready and quality_score in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    await judgeBriefQuality(makeCase(), makeRefinement({ ready: false, quality_score: 3 }), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content;
    assert.ok(userMsg.includes('ready: false'));
    assert.ok(userMsg.includes('quality_score: 3'));
  });
});

// ── Parsing — happy path ──────────────────────────────────────────────────────

describe('judgeBriefQuality — parsing', () => {
  it('returns ok judgment with all four axes on valid LLM response', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful', 'Good critique.')]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement({ quality_score: 8 }), { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.readiness_correct, true);
    assert.equal(result.judgment.critique_fidelity, 'faithful');
    assert.equal(result.judgment.reason, 'Good critique.');
    assert.equal(typeof result.judgment.quality_in_band, 'boolean', 'quality_in_band is a boolean');
  });

  it('parses partial fidelity correctly', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(false, 'partial')]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.readiness_correct, false);
    assert.equal(result.judgment.critique_fidelity, 'partial');
  });

  it('parses fabricated fidelity correctly', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(false, 'fabricated')]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.critique_fidelity, 'fabricated');
  });
});

// ── quality_in_band computed by code ─────────────────────────────────────────

describe('judgeBriefQuality — quality_in_band (computed in TypeScript, not from LLM)', () => {
  it('high band [7,10] with score=8: in band', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'high' }), makeRefinement({ quality_score: 8 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, true);
  });

  it('high band [7,10] with score=6: in band (τ=1 → lo-1=6)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'high' }), makeRefinement({ quality_score: 6 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, true, 'score 6 should agree with high band (6 = 7-1)');
  });

  it('high band [7,10] with score=5: out of band', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'high' }), makeRefinement({ quality_score: 5 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, false, 'score 5 should miss high band');
  });

  it('low band [0,3] with score=4: in band (τ=1 → hi+1=4)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(false, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'low', expected_ready: false }), makeRefinement({ quality_score: 4 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, true, 'score 4 should agree with low band (4 = 3+1)');
  });

  it('low band [0,3] with score=5: out of band', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(false, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'low', expected_ready: false }), makeRefinement({ quality_score: 5 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, false, 'score 5 should miss low band');
  });

  it('mid band [4,6] with score=7: in band (τ=1 → hi+1=7, the 6-vs-7 edge)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment(true, 'faithful')]);
    const result = await judgeBriefQuality(makeCase({ expected_band: 'mid' }), makeRefinement({ quality_score: 7 }), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.quality_in_band, true, 'score 7 should agree with mid band (7 = 6+1)');
  });
});

// ── scoreInBand unit tests ────────────────────────────────────────────────────

describe('scoreInBand — boundary math (τ=1)', () => {
  it('high [7,10]: s=6 agrees', () => { assert.equal(scoreInBand(6, 'high'), true); });
  it('high [7,10]: s=5 misses', () => { assert.equal(scoreInBand(5, 'high'), false); });
  it('high [7,10]: s=10 agrees', () => { assert.equal(scoreInBand(10, 'high'), true); });
  it('high [7,10]: s=11 agrees (hi+1)', () => { assert.equal(scoreInBand(11, 'high'), true); });
  it('high [7,10]: s=12 misses', () => { assert.equal(scoreInBand(12, 'high'), false); });

  it('low [0,3]: s=4 agrees', () => { assert.equal(scoreInBand(4, 'low'), true); });
  it('low [0,3]: s=5 misses', () => { assert.equal(scoreInBand(5, 'low'), false); });
  it('low [0,3]: s=0 agrees', () => { assert.equal(scoreInBand(0, 'low'), true); });

  it('mid [4,6]: s=7 agrees (6-vs-7 edge)', () => { assert.equal(scoreInBand(7, 'mid'), true); });
  it('mid [4,6]: s=3 agrees (lo-1)', () => { assert.equal(scoreInBand(3, 'mid'), true); });
  it('mid [4,6]: s=2 misses', () => { assert.equal(scoreInBand(2, 'mid'), false); });
  it('mid [4,6]: s=8 misses', () => { assert.equal(scoreInBand(8, 'mid'), false); });
});

// ── Failure / inconclusive ────────────────────────────────────────────────────

describe('judgeBriefQuality — failure modes degrade to inconclusive', () => {
  it('returns inconclusive on LLM outage (throwing LLMClient)', async () => {
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('LLM outage'); },
    };
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm: throwingLLM, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
    if (result.status !== 'inconclusive') return;
    assert.ok(result.detail.includes('LLM outage'));
  });

  it('returns inconclusive on unparseable LLM response (never a fabricated pass)', async () => {
    const llm = new MockLLMClient(['not valid json at all']);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'parse failure must not produce a fabricated pass');
  });

  it('returns inconclusive on invalid enum value in LLM response', async () => {
    const llm = new MockLLMClient([wrapJson({ readiness_correct: true, critique_fidelity: 'wrong-value', reason: 'x' })]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on missing required fields in LLM response', async () => {
    const llm = new MockLLMClient([wrapJson({ readiness_correct: true })]);
    const result = await judgeBriefQuality(makeCase(), makeRefinement(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});
