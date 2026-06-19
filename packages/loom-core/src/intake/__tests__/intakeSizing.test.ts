import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import { classifyIntake, type IntakeVerdict } from '../IntakeClassifier.js';
import { buildIntakeSizingInstruction, applyConservativeTiebreak } from '../intakePrompt.js';

// ── helpers ────────────────────────────────────────────────────────────────────

class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return {
      text: this.response,
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

function verdictJson(v: Partial<IntakeVerdict> & { type: IntakeVerdict['type']; size: IntakeVerdict['size']; confidence: IntakeVerdict['confidence'] }): string {
  return JSON.stringify({ rationale: 'test rationale', ...v });
}

// ── buildIntakeSizingInstruction — content checks ─────────────────────────────

describe('buildIntakeSizingInstruction', () => {
  it('returns a non-empty string', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(typeof text === 'string' && text.length > 0, 'should return a non-empty string');
  });

  it('mentions multiple functional areas as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.toLowerCase().includes('multiple functional area') || text.toLowerCase().includes('functional area'),
      'should mention multiple functional areas as an epic signal',
    );
  });

  it('mentions multiple services as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.toLowerCase().includes('multiple service') || text.toLowerCase().includes('services'),
      'should mention multiple services as an epic signal',
    );
  });

  it('mentions cross-cutting as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.toLowerCase().includes('cross-cutting') || text.toLowerCase().includes('cross cutting'),
      'should mention cross-cutting as an epic signal',
    );
  });

  it('mentions single bounded change as a story signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.toLowerCase().includes('single') && text.toLowerCase().includes('bounded'),
      'should mention single bounded change as a story signal',
    );
  });

  it('encodes the conservative tiebreak — default to epic under uncertainty', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.toLowerCase().includes('epic') && (
        text.toLowerCase().includes('uncertainty') ||
        text.toLowerCase().includes('uncertain') ||
        text.toLowerCase().includes('tiebreak') ||
        text.toLowerCase().includes('default to')
      ),
      'should instruct the LLM to default to epic under uncertainty',
    );
  });
});

// ── applyConservativeTiebreak — pure-function tests ───────────────────────────

describe('applyConservativeTiebreak', () => {
  it('upgrades story → epic when confidence is low (the tiebreak)', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'story', confidence: 'low',
      rationale: 'Scope is unclear, could span multiple services.',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.size, 'epic', 'low-confidence story should be upgraded to epic');
  });

  it('preserves all other fields when upgrading story → epic', () => {
    const verdict: IntakeVerdict = {
      type: 'bug', size: 'story', confidence: 'low', rationale: 'ambiguous scope',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.type, 'bug');
    assert.equal(result.confidence, 'low');
    assert.equal(result.rationale, 'ambiguous scope');
  });

  it('does NOT upgrade story → epic when confidence is medium (no over-sizing)', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'story', confidence: 'medium',
      rationale: 'Probably a single-service change.',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.size, 'story', 'medium-confidence story should not be auto-upgraded');
  });

  it('does NOT upgrade story → epic when confidence is high (no over-sizing)', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'story', confidence: 'high',
      rationale: 'Single bounded change within one service.',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.size, 'story', 'high-confidence story must remain a story');
  });

  it('keeps epic as epic for low confidence (already the richer size)', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'epic', confidence: 'low',
      rationale: 'Large multi-service refactor.',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.size, 'epic');
  });

  it('keeps epic as epic for high confidence', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'epic', confidence: 'high',
      rationale: 'Confirmed multi-team initiative.',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.equal(result.size, 'epic');
  });

  it('is a pure function — does not mutate the input', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'story', confidence: 'low', rationale: 'ambiguous',
    };
    const copy = { ...verdict };
    applyConservativeTiebreak(verdict);
    assert.deepEqual(verdict, copy, 'applyConservativeTiebreak must not mutate its input');
  });
});

// ── tiebreak pipeline — classifyIntake + applyConservativeTiebreak ────────────
//
// Pins the conservative tiebreak behavior end-to-end: the stub simulates an LLM
// that returned a low-confidence story; the tiebreak must upgrade it to epic.
// The second case guards against merely swapping bias — a clear story stays a story.

describe('conservative tiebreak — end-to-end pipeline', () => {
  it('low-confidence story verdict is upgraded to epic by the tiebreak', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'story', confidence: 'low' }));
    const raw = await classifyIntake(
      'Vague brief that might touch multiple services',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(raw.ok, 'classifyIntake should succeed with valid JSON');
    assert.equal(raw.verdict.size, 'story', 'raw classifier returns the LLM verdict before tiebreak');
    const final = applyConservativeTiebreak(raw.verdict);
    assert.equal(final.size, 'epic', 'after tiebreak, low-confidence story becomes epic');
  });

  it('high-confidence story is NOT upgraded — no over-sizing bias (guards against swap)', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'story', confidence: 'high' }));
    const raw = await classifyIntake(
      'Add a validation rule to the existing form',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(raw.ok);
    const final = applyConservativeTiebreak(raw.verdict);
    assert.equal(final.size, 'story', 'high-confidence story must remain a story — not every request becomes an epic');
  });

  it('medium-confidence story is NOT upgraded — tiebreak fires only on low confidence', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'chore', size: 'story', confidence: 'medium' }));
    const raw = await classifyIntake(
      'Update the CI pipeline configuration',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(raw.ok);
    const final = applyConservativeTiebreak(raw.verdict);
    assert.equal(final.size, 'story', 'medium-confidence story should not be auto-escalated');
  });

  it('explicit epic verdict is preserved regardless of confidence', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'epic', confidence: 'low' }));
    const raw = await classifyIntake(
      'Large-scale platform migration',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(raw.ok);
    const final = applyConservativeTiebreak(raw.verdict);
    assert.equal(final.size, 'epic', 'epic verdict is preserved after tiebreak');
  });
});
