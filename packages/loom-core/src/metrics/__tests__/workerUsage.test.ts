/**
 * Unit tests for the toLLMUsage adapter (story-065-003).
 *
 * Verifies the WorkerUsage → LLMUsage field mapping, including optional-field
 * defaults (costUsd → 0, requestCount → 1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toLLMUsage } from '../workerUsage.js';
import type { WorkerUsage } from '../../orchestrator/WorkerRunner.js';

function workerUsage(overrides: Partial<WorkerUsage> = {}): WorkerUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    totalTokens: 180,
    costUsd: 0.002,
    requestCount: 3,
    ...overrides,
  };
}

describe('toLLMUsage — field mapping', () => {
  it('maps all non-optional fields correctly', () => {
    const result = toLLMUsage(workerUsage());
    assert.equal(result.inputTokens, 100);
    assert.equal(result.outputTokens, 50);
    assert.equal(result.cacheReadTokens, 20);
    assert.equal(result.cacheCreationTokens, 10);
    assert.equal(result.costUsd, 0.002);
    assert.equal(result.requestCount, 3);
  });

  it('does not include totalTokens in LLMUsage (not a field)', () => {
    const result = toLLMUsage(workerUsage()) as unknown as Record<string, unknown>;
    assert.equal(result['totalTokens'], undefined, 'totalTokens must not appear in LLMUsage');
  });

  it('defaults costUsd to 0 when absent', () => {
    const result = toLLMUsage(workerUsage({ costUsd: undefined }));
    assert.equal(result.costUsd, 0);
  });

  it('defaults requestCount to 1 when absent', () => {
    const result = toLLMUsage(workerUsage({ requestCount: undefined }));
    assert.equal(result.requestCount, 1);
  });

  it('passes through costUsd=0 as-is (not treated as missing)', () => {
    const result = toLLMUsage(workerUsage({ costUsd: 0 }));
    assert.equal(result.costUsd, 0);
  });

  it('passes through requestCount=0 as-is (not treated as missing)', () => {
    const result = toLLMUsage(workerUsage({ requestCount: 0 }));
    assert.equal(result.requestCount, 0);
  });

  it('handles all-zero token counts', () => {
    const result = toLLMUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
    });
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.cacheCreationTokens, 0);
    assert.equal(result.costUsd, 0);
    assert.equal(result.requestCount, 1);
  });
});
