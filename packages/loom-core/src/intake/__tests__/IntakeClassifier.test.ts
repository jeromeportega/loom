/**
 * Tests for the JSON recovery path and timeout behaviour added in story-023-001.
 * The base schema tests and basic happy/failure paths live in
 * src/__tests__/IntakeClassifier.test.ts; this file covers:
 *   1. Realistic non-pure-JSON responses that recoverJsonText must unwrap.
 *   2. The new 120 s default timeout.
 *   3. The assistant prefill is included in the LLM request.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient, LLMRequest, LLMResponse } from '../../llm/LLMClient.js';
import {
  classifyIntake,
  type ClassifyResult,
} from '../IntakeClassifier.js';

// ── helpers ─────────────────────────────────────────────────────────────────

const VALID_VERDICT = {
  type: 'feature' as const,
  size: 'story' as const,
  confidence: 'high' as const,
  rationale: 'New capability requested by users.',
};

const VALID_JSON = JSON.stringify(VALID_VERDICT);

class FakeLLM implements LLMClient {
  readonly calls: LLMRequest[] = [];
  private queue: Array<string | Error | 'hang'>;

  constructor(responses: Array<string | Error | 'hang'>) {
    this.queue = [...responses];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeLLM: no more scripted responses');
    if (next === 'hang') return new Promise<never>(() => { /* never resolves */ });
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

function assertOk(result: ClassifyResult): asserts result is { ok: true; verdict: typeof VALID_VERDICT } {
  assert.equal(result.ok, true, `Expected ok=true but got: ${JSON.stringify(result)}`);
}

function assertFailure(result: ClassifyResult, reason: 'llm_error' | 'timeout' | 'invalid_output'): void {
  assert.equal(result.ok, false, `Expected ok=false, got ok=${result.ok}`);
  if (!result.ok) {
    assert.equal(result.reason, reason, `Expected reason="${reason}", got "${result.reason}"`);
  }
}

// ── JSON recovery — realistic non-pure-JSON responses ────────────────────────

describe('classifyIntake — JSON recovery from non-pure responses', () => {
  it('recovers JSON wrapped in a markdown ```json fence', async () => {
    const fenced = '```json\n' + VALID_JSON + '\n```';
    const llm = new FakeLLM([fenced]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('recovers JSON wrapped in a plain ``` fence (no language tag)', async () => {
    const fenced = '```\n' + VALID_JSON + '\n```';
    const llm = new FakeLLM([fenced]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('recovers JSON preceded by a prose preamble', async () => {
    const prose = 'Sure! Here is the classification:\n\n' + VALID_JSON;
    const llm = new FakeLLM([prose]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('recovers JSON followed by a prose suffix', async () => {
    const prose = VALID_JSON + '\n\nI hope this helps!';
    const llm = new FakeLLM([prose]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('recovers JSON both preceded and followed by prose', async () => {
    const prose = 'My analysis:\n' + VALID_JSON + '\nLet me know if you need more detail.';
    const llm = new FakeLLM([prose]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('recovers a continuation response (model continued from assistant prefill \'{\')', async () => {
    // Simulates what the real API returns when the assistant prefill is '{':
    // the response text is everything AFTER the opening brace.
    const continuation =
      '"type": "feature", "size": "story", "confidence": "high", ' +
      '"rationale": "New capability requested by users."}';
    const llm = new FakeLLM([continuation]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertOk(result);
    assert.deepEqual(result.verdict, VALID_VERDICT);
  });

  it('degrades to invalid_output when fenced content is not valid JSON', async () => {
    const bad = '```json\nnot valid json here\n```';
    const llm = new FakeLLM([bad]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertFailure(result, 'invalid_output');
  });

  it('degrades to invalid_output when prose contains no JSON object', async () => {
    const bad = 'I cannot classify this brief without more context.';
    const llm = new FakeLLM([bad]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertFailure(result, 'invalid_output');
  });

  it('degrades to invalid_output when the extracted JSON fails schema validation', async () => {
    const prose = 'Here you go:\n' + JSON.stringify({ type: 'request', size: 'story', confidence: 'high', rationale: 'x' });
    const llm = new FakeLLM([prose]);
    const result = await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    assertFailure(result, 'invalid_output');
  });
});

// ── default timeout ──────────────────────────────────────────────────────────

describe('classifyIntake — default timeout is 120 000 ms', () => {
  it('does not time out before 120 000 ms (hangs until clock advances past it)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const llm = new FakeLLM(['hang']);
    const resultPromise = classifyIntake('brief', { llm, model: 'haiku' }); // no timeoutMs
    t.mock.timers.tick(120_001);
    const result = await resultPromise;
    assertFailure(result, 'timeout');
    assert.ok(
      result.ok === false && result.detail.includes('120000ms'),
      `Expected detail to mention 120000ms, got: "${!result.ok && result.detail}"`,
    );
  });
});

// ── assistant prefill in LLM request ────────────────────────────────────────

describe('classifyIntake — request shape', () => {
  it('includes an assistant prefill message opening the JSON object', async () => {
    const llm = new FakeLLM([VALID_JSON]);
    await classifyIntake('brief', { llm, model: 'haiku', timeoutMs: 5000 });
    const req = llm.calls[0];
    const lastMsg = req.messages[req.messages.length - 1];
    assert.equal(lastMsg.role, 'assistant', 'Last message should be the assistant prefill');
    assert.equal(lastMsg.content, '{', 'Assistant prefill should open the JSON object');
  });

  it('includes the user brief as a user message', async () => {
    const llm = new FakeLLM([VALID_JSON]);
    await classifyIntake('Add OAuth login to the app', { llm, model: 'haiku', timeoutMs: 5000 });
    const req = llm.calls[0];
    const userMsg = req.messages.find(m => m.role === 'user');
    assert.ok(userMsg, 'Should have a user message');
    assert.equal(userMsg.content, 'Add OAuth login to the app');
  });
});
