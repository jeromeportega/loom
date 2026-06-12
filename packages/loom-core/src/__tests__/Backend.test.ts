import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCursorJson } from '../llm/CursorCliClient.js';
import { CursorCliClient } from '../llm/CursorCliClient.js';
import { ClaudeCliClient } from '../llm/ClaudeCliClient.js';
import { createLLMClient, modelFor } from '../llm/factory.js';
import { createWorker } from '../orchestrator/workerFactory.js';
import { ClaudeCodeWorker } from '../orchestrator/ClaudeCodeWorker.js';
import { CursorAgentWorker } from '../orchestrator/CursorAgentWorker.js';
import { PolicySchema } from '../types.js';

// ─── parseCursorJson ────────────────────────────────────────────────────────

describe('parseCursorJson', () => {
  it('extracts text from the result field', () => {
    const r = parseCursorJson(JSON.stringify({ result: '# Doc\n\nbody' }), 'sonnet-4');
    assert.equal(r.text, '# Doc\n\nbody');
    assert.equal(r.model, 'sonnet-4');
  });

  it('falls back through alternate field names', () => {
    assert.equal(parseCursorJson(JSON.stringify({ text: 'a' }), 'm').text, 'a');
    assert.equal(parseCursorJson(JSON.stringify({ response: 'b' }), 'm').text, 'b');
    assert.equal(parseCursorJson(JSON.stringify({ content: 'c' }), 'm').text, 'c');
  });

  it('treats non-JSON stdout as the raw response', () => {
    assert.equal(parseCursorJson('plain text output', 'm').text, 'plain text output');
  });
});

// ─── createLLMClient — backend selection ────────────────────────────────────

describe('createLLMClient', () => {
  it('returns a ClaudeCliClient for the claude-cli backend', () => {
    assert.ok(createLLMClient('claude-cli') instanceof ClaudeCliClient);
  });

  it('returns a CursorCliClient for the cursor-cli backend', () => {
    assert.ok(createLLMClient('cursor-cli') instanceof CursorCliClient);
  });

  it('defaults to the session-based claude-cli backend', () => {
    assert.ok(createLLMClient() instanceof ClaudeCliClient);
  });
});

// ─── createWorker — worker backend selection ────────────────────────────────

describe('createWorker', () => {
  it('returns a ClaudeCodeWorker for the claude-code backend', () => {
    const w = createWorker({ backend: 'claude-code', allowedRemotes: [] });
    assert.ok(w instanceof ClaudeCodeWorker);
  });

  it('returns a CursorAgentWorker for the cursor-cli backend', () => {
    const w = createWorker({ backend: 'cursor-cli', allowedRemotes: [], cursorModel: 'sonnet-4' });
    assert.ok(w instanceof CursorAgentWorker);
  });
});

// ─── modelFor — backend-aware model id resolution ───────────────────────────

describe('modelFor', () => {
  it('uses role-specific Claude model ids for the claude-cli backend', () => {
    const policy = PolicySchema.parse({});
    // Planning defaults to Opus (deeper reasoning), skill-gen to Haiku (cheap).
    assert.equal(modelFor(policy, 'planning'), 'claude-opus-4-7');
    assert.equal(modelFor(policy, 'skill_gen'), 'claude-haiku-4-5-20251001');
  });

  it('uses the cursor_model for every role when the backend is cursor-cli', () => {
    const policy = PolicySchema.parse({ agents: { llm_backend: 'cursor-cli' } });
    assert.equal(modelFor(policy, 'planning'), 'sonnet-4');
    assert.equal(modelFor(policy, 'skill_gen'), 'sonnet-4');
  });
});

// ─── CursorCliClient / CursorAgentWorker — construction ─────────────────────

describe('Cursor backend construction', () => {
  it('CursorCliClient is constructible without an API key', () => {
    assert.doesNotThrow(() => new CursorCliClient());
  });

  it('CursorAgentWorker is constructible and is a WorkerRunner', () => {
    const worker = new CursorAgentWorker({ model: 'sonnet-4', allowedRemotes: [] });
    assert.equal(typeof worker.run, 'function');
  });
});
