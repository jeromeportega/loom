import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBlocked } from '../blockedIndicator.js';
// Verify barrel re-export: all four surfaces import via loom-core's index
import { deriveBlocked as deriveBlockedBarrel } from '../../index.js';
import type { BlockedSignal } from '../../index.js';

describe('deriveBlocked', () => {
  it('[Happy] gate-blocked: status=in_progress + finalize_phase=gate → blocked signal', () => {
    const result = deriveBlocked({ status: 'in_progress', finalize_phase: 'gate' });
    assert.deepStrictEqual(result, { blocked: true, blocked_reason: 'integration_gate' });
  });

  it('[Negative] normal in_progress with no finalize phase → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'in_progress', finalize_phase: null }), null);
  });

  it('[Boundary] non-gate finalize phase merging → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'in_progress', finalize_phase: 'merging' }), null);
  });

  it('[Boundary] non-gate finalize phase review → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'in_progress', finalize_phase: 'review' }), null);
  });

  it('[Negative] gate phase under wrong status: finalizing + gate → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'finalizing', finalize_phase: 'gate' }), null);
  });

  it('[Negative] gate phase under wrong status: done + gate → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'done', finalize_phase: 'gate' }), null);
  });

  it('[Negative] status=failed + gate → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'failed', finalize_phase: 'gate' }), null);
  });

  it('[Negative] status=rejected + gate → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'rejected', finalize_phase: 'gate' }), null);
  });

  it('[Negative] status=planning → null', () => {
    assert.strictEqual(deriveBlocked({ status: 'planning', finalize_phase: null }), null);
  });

  it('[Purity] returns a fresh object each call — does not mutate a frozen input', () => {
    const input = Object.freeze({ status: 'in_progress' as const, finalize_phase: 'gate' as const });
    const a = deriveBlocked(input);
    const b = deriveBlocked(input);
    assert.ok(a !== null && b !== null, 'both calls return a signal');
    // Results are equal but distinct objects
    assert.deepStrictEqual(a, b);
    assert.notStrictEqual(a, b, 'each call returns a fresh object');
    // Mutating the return value does not affect the next call
    (a as unknown as Record<string, unknown>)['extra'] = 'mutation';
    const c = deriveBlocked(input);
    assert.strictEqual((c as unknown as Record<string, unknown>)['extra'], undefined, 'return value is independent of caller mutations');
  });

  it('[Type/export] BlockedSignal and deriveBlocked are re-exported via the loom-core barrel', () => {
    // If this file compiles and the function is callable, the barrel export is present
    const result = deriveBlockedBarrel({ status: 'in_progress', finalize_phase: 'gate' });
    assert.deepStrictEqual(result, { blocked: true, blocked_reason: 'integration_gate' });
  });
});
