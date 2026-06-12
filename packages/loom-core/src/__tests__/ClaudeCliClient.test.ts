import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenMessages, parseClaudeJson, extractApiErrorStatus } from '../llm/ClaudeCliClient.js';
import type { LLMMessage } from '../llm/LLMClient.js';

describe('flattenMessages', () => {
  it('returns a single message verbatim', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'do the thing' }];
    assert.equal(flattenMessages(msgs), 'do the thing');
  });

  it('flattens a multi-turn conversation into one prompt', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'bad answer' },
      { role: 'user', content: 'try again' },
    ];
    const flat = flattenMessages(msgs);
    assert.ok(flat.includes('first ask'));
    assert.ok(flat.includes('bad answer'));
    assert.ok(flat.includes('try again'));
    // The assistant turn is framed as a prior response.
    assert.ok(flat.includes('previous response'));
  });
});

describe('parseClaudeJson', () => {
  it('extracts text from the result field of JSON output', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: '# A Document\n\nbody',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const r = parseClaudeJson(stdout, 'claude-sonnet-4-6');
    assert.equal(r.text, '# A Document\n\nbody');
    assert.equal(r.usage.inputTokens, 100);
    assert.equal(r.usage.outputTokens, 50);
    assert.equal(r.model, 'claude-sonnet-4-6');
  });

  it('falls back to the text field when result is absent', () => {
    const r = parseClaudeJson(JSON.stringify({ text: 'hello' }), 'm');
    assert.equal(r.text, 'hello');
  });

  it('treats non-JSON stdout as the raw response text', () => {
    const r = parseClaudeJson('just some plain text output', 'm');
    assert.equal(r.text, 'just some plain text output');
  });

  it('defaults usage to zero when the JSON omits it', () => {
    const r = parseClaudeJson(JSON.stringify({ result: 'x' }), 'm');
    assert.equal(r.usage.inputTokens, 0);
    assert.equal(r.usage.outputTokens, 0);
  });

  it('reads prompt-cache usage fields when present', () => {
    const stdout = JSON.stringify({
      result: 'x',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 30,
      },
    });
    const r = parseClaudeJson(stdout, 'm');
    assert.equal(r.usage.cacheReadTokens, 200);
    assert.equal(r.usage.cacheCreationTokens, 30);
  });
});

describe('extractApiErrorStatus', () => {
  it('returns the api_error_status from a claude-cli error JSON', () => {
    const errOutput = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 529,
      result: 'API Error: 529 Overloaded.',
    });
    assert.equal(extractApiErrorStatus(errOutput), 529);
  });

  it('returns undefined when the output is not JSON', () => {
    assert.equal(extractApiErrorStatus('plain stderr garbage'), undefined);
  });

  it('returns undefined when api_error_status is missing', () => {
    assert.equal(extractApiErrorStatus(JSON.stringify({ result: 'ok' })), undefined);
  });

  it('returns undefined when api_error_status is non-numeric', () => {
    assert.equal(
      extractApiErrorStatus(JSON.stringify({ api_error_status: 'oops' })),
      undefined
    );
  });
});
