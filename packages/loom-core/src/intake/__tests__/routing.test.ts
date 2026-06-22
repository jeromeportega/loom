/**
 * Unit tests for buildSizingConstraintBlock (story-045-002, AC1).
 *
 * Proves that the builder emits the correct instruction text for each size
 * value and that the story-sized path uses distinct language from the epic-sized
 * path. Tests are deterministic and never call the LLM.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSizingConstraintBlock } from '../routing.js';
import type { EffectiveRouting } from '../routing.js';

const BASE: EffectiveRouting = {
  type:       'feature',
  size:       'story',
  confidence: 'high',
  source:     'classifier',
};

describe('buildSizingConstraintBlock', () => {
  it('story-sized: emits single-cohesive-story / minimal-decomposition instruction', () => {
    const block = buildSizingConstraintBlock({ ...BASE, size: 'story' });

    assert.ok(
      block.includes('single cohesive story') || block.includes('minimum necessary decomposition'),
      'story block must mention single cohesive story or minimum necessary decomposition'
    );
    assert.ok(
      !block.includes('full decomposition'),
      'story block must NOT mention full decomposition'
    );
  });

  it('epic-sized: emits full-decomposition instruction', () => {
    const block = buildSizingConstraintBlock({ ...BASE, size: 'epic' });

    assert.ok(
      block.includes('full decomposition') || block.includes('full'),
      'epic block must mention full decomposition'
    );
  });

  it('story block starts with a newline (appended cleanly to the base message)', () => {
    const block = buildSizingConstraintBlock({ ...BASE, size: 'story' });
    assert.ok(block.startsWith('\n'), 'sizing block must start with a newline for clean append');
  });

  it('epic block starts with a newline', () => {
    const block = buildSizingConstraintBlock({ ...BASE, size: 'epic' });
    assert.ok(block.startsWith('\n'), 'sizing block must start with a newline for clean append');
  });

  it('story and epic blocks produce distinct text', () => {
    const storyBlock = buildSizingConstraintBlock({ ...BASE, size: 'story' });
    const epicBlock  = buildSizingConstraintBlock({ ...BASE, size: 'epic' });
    assert.notEqual(storyBlock, epicBlock, 'story and epic sizing blocks must differ');
  });

  it('type, confidence, and source do not alter the block text (only size matters)', () => {
    const a = buildSizingConstraintBlock({ type: 'feature', size: 'story', confidence: 'high', source: 'classifier' });
    const b = buildSizingConstraintBlock({ type: 'bug',     size: 'story', confidence: 'low',  source: 'operator-override' });
    assert.equal(a, b, 'block text must depend only on size, not on type/confidence/source');
  });
});
