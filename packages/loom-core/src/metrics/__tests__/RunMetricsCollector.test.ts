import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunMetricsCollector } from '../RunMetricsCollector.js';
import type { LLMUsage } from '../../llm/LLMClient.js';

function makeUsage(overrides: Partial<LLMUsage> = {}): LLMUsage {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    requestCount: 1,
    costUsd: 0.001,
    ...overrides,
  };
}

// ─── phase tracking ───────────────────────────────────────────────────────────

describe('RunMetricsCollector — phase tracking', () => {
  it('currentPhase() returns undefined before any startPhase call', () => {
    const c = new RunMetricsCollector();
    assert.equal(c.currentPhase(), undefined);
  });

  it('startPhase sets the current phase', () => {
    const c = new RunMetricsCollector();
    c.startPhase('analyst');
    assert.equal(c.currentPhase(), 'analyst');
  });

  it('startPhase on a new phase updates currentPhase', () => {
    const c = new RunMetricsCollector();
    c.startPhase('analyst');
    c.startPhase('pm');
    assert.equal(c.currentPhase(), 'pm');
  });

  it('endPhase accrues a non-negative wallMs', () => {
    const c = new RunMetricsCollector();
    c.startPhase('analyst');
    c.endPhase('analyst');
    const result = c.build();
    const analyst = result.phases.find((p) => p.phase === 'analyst')!;
    assert.ok(analyst, 'analyst phase present');
    assert.ok(analyst.wallMs >= 0, 'wallMs is non-negative');
  });

  it('endPhase without a matching startPhase is a no-op', () => {
    const c = new RunMetricsCollector();
    assert.doesNotThrow(() => c.endPhase('pm'), 'endPhase with no start must not throw');
  });

  it('startPhase can be called again for the same phase (re-enters timing window)', () => {
    const c = new RunMetricsCollector();
    c.startPhase('worker');
    c.endPhase('worker');
    const midWall = c.build().phases.find((p) => p.phase === 'worker')!.wallMs;
    c.startPhase('worker');
    c.endPhase('worker');
    const finalWall = c.build().phases.find((p) => p.phase === 'worker')!.wallMs;
    assert.ok(finalWall >= midWall, 'wall time accumulates across re-entry');
  });
});

// ─── addUsage ─────────────────────────────────────────────────────────────────

describe('RunMetricsCollector.addUsage — token accumulation', () => {
  it('addUsage with explicit phase creates the phase entry', () => {
    const c = new RunMetricsCollector();
    c.addUsage(makeUsage(), 'claude-sonnet-4-6', 'analyst');
    const result = c.build();
    const analyst = result.phases.find((p) => p.phase === 'analyst')!;
    assert.ok(analyst, 'analyst phase created by addUsage');
    assert.equal(analyst.tokensInput, 100);
    assert.equal(analyst.tokensOutput, 50);
    assert.equal(analyst.tokensCached, 20);
    assert.equal(analyst.tokensCacheCreation, 10);
    assert.equal(analyst.requestCount, 1);
  });

  it('addUsage defaults to currentPhase when phase is omitted', () => {
    const c = new RunMetricsCollector();
    c.startPhase('pm');
    c.addUsage(makeUsage({ inputTokens: 200 }));
    const pm = c.build().phases.find((p) => p.phase === 'pm')!;
    assert.ok(pm);
    assert.equal(pm.tokensInput, 200);
  });

  it('addUsage is a no-op when no phase is active and none is specified', () => {
    const c = new RunMetricsCollector();
    assert.doesNotThrow(() => c.addUsage(makeUsage()), 'must not throw without active phase');
    const result = c.build();
    assert.equal(result.phases.length, 0, 'no phases created');
  });

  it('billedTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens', () => {
    const c = new RunMetricsCollector();
    const usage = makeUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
    });
    c.addUsage(usage, undefined, 'analyst');
    const analyst = c.build().phases.find((p) => p.phase === 'analyst')!;
    assert.equal(analyst.billedTokens, 180, 'billedTokens = 100+50+20+10');
  });

  it('multiple addUsage calls for the same phase accumulate', () => {
    const c = new RunMetricsCollector();
    c.startPhase('worker');
    c.addUsage(makeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 1 }));
    c.addUsage(makeUsage({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, requestCount: 2 }));
    const worker = c.build().phases.find((p) => p.phase === 'worker')!;
    assert.equal(worker.tokensInput, 300);
    assert.equal(worker.tokensOutput, 150);
    assert.equal(worker.requestCount, 3);
  });

  it('model is set on the phase when provided', () => {
    const c = new RunMetricsCollector();
    c.addUsage(makeUsage(), 'claude-opus-4-8', 'analyst');
    const analyst = c.build().phases.find((p) => p.phase === 'analyst')!;
    assert.equal(analyst.model, 'claude-opus-4-8');
  });

  it('model is absent when not provided (optional field)', () => {
    const c = new RunMetricsCollector();
    c.addUsage(makeUsage(), undefined, 'gate');
    const gate = c.build().phases.find((p) => p.phase === 'gate')!;
    assert.equal(gate.model, undefined);
  });

  it('costUsd is omitted from phases when zero (cursor-cli path)', () => {
    const c = new RunMetricsCollector();
    c.addUsage(makeUsage({ costUsd: 0 }), undefined, 'worker');
    const worker = c.build().phases.find((p) => p.phase === 'worker')!;
    assert.equal(worker.costUsd, undefined, 'zero costUsd should be omitted (cursor-cli path)');
  });

  it('costUsd is included in phases when positive', () => {
    const c = new RunMetricsCollector();
    c.addUsage(makeUsage({ costUsd: 0.005 }), undefined, 'analyst');
    const analyst = c.build().phases.find((p) => p.phase === 'analyst')!;
    assert.ok(analyst.costUsd !== undefined && analyst.costUsd > 0, 'positive costUsd is included');
  });
});

