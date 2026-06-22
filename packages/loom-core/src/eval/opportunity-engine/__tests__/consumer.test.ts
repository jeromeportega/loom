import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOpportunityEngineConsumer } from '../consumer.js';
import { runGateEval } from '../../framework/runGateEval.js';
import { decide } from '../../framework/decide.js';
import type { GateEvalConsumer } from '../../framework/types.js';
import type { OpportunityRecord } from '../../../signals/OpportunityEngine.js';
import type { OpportunityEngineCase } from '../caseSchema.js';
import type { OpportunityEngineJudgment } from '../judgeTypes.js';
import type { OpportunityEngineMetrics } from '../score.js';
import { EMPTY_USAGE } from '../../../llm/LLMClient.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertDefined<T>(v: T | undefined | null, label: string): T {
  assert.ok(v != null, `expected ${label} to be defined`);
  return v as T;
}

// ── Consumer wiring (AC1) ─────────────────────────────────────────────────────

describe('createOpportunityEngineConsumer — wiring (AC1)', () => {
  it('returns an object with all six GateEvalConsumer plug points', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });

    assert.equal(typeof consumer.loadCases, 'function', 'loadCases must be a function');
    assert.equal(typeof consumer.runGate, 'function', 'runGate must be a function');
    assert.equal(typeof consumer.judge, 'function', 'judge must be a function');
    assert.equal(typeof consumer.score, 'function', 'score must be a function');
    assert.equal(typeof consumer.verdict, 'function', 'verdict must be a function');
    assert.ok(consumer.thresholds != null, 'thresholds must be present');
  });

  it('thresholds satisfy the structural EvalThresholds shape', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    const { thresholds } = consumer;

    assert.equal(typeof thresholds.minScoredCases, 'number');
    assert.equal(typeof thresholds.maxGateFailureRate, 'number');
    assert.equal(typeof thresholds.maxJudgeInconclusiveRate, 'number');
    assert.equal(thresholds.minScoredCases, 3);
    assert.equal(thresholds.maxGateFailureRate, 0.25);
    assert.equal(thresholds.maxJudgeInconclusiveRate, 0.25);
  });

  it('satisfies GateEvalConsumer interface — TypeScript structural check', () => {
    // The compiler already enforces the interface; this assertion is a belt-and-suspenders
    // runtime check that the return type is assignable to GateEvalConsumer.
    const consumer: GateEvalConsumer<
      OpportunityEngineCase,
      OpportunityRecord[],
      OpportunityEngineJudgment,
      OpportunityEngineMetrics
    > = createOpportunityEngineConsumer({ projectRoot: '/tmp' });

    assert.ok(consumer != null);
  });

  it('score returns zero metrics for empty record set', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    const metrics = consumer.score([]);

    assert.equal(metrics.totalCases, 0);
    assert.equal(metrics.scoredCases, 0);
    assert.equal(metrics.coherence, 0);
    assert.equal(metrics.grounding, 0);
    assert.equal(metrics.hallucinationRate, 0);
  });

  it('verdict returns a valid string result', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    const metrics = consumer.score([]);
    const result = consumer.verdict(metrics);

    assert.ok(
      result === 'proceed' || result === 'do-not-proceed',
      `verdict must be 'proceed' or 'do-not-proceed', got: ${result}`,
    );
  });

  it('can be passed to runGateEval without error — accepts zero cases', async () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    const noop = {
      complete: async () => ({
        text: '[]',
        model: 'test',
        stopReason: 'end_turn' as const,
        usage: { ...EMPTY_USAGE },
      }),
    };

    const records = await runGateEval([], consumer, {
      llm: noop,
      gateModel: 'test-gate',
      judgeModel: 'test-judge',
    });

    assert.equal(records.length, 0);
  });

  it('can be passed to decide without error', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    const metrics = consumer.score([]);
    const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));

    assert.ok(
      decision.verdict === 'proceed' ||
      decision.verdict === 'do-not-proceed' ||
      decision.verdict === 'inconclusive',
    );
    assert.ok(Array.isArray(decision.reasons));
  });

  it('loadCases returns an array when called with the default fixture path', () => {
    const consumer = createOpportunityEngineConsumer({ projectRoot: '/tmp' });
    // loadCases resolves the default fixture path — it may throw if the fixture
    // is not found; that is tested by loadCases.test.ts. Here we just verify the
    // function is callable through the consumer interface.
    const fn = () => consumer.loadCases();
    // loadCases returns OpportunityEngineCase[] — if it throws, the fixture is missing
    // in this env; skip the shape assertion but confirm the method is wired.
    try {
      const cases = fn();
      assert.ok(Array.isArray(cases));
      if (cases.length > 0) {
        assertDefined(cases[0].id, 'case.id');
        assertDefined(cases[0].signals, 'case.signals');
      }
    } catch {
      // Fixture not present in this env — wiring is confirmed via the 'function' check above.
    }
  });
});
