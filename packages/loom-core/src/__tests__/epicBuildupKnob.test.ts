/**
 * Tests for the epic_buildup policy knob (story-029-001).
 *
 * Verifies the zod schema default, enum validation, independence from
 * context_notes, and that the resolved value is accessible on policy.agents.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PolicySchema } from '../types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function parsePolicy(agents: Record<string, unknown>) {
  return PolicySchema.parse({ agents });
}

// At runtime, __dirname is dist/__tests__/. The repo root is four levels up:
// dist/__tests__ → dist → loom-core → packages → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ─── (1) Default-off when knob is omitted ────────────────────────────────────

describe('epic_buildup knob — default off when omitted', () => {
  it('resolves to "off" when agents.epic_buildup is not set', () => {
    const policy = parsePolicy({});
    assert.strictEqual(policy.agents.epic_buildup, 'off');
  });

  it('resolves to "off" when agents is an empty object', () => {
    const policy = PolicySchema.parse({ agents: {} });
    assert.strictEqual(policy.agents.epic_buildup, 'off');
  });

  it('resolves to "off" when only other knobs are present', () => {
    const policy = parsePolicy({ context_notes: 'on' });
    assert.strictEqual(policy.agents.epic_buildup, 'off');
  });
});

// ─── (2) Explicit on/off values ──────────────────────────────────────────────

describe('epic_buildup knob — explicit values accepted', () => {
  it('accepts "on" and resolves to "on"', () => {
    const policy = parsePolicy({ epic_buildup: 'on' });
    assert.strictEqual(policy.agents.epic_buildup, 'on');
  });

  it('accepts "off" and resolves to "off"', () => {
    const policy = parsePolicy({ epic_buildup: 'off' });
    assert.strictEqual(policy.agents.epic_buildup, 'off');
  });
});

// ─── (3) Invalid values rejected ─────────────────────────────────────────────

describe('epic_buildup knob — invalid values rejected', () => {
  it('rejects "yes" with a zod validation error', () => {
    assert.throws(
      () => parsePolicy({ epic_buildup: 'yes' }),
      (err: unknown) => err instanceof Error && err.message.length > 0
    );
  });

  it('rejects boolean true with a zod validation error', () => {
    assert.throws(
      () => parsePolicy({ epic_buildup: true }),
      (err: unknown) => err instanceof Error && err.message.length > 0
    );
  });

  it('rejects numeric 1 with a zod validation error', () => {
    assert.throws(
      () => parsePolicy({ epic_buildup: 1 }),
      (err: unknown) => err instanceof Error && err.message.length > 0
    );
  });
});

// ─── (4) Regression — context_notes is unchanged ─────────────────────────────

describe('epic_buildup knob — context_notes independence (ADR-001)', () => {
  it('context_notes still defaults to "off" when epic_buildup is absent', () => {
    const policy = parsePolicy({});
    assert.strictEqual(policy.agents.context_notes, 'off');
  });

  it('context_notes "on" is unaffected when epic_buildup is also "on"', () => {
    const policy = parsePolicy({ context_notes: 'on', epic_buildup: 'on' });
    assert.strictEqual(policy.agents.context_notes, 'on');
    assert.strictEqual(policy.agents.epic_buildup, 'on');
  });

  it('both knobs independently on validates cleanly', () => {
    assert.doesNotThrow(() =>
      parsePolicy({ context_notes: 'on', epic_buildup: 'on' })
    );
  });

  it('both knobs independently off validates cleanly', () => {
    assert.doesNotThrow(() =>
      parsePolicy({ context_notes: 'off', epic_buildup: 'off' })
    );
  });

  it('context_notes on + epic_buildup absent keeps context_notes "on"', () => {
    const policy = parsePolicy({ context_notes: 'on' });
    assert.strictEqual(policy.agents.context_notes, 'on');
    assert.strictEqual(policy.agents.epic_buildup, 'off');
  });
});

// ─── (6) Schema text assertions ──────────────────────────────────────────────

describe('epic_buildup knob — policy.schema.yaml content', () => {
  const schemaText = readFileSync(
    path.join(REPO_ROOT, 'schemas', 'policy.schema.yaml'),
    'utf8'
  );

  it('schema contains epic_buildup as an enum field', () => {
    assert.ok(
      schemaText.includes('epic_buildup:'),
      'schema must contain an epic_buildup key'
    );
  });

  it('schema enum is [off, on]', () => {
    assert.ok(
      /enum:\s*\[off,\s*on\]/.test(schemaText),
      'schema must define enum [off, on] for epic_buildup'
    );
  });

  it('schema default is off', () => {
    // Look for the epic_buildup block and verify default: off appears nearby
    const epIdx = schemaText.indexOf('epic_buildup:');
    assert.ok(epIdx !== -1, 'epic_buildup must exist in schema');
    const surrounding = schemaText.slice(epIdx, epIdx + 200);
    assert.ok(
      surrounding.includes('default: off'),
      'epic_buildup default must be off in the schema'
    );
  });
});
