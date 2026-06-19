import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import type { IntakeVerdict } from '../IntakeClassifier.js';
import { buildIntakeSizingInstruction, applyConservativeTiebreak } from '../intakePrompt.js';
import { classifyWithTiebreak } from '../intakePipeline.js';

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

function verdictJson(
  v: Pick<IntakeVerdict, 'type' | 'size' | 'confidence'> & Partial<Omit<IntakeVerdict, 'type' | 'size' | 'confidence'>>,
): string {
  return JSON.stringify({ rationale: 'test rationale', ...v });
}

// ── buildIntakeSizingInstruction — content checks ─────────────────────────────

describe('buildIntakeSizingInstruction', () => {
  it('returns a non-empty string', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(typeof text === 'string' && text.length > 0, 'should return a non-empty string');
  });

  it('names multiple functional areas as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.includes('multiple functional areas'),
      'exact phrase "multiple functional areas" must appear',
    );
  });

  it('names multiple services as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.includes('multiple services'),
      'exact phrase "multiple services" must appear',
    );
  });

  it('names cross-cutting as an epic signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.includes('cross-cutting'),
      'exact phrase "cross-cutting" must appear',
    );
  });

  it('names single bounded change as a story signal', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.includes('single, bounded change') || text.includes('single bounded change'),
      '"single, bounded change" or "single bounded change" must appear',
    );
  });

  it('encodes the conservative tiebreak — default to epic under uncertainty', () => {
    const text = buildIntakeSizingInstruction();
    assert.ok(
      text.includes('Under uncertainty, always resolve to epic') ||
      (text.toLowerCase().includes('tiebreak') && text.toLowerCase().includes('epic')),
      'must instruct LLM to default to epic under uncertainty',
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

  it('always returns a new object — even in the no-op branch', () => {
    const verdict: IntakeVerdict = {
      type: 'feature', size: 'story', confidence: 'high', rationale: 'clear scope',
    };
    const result = applyConservativeTiebreak(verdict);
    assert.notEqual(result, verdict, 'must return a new object in the no-op branch');
    assert.deepEqual(result, verdict);
  });
});

// ── classifyWithTiebreak — composed entry-point (AC: tiebreak wired in) ───────
//
// The conservative tiebreak must be applied automatically by the production
// entry-point. Callers must NOT be required to manually invoke applyConservativeTiebreak.

describe('classifyWithTiebreak — tiebreak applied automatically', () => {
  it('low-confidence story is upgraded to epic without manual tiebreak call', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'story', confidence: 'low' }));
    const result = await classifyWithTiebreak(
      'Vague brief that might touch multiple services',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(result.ok, 'classifyWithTiebreak should succeed with valid JSON');
    assert.equal(result.verdict.size, 'epic', 'low-confidence story must be epic after the composed pipeline');
  });

  it('high-confidence story is NOT upgraded — no over-sizing bias (guards against swap)', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'story', confidence: 'high' }));
    const result = await classifyWithTiebreak(
      'Add a validation rule to the existing form',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(result.ok);
    assert.equal(result.verdict.size, 'story', 'high-confidence story must remain a story');
  });

  it('medium-confidence story is NOT upgraded — tiebreak fires only on low confidence', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'chore', size: 'story', confidence: 'medium' }));
    const result = await classifyWithTiebreak(
      'Update the CI pipeline configuration',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(result.ok);
    assert.equal(result.verdict.size, 'story', 'medium-confidence story should not be auto-escalated');
  });

  it('explicit epic verdict is preserved regardless of confidence', async () => {
    const llm = new FakeLLM(verdictJson({ type: 'feature', size: 'epic', confidence: 'low' }));
    const result = await classifyWithTiebreak(
      'Large-scale platform migration',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.ok(result.ok);
    assert.equal(result.verdict.size, 'epic', 'epic verdict is preserved after tiebreak');
  });

  it('propagates classifier failure — ok: false when LLM returns invalid JSON', async () => {
    const llm = new FakeLLM('this is not json at all');
    const result = await classifyWithTiebreak(
      'Add a new endpoint',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.equal(result.ok, false, 'must propagate the failure result without applying tiebreak');
    assert.equal(result.reason, 'invalid_output');
  });

  it('propagates classifier failure — ok: false when JSON is missing required fields', async () => {
    const llm = new FakeLLM(JSON.stringify({ type: 'feature' }));
    const result = await classifyWithTiebreak(
      'Some brief',
      { llm, model: 'claude-haiku-4-5' },
    );
    assert.equal(result.ok, false, 'missing size/confidence must produce invalid_output');
    assert.equal(result.reason, 'invalid_output');
  });
});
