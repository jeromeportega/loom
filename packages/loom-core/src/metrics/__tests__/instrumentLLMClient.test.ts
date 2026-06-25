import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { instrumentLLMClient } from '../instrumentLLMClient.js';
import { RunMetricsCollector } from '../RunMetricsCollector.js';
import { bindActiveCollector, clearActiveCollector } from '../activeCollector.js';
import type { LLMClient, LLMRequest, LLMResponse, LLMUsage } from '../../llm/LLMClient.js';

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

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    text: 'hello world',
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    usage: makeUsage(),
    ...overrides,
  };
}

function makeFakeClient(res: LLMResponse): LLMClient {
  return {
    async complete(_req: LLMRequest): Promise<LLMResponse> {
      return res;
    },
  };
}

function makeRequest(): LLMRequest {
  return {
    model: 'claude-sonnet-4-6',
    system: [{ text: 'You are an assistant.' }],
    messages: [{ role: 'user', content: 'Hello' }],
  };
}

beforeEach(() => {
  clearActiveCollector();
});

afterEach(() => {
  clearActiveCollector();
});

// ─── pass-through identity ────────────────────────────────────────────────────

describe('instrumentLLMClient — pass-through identity', () => {
  it('returns the exact response object from inner.complete (byte-identical)', async () => {
    const expected = makeResponse();
    const client = instrumentLLMClient(makeFakeClient(expected));
    const actual = await client.complete(makeRequest());
    assert.strictEqual(actual, expected, 'must return the same object reference');
  });

  it('res.model is unchanged', async () => {
    const expected = makeResponse({ model: 'claude-opus-4-8' });
    const client = instrumentLLMClient(makeFakeClient(expected));
    const actual = await client.complete(makeRequest());
    assert.equal(actual.model, 'claude-opus-4-8');
  });

  it('res.usage is unchanged', async () => {
    const usage = makeUsage({ inputTokens: 999, outputTokens: 111 });
    const expected = makeResponse({ usage });
    const client = instrumentLLMClient(makeFakeClient(expected));
    const actual = await client.complete(makeRequest());
    assert.strictEqual(actual.usage, usage, 'usage object reference must be unchanged');
    assert.equal(actual.usage.inputTokens, 999);
    assert.equal(actual.usage.outputTokens, 111);
  });

  it('res.text is unchanged', async () => {
    const expected = makeResponse({ text: 'original text' });
    const client = instrumentLLMClient(makeFakeClient(expected));
    const actual = await client.complete(makeRequest());
    assert.equal(actual.text, 'original text');
  });
});

// ─── double-wrap guard ────────────────────────────────────────────────────────

describe('instrumentLLMClient — double-wrap guard', () => {
  it('wrapping an already-instrumented client returns it unchanged', () => {
    const inner = makeFakeClient(makeResponse());
    const once = instrumentLLMClient(inner);
    const twice = instrumentLLMClient(once);
    assert.strictEqual(once, twice, 'double-wrap must return the same instrumented object');
  });
});

// ─── report fires / collector accumulation ───────────────────────────────────

