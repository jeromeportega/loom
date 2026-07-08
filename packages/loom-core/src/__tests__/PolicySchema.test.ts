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

// ─── skill_judge_min_score ────────────────────────────────────────────────────

describe('skill_judge_min_score — optional number field', () => {
  it('accepts a numeric value and round-trips it', () => {
    const result = PolicySchema.parse({ agents: { skill_judge_min_score: 0.9 } });
    assert.strictEqual(result.agents.skill_judge_min_score, 0.9);
  });

  it('is undefined when absent (no default)', () => {
    const result = PolicySchema.parse({ agents: {} });
    assert.strictEqual(result.agents.skill_judge_min_score, undefined);
  });

  it('rejects a string value with a ZodError', () => {
    assert.throws(
      () => PolicySchema.parse({ agents: { skill_judge_min_score: 'high' } }),
      (err: unknown) => err instanceof ZodError
    );
  });
});

// ─── prune_orphan_worktrees ───────────────────────────────────────────────────

describe('prune_orphan_worktrees — enum field with default', () => {
  it('accepts "off" and round-trips it', () => {
    const result = PolicySchema.parse({ agents: { prune_orphan_worktrees: 'off' } });
    assert.strictEqual(result.agents.prune_orphan_worktrees, 'off');
  });

  it('accepts "on" and round-trips it', () => {
    const result = PolicySchema.parse({ agents: { prune_orphan_worktrees: 'on' } });
    assert.strictEqual(result.agents.prune_orphan_worktrees, 'on');
  });

  it('defaults to "on" when absent', () => {
    const result = PolicySchema.parse({ agents: {} });
    assert.strictEqual(result.agents.prune_orphan_worktrees, 'on');
  });

  it('rejects an invalid enum value "maybe" with a ZodError', () => {
    assert.throws(
      () => PolicySchema.parse({ agents: { prune_orphan_worktrees: 'maybe' } }),
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

// ─── Five removed fields: silent strip contract (story-084-004) ──────────────
//
// The five fields removed by story-084-001 (worktree_isolation, require_human_pr_merge,
// skill_promote_after, skill_demote_failure_ratio, skill_demote_min_samples) must
// be silently stripped by Zod's default (non-strict) object parsing — no error,
// no presence on the parsed result, and no corruption of other fields' defaults.

describe('PolicySchema — five removed fields are silently stripped (story-084-004)', () => {
  const REMOVED_FIELDS = [
    'worktree_isolation',
    'require_human_pr_merge',
    'skill_promote_after',
    'skill_demote_failure_ratio',
    'skill_demote_min_samples',
  ] as const;

  const INPUT_WITH_REMOVED_FIELDS = {
    agents: {
      worktree_isolation: true,
      require_human_pr_merge: true,
      skill_promote_after: 3,
      skill_demote_failure_ratio: 0.5,
      skill_demote_min_samples: 3,
    },
  };

  it('parses without throwing even when all five removed fields are present', () => {
    assert.doesNotThrow(
      () => PolicySchema.parse(INPUT_WITH_REMOVED_FIELDS),
      'PolicySchema.parse must not throw when all five removed fields are set',
    );
  });

  for (const field of REMOVED_FIELDS) {
    it(`removed field "${field}" is absent from the parsed result`, () => {
      const result = PolicySchema.parse(INPUT_WITH_REMOVED_FIELDS);
      assert.ok(
        !(field in result.agents),
        `"${field}" must not appear on the parsed agents object (Zod strips unknown keys)`,
      );
    });
  }

  it('agents.max_concurrent equals its declared default (5) — strip does not corrupt other fields', () => {
    const result = PolicySchema.parse(INPUT_WITH_REMOVED_FIELDS);
    assert.strictEqual(
      result.agents.max_concurrent,
      5,
      'max_concurrent must equal 5 (its schema default) after stripping the removed fields',
    );
  });

  it('agents.prune_orphan_worktrees equals its declared default ("on") — strip does not corrupt new fields', () => {
    const result = PolicySchema.parse(INPUT_WITH_REMOVED_FIELDS);
    assert.strictEqual(
      result.agents.prune_orphan_worktrees,
      'on',
      'prune_orphan_worktrees must equal "on" (its schema default) after stripping the removed fields',
    );
  });
});
