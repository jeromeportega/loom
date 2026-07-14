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

// ─── epic_buildup and context_notes silently stripped (story-094-003) ────────

describe('epic_buildup and context_notes — silently stripped (baked fields removed)', () => {
  it('epic_buildup is absent from the parsed result', () => {
    const policy = parsePolicy({ epic_buildup: 'on' });
    assert.ok(!('epic_buildup' in policy.agents), 'epic_buildup must be stripped');
  });

  it('context_notes is absent from the parsed result', () => {
    const policy = parsePolicy({ context_notes: 'on' });
    assert.ok(!('context_notes' in policy.agents), 'context_notes must be stripped');
  });

  it('epic_buildup with any value does not cause a parse error', () => {
    assert.doesNotThrow(() => parsePolicy({ epic_buildup: 'yes' }));
    assert.doesNotThrow(() => parsePolicy({ epic_buildup: 'on' }));
    assert.doesNotThrow(() => parsePolicy({ epic_buildup: 'off' }));
  });

  it('context_notes with any value does not cause a parse error', () => {
    assert.doesNotThrow(() => parsePolicy({ context_notes: 'on' }));
    assert.doesNotThrow(() => parsePolicy({ context_notes: 'off' }));
  });

  it('other agents fields (max_concurrent) are unaffected', () => {
    const policy = parsePolicy({ epic_buildup: 'on', context_notes: 'on' });
    assert.strictEqual(policy.agents.max_concurrent, 5);
  });
});
