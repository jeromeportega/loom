/**
 * Tests for the adversarial_review_model policy knob (story-082-001).
 *
 * Verifies the optional string field, schema YAML presence, and type safety.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PolicySchema } from '../types.js';
import { ZodError } from 'zod';

// At runtime, __dirname is dist/__tests__/. The repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ─── Parse cases ─────────────────────────────────────────────────────────────

describe('adversarial_review_model — optional field (absent is valid)', () => {
  it('succeeds when agents block is empty', () => {
    assert.doesNotThrow(() => PolicySchema.parse({ agents: {} }));
  });

  it('result.agents.adversarial_review_model is undefined when absent', () => {
    const result = PolicySchema.parse({ agents: {} });
    assert.strictEqual(result.agents.adversarial_review_model, undefined);
  });

  it('succeeds when agents block is entirely omitted', () => {
    assert.doesNotThrow(() => PolicySchema.parse({}));
  });
});

describe('adversarial_review_model — valid string accepted', () => {
  it('accepts a model id string and round-trips it', () => {
    const result = PolicySchema.parse({
      agents: { adversarial_review_model: 'claude-opus-4-8' },
    });
    assert.strictEqual(result.agents.adversarial_review_model, 'claude-opus-4-8');
  });

  it('accepts any arbitrary string value', () => {
    const result = PolicySchema.parse({
      agents: { adversarial_review_model: 'some-custom-model-id' },
    });
    assert.strictEqual(result.agents.adversarial_review_model, 'some-custom-model-id');
  });
});

describe('adversarial_review_model — non-string rejected', () => {
  it('rejects numeric 42 with a ZodError', () => {
    assert.throws(
      () => PolicySchema.parse({ agents: { adversarial_review_model: 42 } }),
      (err: unknown) => err instanceof ZodError
    );
  });

  it('rejects boolean true with a ZodError', () => {
    assert.throws(
      () => PolicySchema.parse({ agents: { adversarial_review_model: true } }),
      (err: unknown) => err instanceof ZodError
    );
  });

  it('rejects an object with a ZodError', () => {
    assert.throws(
      () => PolicySchema.parse({ agents: { adversarial_review_model: {} } }),
      (err: unknown) => err instanceof ZodError
    );
  });
});

// ─── Schema YAML assertions ───────────────────────────────────────────────────

describe('adversarial_review_model — policy.schema.yaml content', () => {
  const schemaText = readFileSync(
    path.join(REPO_ROOT, 'schemas', 'policy.schema.yaml'),
    'utf8'
  );

  it('schema contains adversarial_review_model key inside agents block', () => {
    const agentsIdx = schemaText.indexOf('agents:');
    assert.ok(agentsIdx !== -1, 'agents block must exist in schema');
    const afterAgents = schemaText.slice(agentsIdx);
    assert.ok(
      afterAgents.includes('adversarial_review_model:'),
      'schema must contain adversarial_review_model inside agents block'
    );
  });

  it('schema entry has a non-empty description', () => {
    const keyIdx = schemaText.indexOf('adversarial_review_model:');
    assert.ok(keyIdx !== -1, 'adversarial_review_model must exist in schema');
    const surrounding = schemaText.slice(keyIdx, keyIdx + 400);
    assert.ok(
      surrounding.includes('description:'),
      'adversarial_review_model must have a description in the schema'
    );
  });

  it('schema entry has type: string', () => {
    const keyIdx = schemaText.indexOf('adversarial_review_model:');
    assert.ok(keyIdx !== -1);
    const surrounding = schemaText.slice(keyIdx, keyIdx + 200);
    assert.ok(
      surrounding.includes('type: string'),
      'adversarial_review_model must have type: string in the schema'
    );
  });

  it('schema entry has no default: value', () => {
    const keyIdx = schemaText.indexOf('adversarial_review_model:');
    assert.ok(keyIdx !== -1);
    // Bound the search to the field definition only — find the next property
    // at the same indentation level (6-space indent = agents property sibling).
    const afterKey = schemaText.slice(keyIdx + 'adversarial_review_model:'.length);
    const nextSiblingMatch = afterKey.match(/\n      \S/);
    const fieldBlock = nextSiblingMatch
      ? afterKey.slice(0, nextSiblingMatch.index!)
      : afterKey.slice(0, 300);
    assert.ok(
      !fieldBlock.includes('default:'),
      'adversarial_review_model must not have a default value in the schema'
    );
  });
});
