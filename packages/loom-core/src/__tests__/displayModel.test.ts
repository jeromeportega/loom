/**
 * Unit tests for the displayModel() helper (epic-013, story-013-003).
 *
 * Covers AC2: NULL/undefined/empty string → 'unknown'; valid model id → model id.
 * Only the model id is returned — no keys or credentials.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayModel } from '../orchestrator/renderUtils.js';

describe('displayModel', () => {
  it('returns a populated model id unchanged', () => {
    assert.equal(displayModel('claude-opus-4-8'), 'claude-opus-4-8');
  });

  it('returns a populated model id unchanged (alternate model)', () => {
    assert.equal(displayModel('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  });

  it('returns "unknown" for null (pre-migration rows)', () => {
    assert.equal(displayModel(null), 'unknown');
  });

  it('returns "unknown" for undefined', () => {
    assert.equal(displayModel(undefined), 'unknown');
  });

  it('returns "unknown" for empty string', () => {
    assert.equal(displayModel(''), 'unknown');
  });
});