// ─── markApproved / markFirstToken → dispatchLatencyMs ───────────────────────

describe('RunMetricsCollector — dispatch latency', () => {
  it('dispatchLatencyMs is absent when markApproved/markFirstToken are not called', () => {
    const c = new RunMetricsCollector();
    const result = c.build();
    assert.equal(result.dispatchLatencyMs, undefined);
  });

  it('dispatchLatencyMs is computed as firstToken - approved', () => {
    const c = new RunMetricsCollector();
    c.markApproved();
    // Simulate some time passing (just call markFirstToken right after)
    c.markFirstToken();
    const result = c.build();
    assert.ok(typeof result.dispatchLatencyMs === 'number', 'dispatchLatencyMs is a number');
    assert.ok(result.dispatchLatencyMs >= 0, 'dispatchLatencyMs is non-negative');
  });

  it('dispatchLatencyMs set via setAttribution is used when markApproved not called', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ dispatchLatencyMs: 1234 });
    const result = c.build();
    assert.equal(result.dispatchLatencyMs, 1234);
  });

  it('direct measurement overrides setAttribution dispatchLatencyMs', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ scope: 'epic', dispatchLatencyMs: 9999 });
    c.markApproved();
    c.markFirstToken();
    const result = c.build();
    // The measured value should be used (not the setAttribution value)
    assert.ok(result.dispatchLatencyMs !== 9999, 'measured dispatch latency overrides attribution value');
  });
});

// ─── setAttribution / build ───────────────────────────────────────────────────

describe('RunMetricsCollector.setAttribution + build', () => {
  it('scope is passed through from setAttribution', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ scope: 'standalone_story' });
    assert.equal(c.build().scope, 'standalone_story');
  });

  it('scope defaults to "epic" when not set', () => {
    const c = new RunMetricsCollector();
    assert.equal(c.build().scope, 'epic');
  });

  it('setAttribution merges multiple calls additively', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ scope: 'epic', epicId: 'epic-001' });
    c.setAttribution({ outcome: 'done', retryCount: 2 });
    const result = c.build();
    assert.equal(result.scope, 'epic');
    assert.equal(result.epicId, 'epic-001');
    assert.equal(result.outcome, 'done');
    assert.equal(result.retryCount, 2);
  });

  it('later setAttribution overwrites earlier values for same key', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ epicId: 'epic-001' });
    c.setAttribution({ epicId: 'epic-002' });
    assert.equal(c.build().epicId, 'epic-002');
  });

  it('all attribution fields round-trip through build()', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({
      scope: 'epic_story',
      epicId: 'epic-007',
      storyId: 'story-007-003',
      agentId: 'agent-abc',
      intakeVerdict: 'story',
      intakeKind: 'ticket',
      storyCount: 5,
      retryCount: 1,
      cleanRetryCount: 0,
      autoRecoveryCount: 2,
      outcome: 'gate_passed',
      startedAt: '2026-06-01T10:00:00Z',
      endedAt: '2026-06-01T10:05:00Z',
    });
    const result = c.build();
    assert.equal(result.scope, 'epic_story');
    assert.equal(result.epicId, 'epic-007');
    assert.equal(result.storyId, 'story-007-003');
    assert.equal(result.agentId, 'agent-abc');
    assert.equal(result.intakeVerdict, 'story');
    assert.equal(result.intakeKind, 'ticket');
    assert.equal(result.storyCount, 5);
    assert.equal(result.retryCount, 1);
    assert.equal(result.cleanRetryCount, 0);
    assert.equal(result.autoRecoveryCount, 2);
    assert.equal(result.outcome, 'gate_passed');
    assert.equal(result.startedAt, '2026-06-01T10:00:00Z');
    assert.equal(result.endedAt, '2026-06-01T10:05:00Z');
  });

  it('retryCount/cleanRetryCount/autoRecoveryCount default to 0 when not set', () => {
    const c = new RunMetricsCollector();
    const result = c.build();
    assert.equal(result.retryCount, 0);
    assert.equal(result.cleanRetryCount, 0);
    assert.equal(result.autoRecoveryCount, 0);
  });

  it('build() is pure — calling it twice returns equivalent results', () => {
    const c = new RunMetricsCollector();
    c.setAttribution({ scope: 'epic', epicId: 'epic-pure' });
    c.addUsage(makeUsage(), undefined, 'analyst');
    const r1 = c.build();
    const r2 = c.build();
    assert.deepEqual(r1, r2, 'build() is pure — same output on repeated calls');
  });
});

// ─── bindActiveCollector / clearActiveCollector seam ─────────────────────────

describe('activeCollector seam (bindActiveCollector / clearActiveCollector)', () => {
  it('activeCollector() returns undefined before any bind', async () => {
    // Import after bind/clear to avoid circular state from other tests.
    const { activeCollector, bindActiveCollector, clearActiveCollector } = await import('../activeCollector.js');
    clearActiveCollector();
    assert.equal(activeCollector(), undefined);
  });

  it('bindActiveCollector makes the collector reachable via activeCollector()', async () => {
    const { activeCollector, bindActiveCollector, clearActiveCollector } = await import('../activeCollector.js');
    clearActiveCollector();
    const c = new RunMetricsCollector();
    bindActiveCollector(c);
    assert.equal(activeCollector(), c);
    clearActiveCollector();
  });

  it('clearActiveCollector unsets the binding', async () => {
    const { activeCollector, bindActiveCollector, clearActiveCollector } = await import('../activeCollector.js');
    const c = new RunMetricsCollector();
    bindActiveCollector(c);
    clearActiveCollector();
    assert.equal(activeCollector(), undefined);
  });
});