describe('instrumentLLMClient — collector integration', () => {
  it('report fires per call and routes usage + model to the active collector', async () => {
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('analyst');

    const res = makeResponse({
      usage: makeUsage({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 30, cacheCreationTokens: 5 }),
      model: 'claude-sonnet-4-6',
    });
    const client = instrumentLLMClient(makeFakeClient(res));
    await client.complete(makeRequest());

    const result = collector.build();
    const phase = result.phases.find((p) => p.phase === 'analyst')!;
    assert.ok(phase, 'analyst phase exists');
    assert.equal(phase.tokensInput, 200);
    assert.equal(phase.tokensOutput, 80);
    assert.equal(phase.tokensCached, 30);
    assert.equal(phase.tokensCacheCreation, 5);
    assert.equal(phase.model, 'claude-sonnet-4-6');
  });

  it('accumulates tokens from two calls in the same phase', async () => {
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('pm');

    const res1 = makeResponse({ usage: makeUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }) });
    const res2 = makeResponse({ usage: makeUsage({ inputTokens: 200, outputTokens: 60, cacheReadTokens: 10, cacheCreationTokens: 0 }) });
    // Use the same instrumented client for both calls to avoid coupling to
    // cross-instance accumulation semantics.
    let currentRes = res1;
    const fakeClient: LLMClient = { async complete(_req: LLMRequest): Promise<LLMResponse> { return currentRes; } };
    const client = instrumentLLMClient(fakeClient);

    await client.complete(makeRequest());
    currentRes = res2;
    await client.complete(makeRequest());

    const pm = collector.build().phases.find((p) => p.phase === 'pm')!;
    assert.equal(pm.tokensInput, 300, 'tokensInput sums across two calls');
    assert.equal(pm.tokensOutput, 110, 'tokensOutput sums across two calls');
    assert.equal(pm.tokensCached, 10, 'tokensCached sums across two calls');
    assert.equal(pm.requestCount, 2, 'requestCount sums across two calls');
  });

  it('accumulates costUsd across two calls in the same phase', async () => {
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('pm');

    let currentRes = makeResponse({ usage: makeUsage({ costUsd: 0.001 }) });
    const fakeClient: LLMClient = { async complete(_req: LLMRequest): Promise<LLMResponse> { return currentRes; } };
    const client = instrumentLLMClient(fakeClient);

    await client.complete(makeRequest());
    currentRes = makeResponse({ usage: makeUsage({ costUsd: 0.002 }) });
    await client.complete(makeRequest());

    const pm = collector.build().phases.find((p) => p.phase === 'pm')!;
    assert.ok(pm.costUsd !== undefined, 'costUsd should be defined after two calls');
    assert.ok(
      Math.abs((pm.costUsd ?? 0) - 0.003) < 1e-9,
      `costUsd should sum to 0.003, got ${pm.costUsd}`,
    );
  });

  it('a call under a different phase is accumulated separately', async () => {
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);

    collector.startPhase('analyst');
    const clientA = instrumentLLMClient(makeFakeClient(makeResponse({ usage: makeUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }) })));
    await clientA.complete(makeRequest());

    collector.startPhase('architect');
    const clientB = instrumentLLMClient(makeFakeClient(makeResponse({ usage: makeUsage({ inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }) })));
    await clientB.complete(makeRequest());

    const result = collector.build();
    const analyst = result.phases.find((p) => p.phase === 'analyst')!;
    const architect = result.phases.find((p) => p.phase === 'architect')!;
    assert.equal(analyst.tokensInput, 100, 'analyst phase has its own tokens');
    assert.equal(architect.tokensInput, 300, 'architect phase has its own tokens');
  });

  it('no-op when no active collector is bound', async () => {
    // clearActiveCollector() called in beforeEach
    const res = makeResponse();
    const client = instrumentLLMClient(makeFakeClient(res));
    const actual = await client.complete(makeRequest());
    // Must return response unchanged even with no collector
    assert.strictEqual(actual, res);
  });
});

// ─── billed-total reconciliation (NFR-6) ─────────────────────────────────────
// Integration: these tests exercise RunMetricsCollector.addUsage formula via the
// decorator. If the billedTokens formula in the collector is wrong, failures here
// will surface as apparent decorator bugs — that is intentional.

