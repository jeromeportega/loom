import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import { BriefRefiner, FALLBACK_QUALITY_SCORE } from '../brief/BriefRefiner.js';
import { evaluateBriefGate } from '../brief/gate.js';
import type { BriefRefinement } from '../brief/types.js';

/**
 * Exercises BriefRefiner.refine via a mock LLM that returns shaped JSON.
 * Under test: quality_score is the MODEL-EMITTED holistic judgment —
 * clamped to [0,10], fail-closed to 0 when missing or non-numeric — and
 * never derived from critique-array lengths.
 */
async function refineRaw(raw: Record<string, unknown>): Promise<BriefRefinement> {
  const json = JSON.stringify({ questions: [], delta: {}, ...raw });
  const llm = new MockLLMClient(() => '```json\n' + json + '\n```');
  const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
  return refiner.refine('any non-empty brief here');
}

describe('BriefRefiner.refine — model-emitted quality_score', () => {
  it('passes the model score through untouched when it is a valid 0-10 number', async () => {
    const r = await refineRaw({ ready: true, quality_score: 7, critique: {} });
    assert.equal(r.quality_score, 7);
  });

  it('ignores critique-array lengths: fully populated arrays with ready=true and score 8 pass the gate at threshold 6', async () => {
    const r = await refineRaw({
      ready: true,
      quality_score: 8,
      critique: {
        strong_points: ['clear goal'],
        ambiguities: ['a1', 'a2', 'a3', 'a4'],
        missing_scope: ['m1', 'm2', 'm3'],
        untestable_claims: ['u1', 'u2'],
        hidden_complexity: ['h1', 'h2', 'h3', 'h4', 'h5'],
      },
    });
    assert.equal(r.quality_score, 8);
    assert.equal(evaluateBriefGate(r, 6).pass, true);
  });

  it('clamps scores above 10 down to 10', async () => {
    const r = await refineRaw({ ready: true, quality_score: 12, critique: {} });
    assert.equal(r.quality_score, 10);
  });

  it('clamps negative scores up to 0', async () => {
    const r = await refineRaw({ ready: true, quality_score: -3, critique: {} });
    assert.equal(r.quality_score, 0);
  });

  it('maps a missing quality_score to 0 (fail closed)', async () => {
    const r = await refineRaw({ ready: true, critique: {} });
    assert.equal(r.quality_score, 0);
  });

  it('maps a non-numeric quality_score to 0 (fail closed)', async () => {
    const r = await refineRaw({ ready: true, quality_score: 'high', critique: {} });
    assert.equal(r.quality_score, 0);
  });

  it('maps a missing or non-boolean ready to false', async () => {
    const missing = await refineRaw({ quality_score: 9, critique: {} });
    assert.equal(missing.ready, false);
    const nonBool = await refineRaw({ ready: 'yes', quality_score: 9, critique: {} });
    assert.equal(nonBool.ready, false);
  });

  it('falls back to ready=false and FALLBACK_QUALITY_SCORE when the response is unparseable', async () => {
    const llm = new MockLLMClient(() => 'totally garbled non-JSON nonsense with no brief in it');
    const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
    const r = await refiner.refine('any rough brief');
    assert.equal(r.ready, false);
    assert.equal(r.quality_score, FALLBACK_QUALITY_SCORE);
  });

  it('sends JSON schema instructions that require the quality_score field', async () => {
    const llm = new MockLLMClient(() =>
      '```json\n' +
      JSON.stringify({ ready: true, quality_score: 8, critique: {}, questions: [], delta: {} }) +
      '\n```'
    );
    const refiner = new BriefRefiner({ projectRoot: '/tmp', llm, model: 'm' });
    await refiner.refine('any non-empty brief here');
    const systemText = llm.requests[0].system.map((b) => b.text).join('\n');
    assert.match(systemText, /"quality_score": number/);
    assert.match(systemText, /holistic 0-10/);
  });
});
