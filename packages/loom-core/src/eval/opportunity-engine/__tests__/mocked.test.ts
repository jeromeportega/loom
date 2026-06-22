import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { loadOpportunityEngineCases } from '../loadCases.js';
import { runOpportunityEngineGate } from '../runGate.js';
import { judgeOpportunityClusters } from '../judge.js';
import { scoreOpportunityEngine, opportunityEngineVerdict, DEFAULT_QUALITY_BAR } from '../score.js';
import type { OpportunityEngineCase } from '../caseSchema.js';
import type { OpportunityEngineJudgment } from '../judgeTypes.js';
import type { RunRecord } from '../../framework/types.js';
import type { OpportunityRecord } from '../../../signals/OpportunityEngine.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCase(id = 'oe-mock-001'): OpportunityEngineCase {
  return {
    id,
    source: 'separable',
    signals: [
      { key: 'sig-a', source: 'code-debt', kind: 'todo', title: 'Auth validation gap' },
      { key: 'sig-b', source: 'github-issues', kind: 'github_issue', title: 'DB slow query' },
      { key: 'sig-c', source: 'audit-introspection', kind: 'work_failure_cluster', title: 'Session fixation risk' },
    ],
    rubric: {
      expected_themes: ['authentication', 'performance'],
      force_clustering_traps: ['auth and DB performance are different domains'],
    },
    rationale: 'Test case for mocked unit tests.',
  };
}

function clusterJson(signalIds: number[]): string {
  return JSON.stringify([{
    title: 'Mocked cluster',
    signal_ids: signalIds,
    impact: 0.7,
    effort: 0.5,
    confidence: 0.8,
    rationale: 'Mocked rationale for test.',
  }]);
}

function judgmentJson(overrides: Partial<{
  coherence: number;
  score_reasonableness: number;
  grounding: number;
  forced_clusters: number;
  invented_opportunities: number;
  reason: string;
}> = {}): string {
  const j = {
    coherence: 0.85,
    score_reasonableness: 0.75,
    grounding: 0.90,
    forced_clusters: 0,
    invented_opportunities: 0,
    reason: 'Clusters are well-formed and grounded.',
    ...overrides,
  };
  return '```json\n' + JSON.stringify(j) + '\n```';
}

// ── JSON-repair retry path (FR-8/ADR-005, AC2) ───────────────────────────────
// The engine makes exactly one repair re-prompt on parse failure (FR-10).
// The comment in runGate.test.ts line 127-130 deferred these deterministic
// assertions here.

describe('JSON-repair retry (FR-8/ADR-005) — malformed-then-valid sequence (AC2)', () => {
  it('clusters from the repair response are returned, not empty output', async () => {
    const c = makeCase();
    const llm = new MockLLMClient([
      'not valid json at all',  // first attempt — parse fails
      clusterJson([1, 2, 3]),   // repair response — all three signals
    ]);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(result.status, 'ok', 'gate must succeed after repair');
    if (result.status !== 'ok') return;
    assert.equal(result.output.length, 1, 'repair response must yield one cluster');
    assert.deepEqual(
      result.output[0].member_keys.sort(),
      ['sig-a', 'sig-b', 'sig-c'].sort(),
      'member_keys must be the durable signal keys resolved from the repair response (ADR-005)',
    );
  });

  it('exactly 2 LLM calls are made — initial plus exactly one repair, no more', async () => {
    const c = makeCase();
    const llm = new MockLLMClient([
      'not valid json',
      clusterJson([1]),
    ]);

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(llm.requests.length, 2, 'one initial call plus exactly one repair call');
  });

  it('repair request includes the original malformed text as assistant turn', async () => {
    const c = makeCase();
    const malformedText = 'definitely not valid json: { broken }';
    const llm = new MockLLMClient([malformedText, clusterJson([1])]);

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(llm.requests.length, 2);
    const repairMessages = llm.requests[1].messages;
    const assistantTurn = repairMessages.find((m) => m.role === 'assistant');
    assert.ok(assistantTurn, 'repair request must include an assistant turn carrying the malformed text');
    assert.equal(
      assistantTurn.content,
      malformedText,
      'the assistant turn in the repair request must match the original bad response verbatim',
    );
  });

  it('repair request user turn instructs the model to return only the JSON array', async () => {
    const c = makeCase();
    const llm = new MockLLMClient(['bad json', clusterJson([1])]);

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    const repairMessages = llm.requests[1].messages;
    const userTurns = repairMessages.filter((m) => m.role === 'user');
    const repairInstruction = userTurns[userTurns.length - 1].content as string;
    assert.ok(
      repairInstruction.toLowerCase().includes('json'),
      'repair instruction must mention JSON',
    );
    assert.ok(
      repairInstruction.toLowerCase().includes('array') || repairInstruction.toLowerCase().includes('only'),
      'repair instruction must tell the model to return only the JSON array',
    );
  });

  it('partial cluster from repair response: only valid signal_ids are used (FR-10)', async () => {
    // signal_ids [1, 4] — id 4 does not exist (case has only ids 1..3)
    const c = makeCase();
    const llm = new MockLLMClient([
      'bad json',
      clusterJson([1, 4]), // id 4 unknown — engine drops it; cluster has only sig-a
    ]);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.length, 1, 'one cluster returned');
    assert.deepEqual(
      result.output[0].member_keys,
      ['sig-a'],
      'only the valid signal id (1 → sig-a) must appear in member_keys',
    );
  });
});

