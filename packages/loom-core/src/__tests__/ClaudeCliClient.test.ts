import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenMessages,
  parseClaudeJson,
  extractApiErrorStatus,
  buildBufferedArgs,
  NON_AGENTIC_TOOLS_DISABLE_ARGS,
} from '../llm/ClaudeCliClient.js';
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

// ─── buildBufferedArgs argv contract ─────────────────────────────────────────

describe('buildBufferedArgs', () => {
  it('default agentic (undefined): uses --append-system-prompt, no --system-prompt, no tools-disable (AC4)', () => {
    const args = buildBufferedArgs('m', 'SYS', undefined);
    const apIdx = args.indexOf('--append-system-prompt');
    assert.ok(apIdx !== -1, 'must contain --append-system-prompt');
    assert.equal(args[apIdx + 1], 'SYS', '--append-system-prompt value must be SYS');
    assert.ok(!args.includes('--system-prompt'), 'must NOT contain --system-prompt');
    for (const tok of NON_AGENTIC_TOOLS_DISABLE_ARGS) {
      assert.ok(!args.includes(tok), `must NOT contain tools-disable token "${tok}"`);
    }
  });

  it('non-agentic (excludeDynamicSections: true): uses --system-prompt, tools-disable, no --append-system-prompt (AC2)', () => {
    const args = buildBufferedArgs('m', 'SYS', { excludeDynamicSections: true });
    const spIdx = args.indexOf('--system-prompt');
    assert.ok(spIdx !== -1, 'must contain --system-prompt');
    assert.equal(args[spIdx + 1], 'SYS', '--system-prompt value must be SYS');
    assert.ok(!args.includes('--append-system-prompt'), 'must NOT contain --append-system-prompt');
    for (const tok of NON_AGENTIC_TOOLS_DISABLE_ARGS) {
      assert.ok(args.includes(tok), `must contain tools-disable token "${tok}"`);
    }
  });

  it('retention opt-out (excludeDynamicSections: false): still non-agentic shape, no --append-system-prompt (AC3)', () => {
    const args = buildBufferedArgs('m', 'SYS', { excludeDynamicSections: false });
    assert.ok(args.includes('--system-prompt'), 'must contain --system-prompt');
    assert.ok(!args.includes('--append-system-prompt'), 'must NOT contain --append-system-prompt');
    for (const tok of NON_AGENTIC_TOOLS_DISABLE_ARGS) {
      assert.ok(args.includes(tok), `must contain tools-disable token "${tok}"`);
    }
  });

  it('boundary — empty systemText: neither prompt flag added in agentic or non-agentic mode', () => {
    const agentArgs = buildBufferedArgs('m', '', undefined);
    assert.ok(!agentArgs.includes('--append-system-prompt'), 'agentic: no --append-system-prompt for empty text');
    assert.ok(!agentArgs.includes('--system-prompt'), 'agentic: no --system-prompt for empty text');

    const nonAgentArgs = buildBufferedArgs('m', '', { excludeDynamicSections: true });
    assert.ok(!nonAgentArgs.includes('--system-prompt'), 'non-agentic: no --system-prompt for empty text');
    assert.ok(!nonAgentArgs.includes('--append-system-prompt'), 'non-agentic: no --append-system-prompt for empty text');
  });

  it('includes -p, --model, and --output-format json in both modes', () => {
    const agentArgs = buildBufferedArgs('claude-sonnet-4-6', 'sys', undefined);
    assert.ok(agentArgs.includes('-p'));
    assert.equal(agentArgs[agentArgs.indexOf('--model') + 1], 'claude-sonnet-4-6');
    assert.equal(agentArgs[agentArgs.indexOf('--output-format') + 1], 'json');

    const nonAgentArgs = buildBufferedArgs('claude-sonnet-4-6', 'sys', { excludeDynamicSections: true });
    assert.ok(nonAgentArgs.includes('-p'));
    assert.equal(nonAgentArgs[nonAgentArgs.indexOf('--model') + 1], 'claude-sonnet-4-6');
    assert.equal(nonAgentArgs[nonAgentArgs.indexOf('--output-format') + 1], 'json');
  });
});
