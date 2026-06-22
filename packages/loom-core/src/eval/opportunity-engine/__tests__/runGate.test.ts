import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { runOpportunityEngineGate } from '../runGate.js';
import { loadOpportunityEngineCases } from '../loadCases.js';
import { DEFAULT_GATE_MODEL, resolveOpportunityEngineModels } from '../models.js';
import type { OpportunityEngineCase } from '../caseSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<OpportunityEngineCase> = {}): OpportunityEngineCase {
  return {
    id: 'test-001',
    source: 'separable',
    signals: [
      { key: 'sig-a', source: 'code-debt', kind: 'todo', title: 'Fix auth validation' },
      { key: 'sig-b', source: 'github-issues', kind: 'github_issue', title: 'DB slow query' },
      { key: 'sig-c', source: 'audit-introspection', kind: 'work_failure_cluster', title: 'Session fixation risk' },
    ],
    rubric: {
      expected_themes: ['auth', 'performance'],
      force_clustering_traps: ['auth and DB performance are different domains'],
    },
    rationale: 'Test case for runGate',
    ...overrides,
  };
}

function clusterJson(signalIds: number[]): string {
  return JSON.stringify([{
    title: 'Grouped cluster',
    signal_ids: signalIds,
    impact: 0.7,
    effort: 0.5,
    confidence: 0.8,
    rationale: 'Test rationale',
  }]);
}

// ── Observe-only / ephemeral db (NFR-1, AC4) ─────────────────────────────────

describe('runOpportunityEngineGate — observe-only (NFR-1, AC4)', () => {
  it('returns a valid GateOutcome without requiring operator state or filesystem setup', async () => {
    // No projectRoot or loomdir passed — the gate is self-contained with :memory: db.
    const llm = new MockLLMClient(['[]']);
    const c = makeCase();

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.ok(result.status === 'ok' || result.status === 'failed',
      'must return a GateOutcome, never throw');
    assert.equal(result.status, 'ok');
  });

  it('each call produces an independent result — no shared state between cases', async () => {
    // Per-case isolation: two consecutive calls with identical signals produce
    // independent outputs (each case opens a fresh :memory: db — ADR-002).
    const c1 = makeCase({ id: 'test-iso-001' });
    const c2 = makeCase({ id: 'test-iso-002' });

    const llm = new MockLLMClient((req) => {
      // Return one cluster claiming all signals
      const ids = [1, 2, 3];
      return clusterJson(ids);
    });

    const [r1, r2] = await Promise.all([
      runOpportunityEngineGate(c1, { llm: llm as LLMClient, gateModel: 'g' }),
      runOpportunityEngineGate(c2, { llm: llm as LLMClient, gateModel: 'g' }),
    ]);

    assert.equal(r1.status, 'ok', 'first case must succeed');
    assert.equal(r2.status, 'ok', 'second case must succeed independently');
  });
});

// ── Drives the real engine (AC1, AC4) ─────────────────────────────────────────

describe('runOpportunityEngineGate — drives real OpportunityEngine (AC1, AC4)', () => {
  it('maps c.signals to batch-local ids (1..n) in the LLM user prompt', async () => {
    const c = makeCase();
    let capturedPrompt = '';
    const llm = new MockLLMClient((req) => {
      capturedPrompt = req.messages[0].content as string;
      return '[]';
    });

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.ok(capturedPrompt.includes('id=1'), 'first signal must get id=1');
    assert.ok(capturedPrompt.includes('id=2'), 'second signal must get id=2');
    assert.ok(capturedPrompt.includes('id=3'), 'third signal must get id=3');
    assert.ok(capturedPrompt.includes('sig-a'), 'signal key must appear in prompt');
    assert.ok(capturedPrompt.includes('sig-b'), 'signal key must appear in prompt');
  });

  it('returns { status: ok, output: OpportunityRecord[] } when engine produces clusters', async () => {
    const c = makeCase();
    const llm = new MockLLMClient([clusterJson([1, 2, 3])]);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.length, 1, 'engine must return one cluster');
    assert.deepEqual(
      result.output[0].member_keys.sort(),
      ['sig-a', 'sig-b', 'sig-c'].sort(),
      'member_keys must be the durable signal.key strings (ADR-005)',
    );
  });

  it('returns { status: ok, output: [] } when engine returns no clusters', async () => {
    const c = makeCase();
    const llm = new MockLLMClient(['[]']);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.output, []);
  });

  it('exercises the JSON-repair path structurally — real engine handles both responses', async () => {
    // The repair path is exercised by running the real engine with an invalid first
    // response. Deterministic coverage is story-042-006's job (AC2); this test
    // just confirms the gate survives the repair scenario without throwing.
    const c = makeCase();
    const llm = new MockLLMClient([
      'not valid json',
      clusterJson([1]),
    ]);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(result.status, 'ok', 'gate must survive the repair path without failing');
    assert.equal(llm.requests.length, 2, 'engine should make exactly 2 calls (initial + repair)');
  });
});