// ── Both-attempts-fail boundary (AC2) ────────────────────────────────────────

describe('JSON-repair — both-attempts-fail boundary (AC2)', () => {
  it('gate returns {status:ok, output:[]} when both attempts produce unparseable JSON', async () => {
    const c = makeCase();
    const llm = new MockLLMClient([
      'not valid json — attempt 1',
      'also not valid json — attempt 2',
    ]);

    let threw = false;
    let result: Awaited<ReturnType<typeof runOpportunityEngineGate>> | undefined;
    try {
      result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });
    } catch {
      threw = true;
    }

    assert.ok(!threw, 'gate must never throw — not even when both repair attempts fail');
    assert.equal(result!.status, 'ok');
    if (result!.status !== 'ok') return;
    assert.deepEqual(result!.output, [], 'output is empty when both attempts fail');
  });

  it('exactly 2 LLM calls on double-failure — no extra retries beyond the one repair', async () => {
    const c = makeCase();
    const llm = new MockLLMClient(['garbage 1', 'garbage 2']);

    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(
      llm.requests.length,
      2,
      'must make exactly 2 calls — initial and repair — then give up',
    );
  });

  it('valid first response: 1 LLM call, repair never triggered', async () => {
    const c = makeCase();
    const llm = new MockLLMClient([clusterJson([1, 2])]);

    const result = await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });

    assert.equal(llm.requests.length, 1, 'no repair call when first response is valid');
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.length, 1, 'cluster from valid first response must be returned');
  });

  it('both-fail does not corrupt gate state: subsequent cases are unaffected', async () => {
    const c1 = makeCase('oe-fail-case');
    const c2 = makeCase('oe-ok-case');

    // c1 uses a shared mock that always fails; c2 gets a fresh mock that succeeds
    const failLlm = new MockLLMClient(['bad1', 'bad2']);
    const okLlm = new MockLLMClient([clusterJson([1])]);

    const r1 = await runOpportunityEngineGate(c1, { llm: failLlm as LLMClient, gateModel: 'g' });
    const r2 = await runOpportunityEngineGate(c2, { llm: okLlm as LLMClient, gateModel: 'g' });

    assert.equal(r1.status, 'ok');
    if (r1.status !== 'ok') return;
    assert.deepEqual(r1.output, [], 'c1 must yield empty output');

    assert.equal(r2.status, 'ok');
    if (r2.status !== 'ok') return;
    assert.equal(r2.output.length, 1, 'c2 must yield a cluster independent of c1 failure');
  });
});

// ── Case loader: ≥3 valid cases across all three source types (AC1) ──────────

