import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCursorModels } from '../cursorModels.js';
import { PolicySchema } from '../../types.js';
import type { Policy } from '../../types.js';

/**
 * Contract for the three-tier alias rule (epic-007 FR-1/FR-2, story-007-001).
 * These tests ARE the contract for the three call sites — a consumer that
 * switches only on `status` silently misses the advisory, so we assert on the
 * returned SHAPE here, never on console output.
 *
 * Every case stubs `cursor-agent --list-models`: the stub ignores its args and
 * prints a captured fixture, exercising the execFileSync/parse path without
 * ever spawning the real CLI.
 */

// A list that contains a single decorated expansion of `claude-opus-4-8`.
// The trailing `-high` is what makes the boundary rule load-bearing: a
// configured `claude-opus-4` must NOT alias `claude-opus-4-8-high`.
const LIST_MODELS_FIXTURE = `Available models

auto - Auto
sonnet-4 - Sonnet 4
claude-opus-4-8 - Opus 4.8
claude-opus-4-8-high - Opus 4.8 High
`;

const FIXTURE_IDS = ['auto', 'sonnet-4', 'claude-opus-4-8', 'claude-opus-4-8-high'];

function policyWith(overrides: Partial<Policy['agents']>): Policy {
  const policy = PolicySchema.parse({});
  policy.agents = { ...policy.agents, ...overrides };
  return policy;
}

function writeStub(tmpDir: string, name: string, fixture: string): string {
  const fixturePath = path.join(tmpDir, `${name}.txt`);
  fs.writeFileSync(fixturePath, fixture);
  const bin = path.join(tmpDir, name);
  fs.writeFileSync(bin, `#!/bin/sh\ncat ${JSON.stringify(fixturePath)}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

describe('validateCursorModels — three-tier alias rule (story-007-001)', () => {
  let tmpDir: string;
  let bin: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-alias-'));
    bin = writeStub(tmpDir, 'cursor-agent-stub', LIST_MODELS_FIXTURE);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Case 1 — exact match → silent 'ok', advisory falsy, empty message.
  it("exact match returns {status:'ok', message:''} with no advisory", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'claude-opus-4-8' });
    const check = validateCursorModels(policy, bin);
    assert.equal(check?.status, 'ok');
    assert.equal(check?.message, '');
    assert.ok(!check?.advisory);
    assert.deepEqual(check?.invalidIds, []);
  });

  // Case 2 — boundary-prefix alias → 'ok' + advisory recommending the suffixed id.
  it("alias 'claude-opus-4-8' against a list with 'claude-opus-4-8-high' is ok+advisory", () => {
    const policy = policyWith({
      llm_backend: 'cursor-cli',
      cursor_model: 'claude-opus-4-8',
    });
    // Restrict the stub to a list where the exact id is absent but a
    // `-`-boundary expansion exists, forcing the alias tier.
    const aliasBin = writeStub(
      tmpDir,
      'cursor-agent-alias',
      'Available models\n\nclaude-opus-4-8-high - Opus 4.8 High\n'
    );
    const check = validateCursorModels(policy, aliasBin);
    assert.equal(check?.status, 'ok');
    assert.equal(check?.advisory, true);
    assert.deepEqual(check?.invalidIds, []);
    assert.ok(check!.message.includes('claude-opus-4-8'), 'names the configured id');
    assert.ok(
      check!.message.includes('claude-opus-4-8-high'),
      'recommends the explicit suffixed id'
    );
  });

  // Case 3 — boundary guard: 'claude-opus-4' must NOT alias 'claude-opus-4-8-high'.
  it("'claude-opus-4' against ONLY 'claude-opus-4-8-high' is invalid, not a false alias", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'claude-opus-4' });
    const guardBin = writeStub(
      tmpDir,
      'cursor-agent-guard',
      'Available models\n\nclaude-opus-4-8-high - Opus 4.8 High\n'
    );
    const check = validateCursorModels(policy, guardBin);
    assert.notEqual(check?.status, 'ok');
    assert.equal(check?.status, 'invalid');
    assert.ok(!check?.advisory);
  });

  // Case 4 — shortest-alias selection among multiple single-token matches.
  it('picks and recommends the SHORTEST listed alias when several match', () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'claude-opus-4-8' });
    // Two single-token expansions ('-thinking' and '-fast'); the shorter
    // ('-fast') must win. Order them longer-first to prove selection is by
    // length, not by list position. A two-token id ('-thinking-high') is
    // present to confirm it never participates (more than one added token).
    const multiBin = writeStub(
      tmpDir,
      'cursor-agent-multi',
      'Available models\n\n' +
        'claude-opus-4-8-thinking-high - Opus 4.8 Thinking High\n' +
        'claude-opus-4-8-thinking - Opus 4.8 Thinking\n' +
        'claude-opus-4-8-fast - Opus 4.8 Fast\n'
    );
    const check = validateCursorModels(policy, multiBin);
    assert.equal(check?.status, 'ok');
    assert.equal(check?.advisory, true);
    assert.ok(
      check!.message.includes('claude-opus-4-8-fast'),
      'recommends the shortest single-token alias'
    );
    assert.ok(
      !check!.message.includes('claude-opus-4-8-thinking-high'),
      'never recommends a multi-token expansion'
    );
  });

  // Case 5 — bogus id → 'invalid' with the COMPLETE valid-model list populated.
  it("a genuinely bogus id returns 'invalid' with the full validModels list", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'made-up-model' });
    const check = validateCursorModels(policy, bin);
    assert.equal(check?.status, 'invalid');
    assert.ok(!check?.advisory);
    assert.deepEqual(check?.invalidIds, ['made-up-model']);
    assert.deepEqual(check?.validModels, FIXTURE_IDS);
    for (const m of FIXTURE_IDS) {
      assert.ok(check!.message.includes(m), `expected message to list "${m}"`);
    }
  });

  // Case 6 — degraded probe → 'unavailable', unchanged, no advisory.
  it("returns 'unavailable' (no advisory) when the probe cannot run", () => {
    const policy = policyWith({ llm_backend: 'cursor-cli', cursor_model: 'claude-opus-4-8' });
    const check = validateCursorModels(policy, '/nonexistent/cursor-agent-missing');
    assert.equal(check?.status, 'unavailable');
    assert.ok(!check?.advisory);
    assert.deepEqual(check?.validModels, []);
    assert.deepEqual(check?.invalidIds, []);
    assert.ok(check!.message.length > 0);
  });
});