// ── All cases — one outcome per case (AC1) ───────────────────────────────────

describe('runOpportunityEngineGate — all cases produce one outcome (AC1)', () => {
  it('produces one GateOutcome per case for the full fixture case set', async () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.length > 0, 'fixture must have at least one case');

    // Responder always returns an empty array — exercises the adapter over every case.
    const llm = new MockLLMClient(() => '[]');

    const outcomes = await Promise.all(
      cases.map((c) =>
        runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: DEFAULT_GATE_MODEL }),
      ),
    );

    assert.equal(outcomes.length, cases.length, 'must produce exactly one outcome per case');
    for (const [i, outcome] of outcomes.entries()) {
      assert.ok(
        outcome.status === 'ok' || outcome.status === 'failed',
        `case[${i}] must return a GateOutcome`,
      );
    }
  });
});

// ── Gate-failure path ─────────────────────────────────────────────────────────

describe('runOpportunityEngineGate — failure path', () => {
  it('returns { status: failed, detail } when the LLM throws (not swallowed)', async () => {
    const c = makeCase();
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('simulated LLM outage'); },
    };

    const result = await runOpportunityEngineGate(c, { llm: throwingLLM, gateModel: 'g' });

    assert.equal(result.status, 'failed', 'LLM throw must become { status: failed }');
    if (result.status !== 'failed') return;
    assert.ok(result.detail.includes('LLM outage'), `detail: ${result.detail}`);
  });

  it('never throws — always returns ok or failed', async () => {
    const c = makeCase();
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('total failure'); },
    };

    let threw = false;
    try {
      await runOpportunityEngineGate(c, { llm: throwingLLM, gateModel: 'g' });
    } catch {
      threw = true;
    }

    assert.ok(!threw, 'gate must never throw past the boundary');
  });

  it('detail is String(e) of the thrown error', async () => {
    const c = makeCase();
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('specific failure message'); },
    };

    const result = await runOpportunityEngineGate(c, { llm: throwingLLM, gateModel: 'g' });

    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
    assert.ok(result.detail.includes('specific failure message'));
  });
});

// ── Model selection (AC3) ─────────────────────────────────────────────────────

describe('runOpportunityEngineGate — model selection (AC3)', () => {
  it('DEFAULT_GATE_MODEL is claude-haiku-4-5-20251001 (safe default)', () => {
    assert.equal(DEFAULT_GATE_MODEL, 'claude-haiku-4-5-20251001');
  });

  it('LOOM_EVAL_GATE_MODEL env var overrides the default via resolveOpportunityEngineModels', () => {
    const saved = process.env.LOOM_EVAL_GATE_MODEL;
    try {
      process.env.LOOM_EVAL_GATE_MODEL = 'env-override-model';
      const { gateModel } = resolveOpportunityEngineModels();
      assert.equal(gateModel, 'env-override-model');
    } finally {
      if (saved === undefined) {
        delete process.env.LOOM_EVAL_GATE_MODEL;
      } else {
        process.env.LOOM_EVAL_GATE_MODEL = saved;
      }
    }
  });

  it('deps.gateModel is forwarded to the engine — LLM call uses the provided model', async () => {
    const c = makeCase();
    const specificModel = 'claude-sonnet-eval-probe-xyz';
    const llm = new MockLLMClient(['[]']);

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: specificModel });

    assert.equal(llm.requests.length, 1, 'must have made one LLM call');
    assert.equal(llm.requests[0].model, specificModel,
      'LLM must be called with the exact gateModel from deps');
  });

  it('does not read LOOM_EVAL_GATE_MODEL itself — model is resolved upstream', async () => {
    // The gate adapter receives an already-resolved model via deps; it must NOT
    // read env vars internally. Verify by passing one model in deps while env
    // has a different value — the deps model must win.
    const saved = process.env.LOOM_EVAL_GATE_MODEL;
    try {
      process.env.LOOM_EVAL_GATE_MODEL = 'env-model-should-be-ignored';
      const c = makeCase();
      const depsModel = 'deps-resolved-model';
      const llm = new MockLLMClient(['[]']);

      await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: depsModel });

      assert.equal(llm.requests[0].model, depsModel,
        'gate must use deps.gateModel, not the env var');
    } finally {
      if (saved === undefined) {
        delete process.env.LOOM_EVAL_GATE_MODEL;
      } else {
        process.env.LOOM_EVAL_GATE_MODEL = saved;
      }
    }
  });
});
