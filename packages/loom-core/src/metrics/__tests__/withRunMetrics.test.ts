/**
 * Unit tests for the withRunMetrics<T> lifecycle wrapper (story-065-001).
 *
 * Tests cover:
 *  - Happy path: collector constructed, bound BEFORE fn, same instance visible inside fn
 *  - Cleanup on success: clearActiveCollector() fires (verified via recordRun being called
 *    in the same finally block); run produces a persisted metrics row
 *  - Cleanup on failure: clearActiveCollector() fires even when fn throws, error re-thrown
 *  - recordRun fail-open: MetricsStore.recordRun throws → error swallowed, fn result returned
 *  - Scope propagation: init.scope is set on the collector before fn runs
 *  - Both scopes ('epic' and 'standalone_story') produce correctly-attributed builds
 *  - LLM-wrap integration: instrumentLLMClient routes usage to active collector when bound
 *    via withRunMetrics (confirms the ADR-004 production path works end-to-end)
 *
 * Note on AsyncLocalStorage.enterWith semantics:
 *   bindActiveCollector / clearActiveCollector use enterWith(), which modifies the store
 *   for async descendants spawned from the current execution point. Callers that have
 *   already been scheduled (i.e., the test's continuation after `await withRunMetrics(...)`)
 *   run in a sibling async context that does NOT see the `clearActiveCollector()` effect.
 *   Therefore, "the slot is cleared" is verified indirectly: both recordRun and
 *   clearActiveCollector live in the same finally block, so a persisted metrics row proves
 *   the finally ran. Test isolation is handled by the beforeEach/afterEach hooks.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { withRunMetrics } from '../withRunMetrics.js';
import { activeCollector, clearActiveCollector } from '../activeCollector.js';
import { RunMetricsCollector } from '../RunMetricsCollector.js';
import { instrumentLLMClient } from '../instrumentLLMClient.js';
import { MetricsStore } from '../../state/MetricsStore.js';
import { createDatabase } from '../../state/Database.js';
import type { LLMClient, LLMRequest, LLMResponse, LLMUsage } from '../../llm/LLMClient.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  return createDatabase(':memory:');
}

function makeStore(db: Database.Database): MetricsStore {
  return new MetricsStore(db);
}

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

function makeFakeClient(usage: LLMUsage): LLMClient {
  return {
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      return { text: 'ok', model: 'test-model', stopReason: 'end_turn', usage };
    },
  };
}

// ─── ensure clean state between tests ────────────────────────────────────────

beforeEach(() => clearActiveCollector());
afterEach(() => clearActiveCollector());

// ─── happy path ───────────────────────────────────────────────────────────────

describe('withRunMetrics — happy path', () => {
  it('passes the collector to fn and activeCollector() returns it inside fn', async () => {
    const db = makeDb();
    const store = makeStore(db);
    let insideFn: RunMetricsCollector | undefined;
    let passedCollector: RunMetricsCollector | undefined;

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      passedCollector = c;
      insideFn = activeCollector();
    });

    assert.ok(passedCollector instanceof RunMetricsCollector, 'collector passed to fn');
    assert.strictEqual(insideFn, passedCollector, 'activeCollector() returns the same instance inside fn');
    db.close();
  });

  it('bindActiveCollector is called BEFORE fn runs (activeCollector not undefined at fn entry)', async () => {
    const db = makeDb();
    const store = makeStore(db);
    let atEntry: RunMetricsCollector | undefined;

    await withRunMetrics({ scope: 'epic', store }, async () => {
      atEntry = activeCollector();
    });

    assert.ok(atEntry !== undefined, 'collector was already bound when fn was entered');
    db.close();
  });

  it('constructs exactly one RunMetricsCollector per call', async () => {
    const db = makeDb();
    const store = makeStore(db);
    const collectors: RunMetricsCollector[] = [];

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      collectors.push(c);
    });

    assert.equal(collectors.length, 1, 'exactly one collector constructed');
    db.close();
  });

  it('returns the value returned by fn', async () => {
    const db = makeDb();
    const store = makeStore(db);

    const result = await withRunMetrics({ scope: 'epic', store }, async () => 42);

    assert.equal(result, 42);
    db.close();
  });
});

// ─── cleanup on success ───────────────────────────────────────────────────────
// clearActiveCollector() is in the same finally block as recordRun.
// A persisted metrics row proves the finally ran (which proves clearActiveCollector fired).

describe('withRunMetrics — cleanup on success', () => {
  it('the finally block fires after fn resolves (verified via persisted run_metrics row)', async () => {
    const db = makeDb();
    const store = makeStore(db);

    await withRunMetrics({ scope: 'epic', store }, async () => undefined);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM run_metrics').get() as { n: number };
    assert.equal(rows.n, 1, 'finally ran: one run_metrics row after successful run');
    db.close();
  });

  it('activeCollector() inside fn is the passed collector (not a previous run leak)', async () => {
    const db = makeDb();
    const store = makeStore(db);
    let seen: RunMetricsCollector | undefined;

    // Two sequential calls: the second one must see ITS OWN collector, not the first's.
    const db2 = makeDb();
    const store2 = makeStore(db2);
    let firstCollector: RunMetricsCollector | undefined;
    let secondCollector: RunMetricsCollector | undefined;

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      firstCollector = c;
    });

    await withRunMetrics({ scope: 'standalone_story', store: store2 }, async (c) => {
      secondCollector = activeCollector();
      seen = c;
    });

    assert.ok(firstCollector !== secondCollector, 'second call sees its own fresh collector, not the first');
    assert.strictEqual(secondCollector, seen, 'second collector consistent');
    db.close();
    db2.close();
  });
});

// ─── cleanup on failure ───────────────────────────────────────────────────────

describe('withRunMetrics — cleanup on failure (early-exit path)', () => {
  it('re-throws the original error when fn throws', async () => {
    const db = makeDb();
    const store = makeStore(db);
    const sentinel = new Error('sentinel error');

    let caught: Error | undefined;
    try {
      await withRunMetrics({ scope: 'epic', store }, async () => {
        throw sentinel;
      });
    } catch (e) {
      caught = e as Error;
    }

    assert.strictEqual(caught, sentinel, 'original error reference preserved');
    db.close();
  });

  it('calls clearActiveCollector even when fn throws (verified via recordRun in same finally)', async () => {
    const db = makeDb();
    const store = makeStore(db);

    await assert.rejects(
      withRunMetrics({ scope: 'epic', store }, async () => {
        throw new Error('fn failed');
      }),
    );

    // recordRun and clearActiveCollector live in the same finally block.
    // A persisted row proves the finally ran (clearActiveCollector was invoked).
    const rows = db.prepare('SELECT COUNT(*) AS n FROM run_metrics').get() as { n: number };
    assert.equal(rows.n, 1, 'run_metrics row persisted even after fn threw (proves finally ran)');
    db.close();
  });

  it('activeCollector() inside fn is the bound collector even right before fn throws', async () => {
    const db = makeDb();
    const store = makeStore(db);
    let seenInFn: RunMetricsCollector | undefined;

    await assert.rejects(
      withRunMetrics({ scope: 'epic', store }, async (c) => {
        seenInFn = activeCollector();
        throw new Error('throws after observing');
      }),
    );

    assert.ok(seenInFn instanceof RunMetricsCollector, 'collector was bound before throw');
    db.close();
  });
});

// ─── recordRun fail-open ──────────────────────────────────────────────────────

describe('withRunMetrics — recordRun fail-open (NFR-1)', () => {
  it('swallows MetricsStore.recordRun errors and still returns fn result', async () => {
    // Use a real DB but close it before the finally block runs so recordRun throws.
    const db = makeDb();
    const store = makeStore(db);
    // Close the DB BEFORE withRunMetrics fires the finally, simulating a metrics failure.
    db.close();

    // Should not throw — fail-open contract.
    const result = await withRunMetrics({ scope: 'epic', store }, async () => 99);
    assert.equal(result, 99, 'fn result returned despite recordRun throwing');
  });

  it('swallows errors even when fn throws too (both throw paths fail-open)', async () => {
    const db = makeDb();
    const store = makeStore(db);
    db.close(); // force recordRun to throw

    // The fn error must still propagate; the recordRun error must be swallowed.
    const fnError = new Error('fn error');
    let caught: Error | undefined;
    try {
      await withRunMetrics({ scope: 'epic', store }, async () => { throw fnError; });
    } catch (e) {
      caught = e as Error;
    }
    assert.strictEqual(caught, fnError, 'fn error propagated; recordRun error swallowed');
  });
});

// ─── scope propagation ────────────────────────────────────────────────────────

describe('withRunMetrics — scope propagation', () => {
  it("scope 'epic' is reflected in c.build().scope inside fn", async () => {
    const db = makeDb();
    const store = makeStore(db);
    let builtScope: string | undefined;

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      builtScope = c.build().scope;
    });

    assert.equal(builtScope, 'epic');
    db.close();
  });

  it("scope 'standalone_story' is reflected in c.build().scope inside fn", async () => {
    const db = makeDb();
    const store = makeStore(db);
    let builtScope: string | undefined;

    await withRunMetrics({ scope: 'standalone_story', store }, async (c) => {
      builtScope = c.build().scope;
    });

    assert.equal(builtScope, 'standalone_story');
    db.close();
  });

  it("scope 'epic' is persisted to run_metrics.scope", async () => {
    const db = makeDb();
    const store = makeStore(db);

    await withRunMetrics({ scope: 'epic', store }, async () => undefined);

    const row = db.prepare('SELECT scope FROM run_metrics LIMIT 1').get() as { scope: string } | undefined;
    assert.equal(row?.scope, 'epic');
    db.close();
  });

  it("scope 'standalone_story' is persisted to run_metrics.scope", async () => {
    const db = makeDb();
    const store = makeStore(db);

    await withRunMetrics({ scope: 'standalone_story', store }, async () => undefined);

    const row = db.prepare('SELECT scope FROM run_metrics LIMIT 1').get() as { scope: string } | undefined;
    assert.equal(row?.scope, 'standalone_story');
    db.close();
  });
});

// ─── LLM-wrap integration (ADR-004) ──────────────────────────────────────────
// Confirms that instrumentLLMClient routes usage to the active collector bound
// via withRunMetrics. This is the same code path that createLLMClient uses
// (createLLMClient wraps with instrumentLLMClient; no second wrap needed).

describe('withRunMetrics — LLM-wrap integration (ADR-004)', () => {
  it('complete() on instrumentLLMClient routes usage to the active collector', async () => {
    const db = makeDb();
    const store = makeStore(db);
    const usage = makeUsage({ inputTokens: 200, outputTokens: 80, requestCount: 1 });
    const fakeClient = makeFakeClient(usage);
    const instrumented = instrumentLLMClient(fakeClient);

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.startPhase('analyst');
      await instrumented.complete({
        model: 'test-model',
        system: [{ text: 'system' }],
        messages: [{ role: 'user', content: 'hello' }],
      });
    });

    // Verify the usage was routed to the persisted row
    const row = db
      .prepare('SELECT tokens_input FROM run_metrics_phase WHERE phase = ?')
      .get('analyst') as { tokens_input: number } | undefined;
    assert.ok(row, 'analyst phase row should exist');
    assert.equal(row!.tokens_input, 200, 'inputTokens routed to the active collector');
    db.close();
  });

  it('double-wrap guard: instrumenting an already-instrumented client does not double-count usage', async () => {
    const db = makeDb();
    const store = makeStore(db);
    const usage = makeUsage({ inputTokens: 100, requestCount: 1 });
    const inner = instrumentLLMClient(makeFakeClient(usage));
    const doubleWrapped = instrumentLLMClient(inner); // should return same instance

    assert.strictEqual(doubleWrapped, inner, 'double-wrap returns the same instance');

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.startPhase('analyst');
      await doubleWrapped.complete({
        model: 'test-model',
        system: [{ text: 'system' }],
        messages: [{ role: 'user', content: 'hello' }],
      });
    });

    const row = db
      .prepare('SELECT tokens_input FROM run_metrics_phase WHERE phase = ?')
      .get('analyst') as { tokens_input: number } | undefined;
    assert.equal(row?.tokens_input, 100, 'usage counted exactly once — no double-count');
    db.close();
  });

  it('no-op when unbound: complete() with no collector does not throw', async () => {
    // Ensure no collector is bound.
    clearActiveCollector();
    const fakeClient = makeFakeClient(makeUsage());
    const instrumented = instrumentLLMClient(fakeClient);

    // Should not throw.
    await instrumented.complete({
      model: 'test-model',
      system: [{ text: 'system' }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    // No assertion needed — reaching here means no throw.
  });
});
