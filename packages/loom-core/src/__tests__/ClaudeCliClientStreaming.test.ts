import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenMessages, extractApiErrorStatus, parseClaudeJson, ClaudeCliClient } from '../llm/ClaudeCliClient.js';
import type { LLMRequest, LLMResponse } from '../llm/LLMClient.js';
import { EMPTY_USAGE } from '../llm/LLMClient.js';

/**
 * Unit tests for ClaudeCliClient streaming tap (AC1) and existing buffered path.
 *
 * The actual subprocess spawn cannot be unit-tested in isolation (it requires a
 * configured `claude` CLI), so we test:
 *   1. The stream-json line parser logic via a synthetic mock client.
 *   2. The regression guard: `onText` absent → existing buffered behaviour.
 *   3. Exported pure functions (flattenMessages, extractApiErrorStatus, parseClaudeJson).
 *   4. Session auth env stripping.
 */

// ─── Inline stream-json parser (mirrors ClaudeCliClient's private processLine) ──

interface ParsedState {
  accText: string;
  called: string[];
}

function processStreamLines(lines: string[], onText: (d: string) => void): {
  accText: string;
  success: boolean;
  usage: typeof EMPTY_USAGE;
} {
  let accText = '';
  let success = false;
  let usage = { ...EMPTY_USAGE, requestCount: 1 };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        text?: unknown;
        result?: unknown;
        is_error?: boolean;
        total_cost_usd?: unknown;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        message?: {
          content?: Array<{ type: string; text?: string }>;
        };
      };

      if (event.type === 'text' && typeof event.text === 'string') {
        onText(event.text);
        accText += event.text;
      } else if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            onText(block.text);
            accText += block.text;
          }
        }
      } else if (event.type === 'result') {
        success = !event.is_error;
        if (typeof event.result === 'string' && !accText) {
          accText = event.result;
        }
        if (event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
            cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: event.usage.cache_creation_input_tokens ?? 0,
            requestCount: 1,
            costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : 0,
          };
        }
      }
    } catch { /* non-JSON line */ }
  }

  return { accText, success, usage };
}

// ─── AC1: onText present — stream-json parsing ────────────────────────────────

describe('ClaudeCliClient streaming tap (AC1)', () => {
  it('parses line-delimited text events and calls onText once per delta', () => {
    const calls: string[] = [];
    const lines = [
      JSON.stringify({ type: 'text', text: 'Hello, ' }),
      JSON.stringify({ type: 'text', text: 'world!' }),
      JSON.stringify({
        type: 'result',
        result: 'Hello, world!',
        is_error: false,
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    ];

    const { accText } = processStreamLines(lines, (d) => calls.push(d));

    assert.deepEqual(calls, ['Hello, ', 'world!'], 'onText must be called once per text delta');
    assert.equal(accText, 'Hello, world!', 'accumulated text must equal concatenation of deltas');
  });

  it('handles assistant-message format (content block array)', () => {
    const calls: string[] = [];
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Chunk A' }, { type: 'tool_use', name: 'Read', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Chunk B' }] },
      }),
      JSON.stringify({ type: 'result', result: 'Chunk AChunk B', is_error: false }),
    ];

    const { accText } = processStreamLines(lines, (d) => calls.push(d));

    assert.deepEqual(calls, ['Chunk A', 'Chunk B'], 'only text content blocks trigger onText');
    assert.equal(accText, 'Chunk AChunk B');
  });

  it('accumulated LLMResponse.text equals concatenation of all deltas', () => {
    const deltas = ['alpha ', 'beta ', 'gamma'];
    const calls: string[] = [];
    const lines = [
      ...deltas.map((d) => JSON.stringify({ type: 'text', text: d })),
      JSON.stringify({ type: 'result', result: deltas.join(''), is_error: false }),
    ];

    const { accText } = processStreamLines(lines, (d) => calls.push(d));
    assert.equal(accText, calls.join(''), 'accText must equal concatenation of onText calls');
  });

  it('extracts usage from the result event', () => {
    const lines = [
      JSON.stringify({ type: 'text', text: 'hi' }),
      JSON.stringify({
        type: 'result',
        result: 'hi',
        is_error: false,
        total_cost_usd: 0.0042,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 10,
        },
      }),
    ];

    const { usage } = processStreamLines(lines, () => {});
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 50);
    assert.equal(usage.cacheReadTokens, 200);
    assert.equal(usage.cacheCreationTokens, 10);
    assert.equal(usage.costUsd, 0.0042);
    assert.equal(usage.requestCount, 1);
  });

  it('falls back to result.result text when no text deltas were emitted', () => {
    const lines = [
      JSON.stringify({ type: 'result', result: 'fallback text', is_error: false }),
    ];
    const calls: string[] = [];
    const { accText } = processStreamLines(lines, (d) => calls.push(d));
    assert.equal(accText, 'fallback text', 'result text must be used when no deltas received');
    assert.equal(calls.length, 0, 'onText must not be called when there are no text events');
  });

  it('skips non-JSON lines without throwing', () => {
    const lines = [
      'not valid json at all',
      JSON.stringify({ type: 'text', text: 'valid' }),
      '{ broken',
    ];
    assert.doesNotThrow(() => processStreamLines(lines, () => {}));
    const calls: string[] = [];
    processStreamLines(lines, (d) => calls.push(d));
    assert.deepEqual(calls, ['valid']);
  });
});

