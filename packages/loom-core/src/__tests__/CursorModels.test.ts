import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseListModelsOutput,
  validateCursorModels,
} from '../llm/cursorModels.js';
import { PolicySchema } from '../types.js';
import type { Policy } from '../types.js';

// A captured `cursor-agent --list-models` fixture: the "Available models"
// header, a blank line, then `<id> - <Human Description>` rows.
const LIST_MODELS_FIXTURE = `Available models

auto - Auto
gpt-5.3-codex - Codex 5.3
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5
claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking
composer-2.5-fast - Composer 2.5 Fast (default)
sonnet-4 - Sonnet 4
`;

const FIXTURE_IDS = [
  'auto',
  'gpt-5.3-codex',
  'gpt-5.2',
  'composer-2.5',
  'claude-opus-4-8-thinking-high',
  'composer-2.5-fast',
  'sonnet-4',
];

function policyWith(overrides: Partial<Policy['agents']>): Policy {
  const policy = PolicySchema.parse({});
  policy.agents = { ...policy.agents, ...overrides };
  return policy;
}

describe('parseListModelsOutput', () => {
  it('extracts every model id from captured --list-models output', () => {
    assert.deepEqual(parseListModelsOutput(LIST_MODELS_FIXTURE), FIXTURE_IDS);
  });

  it('skips the header and blank lines, keeping ids only', () => {
    const ids = parseListModelsOutput(LIST_MODELS_FIXTURE);
    assert.ok(!ids.includes('Available'));
    assert.ok(!ids.includes('models'));
  });

  it('returns [] for empty stdout without throwing', () => {
    assert.deepEqual(parseListModelsOutput(''), []);
  });

  it('returns [] for garbage stdout without throwing', () => {
    const garbage = 'error: not authenticated\nplease log in\n{json: true}';
    assert.deepEqual(parseListModelsOutput(garbage), []);
  });
});

describe('validateCursorModels — backend gating', () => {
  it('returns undefined when neither backend is cursor-cli', () => {
    const policy = policyWith({ llm_backend: 'claude-cli', worker_backend: 'claude-code' });
    assert.equal(validateCursorModels(policy), undefined);
  });
});

describe('validateCursorModels — against a stubbed cursor-agent', () => {
  let tmpDir: string;
  let goodBin: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-models-'));
    const fixturePath = path.join(tmpDir, 'models.txt');
    fs.writeFileSync(fixturePath, LIST_MODELS_FIXTURE);
    // A stub that ignores its args and prints the captured fixture. This
    // exercises the execFileSync/parse path without spawning the real CLI.
    goodBin = path.join(tmpDir, 'cursor-agent-stub');
    fs.writeFileSync(goodBin, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`);
    fs.chmodSync(goodBin, 0o755);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports 'ok' when cursor_model is in the list (llm backend)", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'composer-2.5' });
    const check = validateCursorModels(policy, goodBin);
    assert.equal(check?.status, 'ok');
    assert.deepEqual(check?.invalidIds, []);
    assert.deepEqual(check?.validModels, FIXTURE_IDS);
  });

  it("reports 'ok' when only the worker backend is cursor-cli", () => {
    const policy = policyWith({
      llm_backend: 'claude-cli',
      worker_backend: 'cursor-cli',
      cursor_model: 'sonnet-4',
    });
    const check = validateCursorModels(policy, goodBin);
    assert.equal(check?.status, 'ok');
  });

  it("reports 'invalid' and names the bad id when cursor_model is absent", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'made-up-model' });
    const check = validateCursorModels(policy, goodBin);
    assert.equal(check?.status, 'invalid');
    assert.deepEqual(check?.invalidIds, ['made-up-model']);
  });

  it("'invalid' message carries the COMPLETE valid-model list (G-4)", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'made-up-model' });
    const check = validateCursorModels(policy, goodBin);
    assert.equal(check?.status, 'invalid');
    // Every model from validModels must appear in the message — not a prefix.
    for (const m of FIXTURE_IDS) {
      assert.ok(
        check!.message.includes(m),
        `expected rejection message to list "${m}"`
      );
    }
    assert.equal(check?.validModels.length, FIXTURE_IDS.length);
  });
});

describe('validateCursorModels — degraded probe (FR-8)', () => {
  it("returns 'unavailable' (never 'invalid') when the binary cannot run", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'sonnet-4' });
    const check = validateCursorModels(
      policy,
      '/nonexistent/cursor-agent-does-not-exist'
    );
    assert.equal(check?.status, 'unavailable');
    assert.notEqual(check?.status, 'invalid');
    assert.deepEqual(check?.validModels, []);
    assert.deepEqual(check?.invalidIds, []);
    assert.ok(check!.message.length > 0);
  });
});