describe('instrumentLLMClient — billed-token reconciliation (NFR-6)', () => {
  it('billedTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens', async () => {
    const usage: LLMUsage = {
      inputTokens: 400,
      outputTokens: 150,
      cacheReadTokens: 80,
      cacheCreationTokens: 25,
      requestCount: 1,
      costUsd: 0.002,
    };
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('analyst');

    const client = instrumentLLMClient(makeFakeClient(makeResponse({ usage })));
    await client.complete(makeRequest());

    const phase = collector.build().phases.find((p) => p.phase === 'analyst')!;
    const expected = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    assert.equal(phase.billedTokens, expected, `billedTokens must equal ${expected}`);
  });

  it('tokensCached maps to cacheReadTokens (not cacheCreationTokens)', async () => {
    const usage: LLMUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 999,
      cacheCreationTokens: 0,
      requestCount: 1,
      costUsd: 0,
    };
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('pm');

    const client = instrumentLLMClient(makeFakeClient(makeResponse({ usage })));
    await client.complete(makeRequest());

    const pm = collector.build().phases.find((p) => p.phase === 'pm')!;
    assert.equal(pm.tokensCached, 999, 'tokensCached maps to cacheReadTokens');
    assert.equal(pm.tokensCacheCreation, 0, 'tokensCacheCreation maps to cacheCreationTokens');
  });

  it('tokensCacheCreation maps to cacheCreationTokens (not cacheReadTokens)', async () => {
    const usage: LLMUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 777,
      requestCount: 1,
      costUsd: 0,
    };
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('architect');

    const client = instrumentLLMClient(makeFakeClient(makeResponse({ usage })));
    await client.complete(makeRequest());

    const architect = collector.build().phases.find((p) => p.phase === 'architect')!;
    assert.equal(architect.tokensCacheCreation, 777, 'tokensCacheCreation maps to cacheCreationTokens');
    assert.equal(architect.tokensCached, 0, 'tokensCached maps to cacheReadTokens');
  });

  it('inputTokens is treated as uncached (separate from cacheReadTokens and cacheCreationTokens)', async () => {
    const usage: LLMUsage = {
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
      requestCount: 1,
      costUsd: 0,
    };
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('analyst');

    const client = instrumentLLMClient(makeFakeClient(makeResponse({ usage })));
    await client.complete(makeRequest());

    const analyst = collector.build().phases.find((p) => p.phase === 'analyst')!;
    // inputTokens is its own field — not merged into cached counts
    assert.equal(analyst.tokensInput, 500);
    assert.equal(analyst.tokensCached, 200);
    assert.equal(analyst.tokensCacheCreation, 50);
  });

  it('billedTokens reconciles for all-zeros usage', async () => {
    const usage: LLMUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requestCount: 1,
      costUsd: 0,
    };
    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('gate');

    const client = instrumentLLMClient(makeFakeClient(makeResponse({ usage })));
    await client.complete(makeRequest());

    const gate = collector.build().phases.find((p) => p.phase === 'gate')!;
    assert.equal(gate.billedTokens, 0);
  });
});

// ─── fail-open (swallow) ──────────────────────────────────────────────────────

describe('instrumentLLMClient — fail-open behavior', () => {
  it('complete() returns res unchanged even when the collector throws', async () => {
    const throwingCollector: RunMetricsCollector = new RunMetricsCollector();
    // Override addUsage to throw
    (throwingCollector as unknown as Record<string, unknown>)['addUsage'] = () => {
      throw new Error('collector exploded');
    };
    bindActiveCollector(throwingCollector);

    const expected = makeResponse();
    const client = instrumentLLMClient(makeFakeClient(expected));
    let actual: LLMResponse | undefined;
    await assert.doesNotReject(async () => {
      actual = await client.complete(makeRequest());
    }, 'complete() must not reject when the reporter throws');
    assert.strictEqual(actual, expected, 'response must be the same object despite the throw');
  });
});

// ─── no-secrets assertion ─────────────────────────────────────────────────────

describe('instrumentLLMClient — no-secrets assertion', () => {
  it('report callback does not read req.system, req.messages, or res.text', async () => {
    const accessedFields: string[] = [];

    // Proxy the request to detect field access
    const req: LLMRequest = new Proxy(makeRequest(), {
      get(target, prop, receiver) {
        if (prop === 'system' || prop === 'messages') {
          accessedFields.push(String(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    // Proxy the response to detect field access
    const baseRes = makeResponse();
    const proxiedRes: LLMResponse = new Proxy(baseRes, {
      get(target, prop, receiver) {
        if (prop === 'text') {
          accessedFields.push('res.text');
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const fakeClient: LLMClient = {
      async complete(_r) {
        return proxiedRes;
      },
    };

    const collector = new RunMetricsCollector();
    bindActiveCollector(collector);
    collector.startPhase('analyst');

    const client = instrumentLLMClient(fakeClient);
    await client.complete(req);

    // The decorator must only read res.usage and res.model — never req.system, req.messages, or res.text
    assert.ok(!accessedFields.includes('system'), 'must not read req.system');
    assert.ok(!accessedFields.includes('messages'), 'must not read req.messages');
    assert.ok(!accessedFields.includes('res.text'), 'must not read res.text');
  });
});