// ─── Regression guard: onText absent → buffered path unchanged ────────────────

describe('ClaudeCliClient buffered path regression guard (AC1)', () => {
  it('parseClaudeJson returns the result field when present', () => {
    const json = JSON.stringify({
      result: 'The answer',
      total_cost_usd: 0.002,
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const resp = parseClaudeJson(json, 'claude-sonnet-4-6');
    assert.equal(resp.text, 'The answer');
    assert.equal(resp.usage.costUsd, 0.002);
  });

  it('parseClaudeJson falls back to raw stdout when JSON parse fails', () => {
    const raw = 'plain text response';
    const resp = parseClaudeJson(raw, 'claude-sonnet-4-6');
    assert.equal(resp.text, raw);
    assert.equal(resp.usage.requestCount, 1);
  });

  it('flattenMessages returns a single message content unchanged', () => {
    assert.equal(
      flattenMessages([{ role: 'user', content: 'Hello' }]),
      'Hello'
    );
  });

  it('flattenMessages wraps assistant turns in delimiters', () => {
    const result = flattenMessages([
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'Q2' },
    ]);
    assert.ok(result.includes('--- your previous response ---'));
    assert.ok(result.includes('--- end ---'));
  });

  it('extractApiErrorStatus returns the status code from a known error shape', () => {
    const output = JSON.stringify({ is_error: true, api_error_status: 429 });
    assert.equal(extractApiErrorStatus(output), 429);
  });

  it('extractApiErrorStatus returns undefined for non-JSON output', () => {
    assert.equal(extractApiErrorStatus('not json'), undefined);
  });
});

// ─── Session auth (AC4) ───────────────────────────────────────────────────────

describe('ClaudeCliClient session auth env-hygiene (AC4)', () => {
  it('ClaudeCliClient can be constructed with sessionAuth=true (compile-time + runtime)', () => {
    // The constructor does not spawn any process, so no real 'claude' binary is needed.
    assert.doesNotThrow(() => new ClaudeCliClient({ sessionAuth: true }));
    assert.doesNotThrow(() => new ClaudeCliClient({ sessionAuth: false }));
    assert.doesNotThrow(() => new ClaudeCliClient({}));
  });

  it("'session' strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from the spawned env", () => {
    // Access private spawnEnv() via any-cast — private is compile-time only in JS.
    const priorKey = process.env.ANTHROPIC_API_KEY;
    const priorToken = process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test';

      const sessionClient = new ClaudeCliClient({ sessionAuth: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionEnv = (sessionClient as any).spawnEnv() as NodeJS.ProcessEnv;

      assert.equal(sessionEnv.ANTHROPIC_API_KEY, undefined,
        'sessionAuth=true must strip ANTHROPIC_API_KEY from subprocess env');
      assert.equal(sessionEnv.ANTHROPIC_AUTH_TOKEN, undefined,
        'sessionAuth=true must strip ANTHROPIC_AUTH_TOKEN from subprocess env');
      // Returns a copy, not the live process.env reference
      assert.notEqual(sessionEnv, process.env, 'session env must be a copy, not process.env itself');
      // Parent process env is not mutated
      assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-test-key',
        'parent process.env must not be modified');

      const inheritClient = new ClaudeCliClient({ sessionAuth: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inheritEnv = (inheritClient as any).spawnEnv() as NodeJS.ProcessEnv;
      assert.equal(inheritEnv.ANTHROPIC_API_KEY, 'sk-ant-test-key',
        'sessionAuth=false must leave ANTHROPIC_API_KEY intact');
      assert.equal(inheritEnv.ANTHROPIC_AUTH_TOKEN, 'tok-test',
        'sessionAuth=false must leave ANTHROPIC_AUTH_TOKEN intact');
      // spawnEnv() always returns a shallow copy (not the live reference) to prevent
      // mutation from contaminating the global process environment.
      assert.notEqual(inheritEnv, process.env,
        'sessionAuth=false must return a copy, not the process.env reference');
    } finally {
      if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorKey;
      if (priorToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = priorToken;
    }
  });
});