describe('loadOpportunityEngineCases — all three sources present (AC1)', () => {
  it('returns ≥3 valid cases from the production fixture (deterministic, no model call)', () => {
    const cases = loadOpportunityEngineCases();
    assert.ok(cases.length >= 3, `expected ≥3 cases, got ${cases.length}`);
    assert.ok(cases.some((c) => c.source === 'separable'), 'must have at least one separable case');
    assert.ok(cases.some((c) => c.source === 'noise'), 'must have at least one noise case');
    assert.ok(cases.some((c) => c.source === 'mixed'), 'must have at least one mixed case');
  });
});

// ── Judge wiring: Zod validation and deterministic guard (AC1) ───────────────

describe('judgeOpportunityClusters — Zod validation and deterministic guard (AC1)', () => {
  it('Zod validation passes for well-formed judgment — returns {status:ok}', async () => {
    const c = makeCase();
    const output: OpportunityRecord[] = [];
    const llm = new MockLLMClient([judgmentJson()]);

    const result = await judgeOpportunityClusters(c, output, { llm: llm as LLMClient, judgeModel: 'j' });

    assert.equal(result.status, 'ok', 'well-formed judgment must pass Zod validation');
  });

  it('Zod validation fails (inconclusive) for off-schema output', async () => {
    const c = makeCase();
    const output: OpportunityRecord[] = [];
    // Return JSON with coherence out of [0,1] range — fails Zod .max(1)
    const llm = new MockLLMClient([judgmentJson({ coherence: 1.5 })]);

    const result = await judgeOpportunityClusters(c, output, { llm: llm as LLMClient, judgeModel: 'j' });

    assert.equal(result.status, 'inconclusive', 'off-schema judgment must yield inconclusive');
  });

  it('nonexistent_signal_ids is driven deterministically by member_keys ⊆ input keys, not LLM', async () => {
    const c = makeCase(); // input keys: sig-a, sig-b, sig-c
    // Output contains a phantom key not present in the case's signals
    const phantomOpp: OpportunityRecord = {
      id: 1, key: 'k', title: 'T', rationale: 'R',
      impact: 0.8, effort: 0.5, confidence: 0.9, score: 1.44, rank: 1,
      status: 'open', signal_count: 2, member_keys: ['sig-a', 'phantom-key'],
      evidence: [], scoped_epic_id: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };

    // Even if the LLM reports grounding=1.0 (no hallucinations), the guard catches it
    const llm = new MockLLMClient([judgmentJson({ grounding: 1.0 })]);

    const result = await judgeOpportunityClusters(c, [phantomOpp], { llm: llm as LLMClient, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(
      result.judgment.nonexistent_signal_ids,
      1,
      'guard must count the phantom key regardless of LLM grounding score',
    );
  });
});

// ── Scorer: known RunRecords → expected metrics and verdict (AC1) ─────────────

describe('scoreOpportunityEngine — known records → expected metrics and verdict (AC1)', () => {
  it('single scored record produces correct coherence, both rates, and proceed verdict', () => {
    const j: OpportunityEngineJudgment = {
      cluster_count: 2,
      coherence: 0.90,
      score_reasonableness: 0.80,
      grounding: 0.95,
      forced_clusters: 0,
      invented_opportunities: 0,
      nonexistent_signal_ids: 0,
      reason: 'test',
    };
    const record: RunRecord<OpportunityRecord[], OpportunityEngineJudgment> = {
      caseId: 'c1',
      gate: { status: 'ok', output: [] },
      judge: { status: 'ok', judgment: j },
    };

    const m = scoreOpportunityEngine([record]);

    assert.equal(m.totalCases, 1);
    assert.equal(m.scoredCases, 1);
    assert.equal(m.coherence, 0.90);
    assert.equal(m.scoreReasonableness, 0.80);
    assert.equal(m.grounding, 0.95);
    assert.equal(m.forcedClusteringRate, 0, 'no forced clusters → rate = 0');
    assert.equal(m.hallucinationRate, 0, 'no hallucinations → rate = 0');

    const verdict = opportunityEngineVerdict(m);
    assert.equal(verdict, 'proceed', 'metrics above all thresholds → proceed');
  });

  it('single-breach (coherence below minCoherence) → do-not-proceed', () => {
    const j: OpportunityEngineJudgment = {
      cluster_count: 2,
      coherence: DEFAULT_QUALITY_BAR.minCoherence - 0.01,  // just below bar
      score_reasonableness: 0.85,
      grounding: 0.95,
      forced_clusters: 0,
      invented_opportunities: 0,
      nonexistent_signal_ids: 0,
      reason: 'low coherence',
    };
    const record: RunRecord<OpportunityRecord[], OpportunityEngineJudgment> = {
      caseId: 'c-breach',
      gate: { status: 'ok', output: [] },
      judge: { status: 'ok', judgment: j },
    };

    const m = scoreOpportunityEngine([record]);
    const verdict = opportunityEngineVerdict(m);

    assert.equal(verdict, 'do-not-proceed', 'single coherence breach → do-not-proceed');
  });

  it('forced-clustering breach → do-not-proceed', () => {
    const clusterCount = 4;
    const j: OpportunityEngineJudgment = {
      cluster_count: clusterCount,
      coherence: 0.90,
      score_reasonableness: 0.80,
      grounding: 0.95,
      // forcedClusteringRate = forced_clusters / cluster_count = 2/4 = 0.5 > maxForcedClusteringRate (0.20)
      forced_clusters: 2,
      invented_opportunities: 0,
      nonexistent_signal_ids: 0,
      reason: 'two forced clusters',
    };
    const record: RunRecord<OpportunityRecord[], OpportunityEngineJudgment> = {
      caseId: 'c-forced',
      gate: { status: 'ok', output: [] },
      judge: { status: 'ok', judgment: j },
    };

    const m = scoreOpportunityEngine([record]);
    assert.ok(
      m.forcedClusteringRate > DEFAULT_QUALITY_BAR.maxForcedClusteringRate,
      'forcedClusteringRate must exceed the bar',
    );
    assert.equal(opportunityEngineVerdict(m), 'do-not-proceed');
  });
});

// ── End-to-end mocked pipeline (AC1, AC3) ────────────────────────────────────
// Exercises all four components (loader → gate → judge → scorer) with
// MockLLMClient exclusively — no real model calls (NFR-3).

describe('End-to-end mocked pipeline: loader → gate → judge → scorer (AC1, AC3)', () => {
  it('full pipeline with known mocked responses yields expected metrics and proceed verdict', async () => {
    const c = makeCase('oe-e2e-001');

    // Gate: returns one cluster grouping all three signals
    const gateLlm = new MockLLMClient([clusterJson([1, 2, 3])]);
    const gateResult = await runOpportunityEngineGate(c, {
      llm: gateLlm as LLMClient,
      gateModel: 'mock-gate',
    });
    assert.equal(gateResult.status, 'ok');
    if (gateResult.status !== 'ok') return;

    // Judge: returns well-formed judgment above all quality bar thresholds
    const judgeLlm = new MockLLMClient([judgmentJson({
      coherence: 0.90,
      score_reasonableness: 0.85,
      grounding: 0.95,
      forced_clusters: 0,
      invented_opportunities: 0,
    })]);
    const judgeResult = await judgeOpportunityClusters(c, gateResult.output, {
      llm: judgeLlm as LLMClient,
      judgeModel: 'mock-judge',
    });
    assert.equal(judgeResult.status, 'ok');
    if (judgeResult.status !== 'ok') return;

    // nonexistent_signal_ids must be 0: all member_keys are in input
    assert.equal(
      judgeResult.judgment.nonexistent_signal_ids,
      0,
      'no phantom keys when output member_keys ⊆ input signal keys',
    );

    const record: RunRecord<OpportunityRecord[], OpportunityEngineJudgment> = {
      caseId: c.id,
      gate: gateResult,
      judge: judgeResult,
    };

    const metrics = scoreOpportunityEngine([record]);
    assert.equal(metrics.totalCases, 1);
    assert.equal(metrics.scoredCases, 1);
    assert.equal(metrics.gateFailures, 0);
    assert.ok(metrics.coherence >= 0.90, 'coherence must reflect mocked judgment');
    assert.ok(metrics.grounding >= 0.95, 'grounding must reflect mocked judgment');
    assert.equal(metrics.forcedClusteringRate, 0);
    assert.equal(metrics.hallucinationRate, 0);

    assert.equal(opportunityEngineVerdict(metrics), 'proceed');

    // No real model calls were made: both LLM clients are MockLLMClient
    assert.ok(gateLlm instanceof MockLLMClient, 'gate LLM must be MockLLMClient');
    assert.ok(judgeLlm instanceof MockLLMClient, 'judge LLM must be MockLLMClient');
  });

  it('pipeline with repair path: gate uses repair response, judge and scorer proceed normally', async () => {
    const c = makeCase('oe-e2e-repair');

    // Gate: first response invalid, repair response returns one cluster
    const gateLlm = new MockLLMClient([
      'not valid json',
      clusterJson([1, 2]),  // repair yields sig-a + sig-b
    ]);
    const gateResult = await runOpportunityEngineGate(c, {
      llm: gateLlm as LLMClient,
      gateModel: 'mock-gate',
    });
    assert.equal(gateResult.status, 'ok');
    if (gateResult.status !== 'ok') return;
    assert.equal(gateResult.output.length, 1, 'repair response must yield one cluster');
    assert.equal(gateLlm.requests.length, 2, 'two LLM calls: initial + repair');

    // Judge: normal mocked judgment on the repaired output
    const judgeLlm = new MockLLMClient([judgmentJson()]);
    const judgeResult = await judgeOpportunityClusters(c, gateResult.output, {
      llm: judgeLlm as LLMClient,
      judgeModel: 'mock-judge',
    });
    assert.equal(judgeResult.status, 'ok');
    if (judgeResult.status !== 'ok') return;

    const record: RunRecord<OpportunityRecord[], OpportunityEngineJudgment> = {
      caseId: c.id,
      gate: gateResult,
      judge: judgeResult,
    };

    const metrics = scoreOpportunityEngine([record]);
    assert.equal(metrics.scoredCases, 1);
    assert.equal(opportunityEngineVerdict(metrics), 'proceed');
  });
});

// ── No real model calls (NFR-3, AC3) ─────────────────────────────────────────
// All tests above use MockLLMClient exclusively. This section makes the guarantee
// explicit and documents that the live eval is not run as a worker story.

describe('No real model calls (NFR-3, AC3)', () => {
  it('MockLLMClient throws when queue is exhausted — confirms no implicit SDK fallback', async () => {
    const llm = new MockLLMClient([]);  // empty queue
    let threw = false;
    try {
      await llm.complete({
        model: 'any-model',
        system: [],
        messages: [{ role: 'user', content: 'test' }],
        maxTokens: 16,
      });
    } catch (e) {
      threw = true;
      assert.ok(
        String(e).includes('no more scripted responses'),
        'exhausted MockLLMClient must throw, not fall back to real SDK',
      );
    }
    assert.ok(threw, 'MockLLMClient with empty queue must throw on complete()');
  });

  it('gate does not construct a real Anthropic SDK client — uses only deps.llm', async () => {
    // runOpportunityEngineGate takes deps.llm and forwards it to the engine.
    // If it constructed a real SDK client internally, it would ignore deps.llm
    // and our request count would not match. The existing call-count assertions
    // throughout this file confirm only deps.llm was used.
    const c = makeCase();
    const llm = new MockLLMClient([clusterJson([1])]);
    await runOpportunityEngineGate(c, { llm: llm as LLMClient, gateModel: 'g' });
    assert.equal(llm.requests.length, 1, 'exactly one request through the mock — no real client used');
  });

  it('judge does not construct a real Anthropic SDK client — uses only deps.llm', async () => {
    const c = makeCase();
    const output: OpportunityRecord[] = [];
    const llm = new MockLLMClient([judgmentJson()]);
    await judgeOpportunityClusters(c, output, { llm: llm as LLMClient, judgeModel: 'j' });
    assert.equal(llm.requests.length, 1, 'exactly one request through the mock — no real client used');
  });
});
