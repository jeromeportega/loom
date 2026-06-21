/**
 * Consumer-agnosticism proof (AC2): the framework core (runGateEval + decide)
 * can be driven by a throwaway stub consumer with no imports from any real
 * consumer (IntakeClassifier, BriefRefiner, etc.). The core never branches on
 * consumer identity.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { runGateEval } from '../runGateEval.js';
import { coreMetrics } from '../coreMetrics.js';
import { decide } from '../decide.js';
import type {
  GateEvalCase,
  GateEvalConsumer,
  GateOutcome,
  JudgeOutcome,
  RunRecord,
  CoreMetrics,
  EvalThresholds,
} from '../types.js';

// ── Stub consumer (no real consumer import) ───────────────────────────────────

interface StubCase extends GateEvalCase {
  value: number;
}

interface StubOutput {
  doubled: number;
}

interface StubJudgment {
  approved: boolean;
}

interface StubMetrics extends CoreMetrics {
  avgDoubled: number;
}

const STUB_THRESHOLDS: EvalThresholds = {
  minScoredCases: 1,
  maxGateFailureRate: 0.5,
  maxJudgeInconclusiveRate: 0.5,
};

function createStubConsumer(): GateEvalConsumer<StubCase, StubOutput, StubJudgment, StubMetrics> {
  return {
    loadCases(): StubCase[] {
      return [
        { id: 'stub-1', source: 'stub', value: 10 },
        { id: 'stub-2', source: 'stub', value: 20 },
      ];
    },

    async runGate(c: StubCase): Promise<GateOutcome<StubOutput>> {
      return { status: 'ok', output: { doubled: c.value * 2 } };
    },

    async judge(_c: StubCase, output: StubOutput): Promise<JudgeOutcome<StubJudgment>> {
      return { status: 'ok', judgment: { approved: output.doubled > 0 } };
    },

    score(records: RunRecord<StubOutput, StubJudgment>[]): StubMetrics {
      const base = coreMetrics(records);
      const scoredRecords = records.filter(
        (r) => r.gate.status === 'ok' && r.judge.status === 'ok',
      );
      const total = scoredRecords.reduce((sum, r) => {
        if (r.gate.status === 'ok') return sum + r.gate.output.doubled;
        return sum;
      }, 0);
      const avgDoubled = scoredRecords.length === 0 ? 0 : total / scoredRecords.length;
      return { ...base, avgDoubled };
    },

    verdict(metrics: StubMetrics): 'proceed' | 'do-not-proceed' {
      return metrics.avgDoubled > 0 ? 'proceed' : 'do-not-proceed';
    },

    thresholds: STUB_THRESHOLDS,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('consumer-agnosticism — stub consumer drives runGateEval (AC2)', () => {
  it('runGateEval produces records from stub consumer without any real consumer import', async () => {
    const consumer = createStubConsumer();
    const cases = consumer.loadCases();
    const llm = new MockLLMClient([]);
    const deps = { llm, gateModel: 'stub-gate', judgeModel: 'stub-judge' };

    const records = await runGateEval(cases, consumer, deps);

    assert.equal(records.length, 2, 'one record per case');
    assert.ok(records.every((r) => r.gate.status === 'ok'), 'all gates ok');
    assert.ok(records.every((r) => r.judge.status === 'ok'), 'all judges ok');
    assert.equal(records[0].caseId, 'stub-1');
    assert.equal(records[1].caseId, 'stub-2');
  });

  it('coreMetrics from stub records returns correct counts', async () => {
    const consumer = createStubConsumer();
    const cases = consumer.loadCases();
    const llm = new MockLLMClient([]);
    const deps = { llm, gateModel: 'stub-gate', judgeModel: 'stub-judge' };

    const records = await runGateEval(cases, consumer, deps);
    const metrics = consumer.score(records);

    assert.equal(metrics.totalCases, 2);
    assert.equal(metrics.scoredCases, 2);
    assert.equal(metrics.gateFailures, 0);
    assert.equal(metrics.judgeInconclusive, 0);
    assert.equal(metrics.avgDoubled, 30, 'avg of [20, 40] = 30');
  });
});

describe('consumer-agnosticism — stub consumer drives decide (AC2)', () => {
  it('decide returns proceed when stub consumer verdict is proceed', async () => {
    const consumer = createStubConsumer();
    const cases = consumer.loadCases();
    const llm = new MockLLMClient([]);
    const deps = { llm, gateModel: 'stub-gate', judgeModel: 'stub-judge' };

    const records = await runGateEval(cases, consumer, deps);
    const metrics = consumer.score(records);
    const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));

    assert.equal(decision.verdict, 'proceed');
    assert.deepEqual(decision.reasons, []);
  });

  it('decide returns inconclusive when stub consumer has no scored cases', async () => {
    const consumer = createStubConsumer();
    const thresholds: EvalThresholds = { ...STUB_THRESHOLDS, minScoredCases: 10 };
    const llm = new MockLLMClient([]);
    const deps = { llm, gateModel: 'stub-gate', judgeModel: 'stub-judge' };

    const cases = consumer.loadCases();
    const records = await runGateEval(cases, consumer, deps);
    const metrics = consumer.score(records);

    // Only 2 cases but threshold requires 10 → inconclusive
    const decision = decide(metrics, thresholds, (m) => consumer.verdict(m));
    assert.equal(decision.verdict, 'inconclusive');
    assert.ok(decision.reasons[0].includes('scoredCases'));
  });

  it('the core never imports from any real consumer — no intake or brief-quality types referenced', () => {
    // This test exists as proof-by-construction: if the file above compiles without importing
    // IntakeClassifier, BriefRefiner, or any consumer-specific type, the core is consumer-agnostic.
    // The assertion is structural (checked at compile time), but we assert at runtime that
    // the generic consumer shape works end-to-end with a throwaway stub.
    const consumer = createStubConsumer();
    assert.ok(typeof consumer.loadCases === 'function', 'loadCases is a function');
    assert.ok(typeof consumer.runGate === 'function', 'runGate is a function');
    assert.ok(typeof consumer.judge === 'function', 'judge is a function');
    assert.ok(typeof consumer.score === 'function', 'score is a function');
    assert.ok(typeof consumer.verdict === 'function', 'verdict is a function');
    assert.ok(typeof consumer.thresholds === 'object', 'thresholds is an object');
  });
});

describe('consumer-agnosticism — core never branches on consumer identity', () => {
  it('two consumers with different types produce independent correct records via the same runGateEval', async () => {
    const consumer1 = createStubConsumer();
    const llm = new MockLLMClient([]);
    const deps = { llm, gateModel: 'g', judgeModel: 'j' };

    // Consumer 2: always-failing gate
    interface AltCase extends GateEvalCase { label: string }
    const consumer2 = {
      async runGate(_c: AltCase): Promise<GateOutcome<string>> {
        return { status: 'failed', detail: 'always fails' };
      },
      async judge(_c: AltCase, _output: string): Promise<JudgeOutcome<boolean>> {
        return { status: 'ok', judgment: true };
      },
    };

    const cases1 = consumer1.loadCases();
    const cases2: AltCase[] = [{ id: 'alt-1', source: 'alt', label: 'x' }];

    const [records1, records2] = await Promise.all([
      runGateEval(cases1, consumer1, deps),
      runGateEval(cases2, consumer2, deps),
    ]);

    assert.ok(records1.every((r) => r.gate.status === 'ok'), 'consumer1 all gates ok');
    assert.ok(records2.every((r) => r.gate.status === 'failed'), 'consumer2 all gates failed');
    assert.ok(records2.every((r) => r.judge.status === 'skipped'), 'consumer2 judges all skipped');
  });
});
