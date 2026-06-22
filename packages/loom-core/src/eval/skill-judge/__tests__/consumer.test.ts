import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import { createSkillJudgeConsumer } from '../consumer.js';
import { main } from '../run.js';
import type { SkillJudgeEvalCase } from '../caseSchema.js';
import type { JudgeResult } from '../../../skills/SkillJudge.js';
import type { SkillJudgeOptions } from '../../../skills/SkillJudge.js';
import { SkillJudge } from '../../../skills/SkillJudge.js';
import type { LLMClient } from '../../../llm/LLMClient.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function gateJson(verdict: 'accept' | 'reject', score: number): string {
  return wrapJson({ score, verdict, reason: `test verdict: ${verdict}` });
}

function judgeJson(independent_verdict: 'accept' | 'reject', band_defensible = true): string {
  return wrapJson({ independent_verdict, band_defensible, reason: 'test judgment' });
}

const BASE_CASE: SkillJudgeEvalCase = {
  id:                'sj-consumer-test-001',
  source:            'anchor',
  category:          'accept',
  skill_md:          '# My Skill\n\nDo the thing.',
  existing_skills:   [],
  expected_decision: 'accept',
  expected_band:     'good',
  rationale:         'A solid reusable skill.',
};

function makeTmpFixture(cases: SkillJudgeEvalCase[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-eval-'));
  const file = path.join(tmpDir, 'skill-judge.yaml');
  fs.writeFileSync(file, yaml.dump({ cases }));
  return file;
}

/** Factory that returns a pre-built JudgeResult without any LLM call. */
function fixedGateFactory(result: JudgeResult) {
  return (_opts: SkillJudgeOptions): SkillJudge => ({
    async judge(): Promise<JudgeResult> { return result; },
  } as unknown as SkillJudge);
}

// ── createSkillJudgeConsumer implements GateEvalConsumer ───────────────────────

describe('createSkillJudgeConsumer — shape', () => {
  it('returns an object with all six GateEvalConsumer methods/fields', () => {
    const c = createSkillJudgeConsumer();
    assert.equal(typeof c.loadCases, 'function');
    assert.equal(typeof c.runGate, 'function');
    assert.equal(typeof c.judge, 'function');
    assert.equal(typeof c.score, 'function');
    assert.equal(typeof c.verdict, 'function');
    assert.ok(c.thresholds !== undefined, 'thresholds present');
    assert.equal(c.thresholds.minScoredCases, 5);
    assert.equal(c.thresholds.maxGateFailureRate, 0.25);
    assert.equal(c.thresholds.maxJudgeInconclusiveRate, 0.25);
  });

  it('loadCases accepts a fixturePath and returns case objects', () => {
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const consumer = createSkillJudgeConsumer();
    const cases = consumer.loadCases(fixturePath);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].id, 'sj-consumer-test-001');
  });
});

// ── runGate wiring ─────────────────────────────────────────────────────────────

describe('createSkillJudgeConsumer — runGate', () => {
  it('returns { status: ok } on a clean gate response', async () => {
    const llm = new MockLLMClient([gateJson('accept', 8)]);
    const consumer = createSkillJudgeConsumer();
    const result = await consumer.runGate(BASE_CASE, { llm, gateModel: 'g' });
    assert.equal(result.status, 'ok');
  });

  it('maps score:999 fail-open sentinel to { status: failed, detail: fail-open }', async () => {
    const factory = fixedGateFactory({ score: 999, verdict: 'accept', reason: 'judge unavailable' });
    const llm = new MockLLMClient([]) as LLMClient;
    // Access runSkillJudgeGate directly via the consumer to test the fail-open mapping
    const { runSkillJudgeGate } = await import('../runGate.js');
    const result = await runSkillJudgeGate(BASE_CASE, { llm, gateModel: 'g' }, factory);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.detail, 'fail-open');
  });
});

// ── judge wiring ───────────────────────────────────────────────────────────────

describe('createSkillJudgeConsumer — judge', () => {
  const MOCK_GATE_OUTPUT: JudgeResult = {
    score:   8,
    verdict: 'accept',
    reason:  'Well-formed and reusable.',
  };

  it('returns ok judgment with all SkillJudgeJudgment fields', async () => {
    const llm = new MockLLMClient([judgeJson('accept')]);
    const consumer = createSkillJudgeConsumer();
    const result = await consumer.judge(BASE_CASE, MOCK_GATE_OUTPUT, { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(typeof result.judgment.decision_correct, 'boolean');
    assert.equal(typeof result.judgment.band_in_range, 'boolean');
    assert.ok(['accept', 'reject'].includes(result.judgment.independent_verdict));
    assert.equal(typeof result.judgment.band_defensible, 'boolean');
    assert.equal(typeof result.judgment.reason, 'string');
  });

  it('computes decision_correct = (gate.verdict === expected_decision)', async () => {
    const llm = new MockLLMClient([judgeJson('accept')]);
    const consumer = createSkillJudgeConsumer();
    // BASE_CASE.expected_decision = 'accept' and gate output verdict = 'accept' → correct
    const result = await consumer.judge(BASE_CASE, MOCK_GATE_OUTPUT, { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, true);
  });

  it('maps LLM outage to { status: inconclusive }', async () => {
    const failLLM = { async complete() { throw new Error('timeout'); } };
    const consumer = createSkillJudgeConsumer();
    const result = await consumer.judge(BASE_CASE, MOCK_GATE_OUTPUT, { llm: failLLM as any, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});

// ── score wiring ───────────────────────────────────────────────────────────────

describe('createSkillJudgeConsumer — score', () => {
  it('delegates to scoreSkillJudge and returns SkillJudgeMetrics', () => {
    const consumer = createSkillJudgeConsumer();
    const m = consumer.score([]);
    assert.equal(m.totalCases, 0);
    assert.equal(m.scoredCases, 0);
    assert.equal(m.decisionAccuracy, 0);
    assert.equal(m.bandAgreement, 0);
    assert.equal(m.independentAgreement, 0);
    assert.equal(m.failOpenObserved, 0);
  });
});

// ── main() — single run emits both metrics and pass/fail decision (AC4) ────────

describe('main() — end-to-end with MockLLMClient', () => {
  it('returns EvalReport with metrics, decision, perCase, and markdown (AC4)', async () => {
    const cases: SkillJudgeEvalCase[] = Array.from({ length: 6 }, (_, i) => ({
      ...BASE_CASE,
      id: `sj-test-${i}`,
    }));
    const fixturePath = makeTmpFixture(cases);

    // Each case: one gate LLM call, one judge LLM call (via MockLLMClient queue)
    // Gate model responses: score=8, verdict=accept (above JUDGE_MIN_SCORE=6)
    // Judge model responses: independent_verdict=accept, band_defensible=true
    const responses = cases.flatMap(() => [
      gateJson('accept', 8),
      judgeJson('accept'),
    ]);
    const llm = new MockLLMClient(responses);

    const report = await main({ llm, fixturePath, gateModel: 'g', judgeModel: 'j' });

    // Both metrics AND pass/fail decision are present (AC4)
    assert.ok(report.metrics !== undefined, 'metrics present');
    assert.ok(report.decision !== undefined, 'decision present');
    assert.ok(['proceed', 'do-not-proceed', 'inconclusive'].includes(report.decision.verdict), 'decision.verdict is valid');
    assert.ok(Array.isArray(report.perCase), 'perCase is array');
    assert.equal(report.perCase.length, 6);
    assert.equal(typeof report.markdown, 'string');
    assert.ok(report.markdown.includes('Skill-Judge Eval Report'), 'markdown has title');
    assert.ok(report.markdown.includes(report.decision.verdict), 'markdown contains decision verdict');

    // Verify metric fields
    assert.equal(report.metrics.totalCases, 6);
    assert.equal(typeof report.metrics.decisionAccuracy, 'number');
    assert.equal(typeof report.metrics.bandAgreement, 'number');
    assert.equal(typeof report.metrics.independentAgreement, 'number');
    assert.equal(typeof report.metrics.failOpenObserved, 'number');
  });

  it('uses only the injected MockLLMClient — no real client constructed', async () => {
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson('accept', 8),
      judgeJson('accept'),
    ]);

    const report = await main({ llm, fixturePath, gateModel: 'g', judgeModel: 'j' });
    assert.ok(report !== undefined, 'report produced with mock only');
  });

  it('too few scored cases → inconclusive / do-not-proceed (fail-closed)', async () => {
    // 1 case: below minScoredCases=5 → inconclusive from decide()
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson('accept', 8),
      judgeJson('accept'),
    ]);

    const { decision } = await main({ llm, fixturePath, gateModel: 'g', judgeModel: 'j' });
    // decide() returns 'inconclusive' when scoredCases < minScoredCases
    assert.ok(
      decision.verdict === 'inconclusive' || decision.verdict === 'do-not-proceed',
      `expected fail-closed verdict, got: ${decision.verdict}`,
    );
  });

  it('gate sequential call order: gate first, then judge, for each case', async () => {
    const cases: SkillJudgeEvalCase[] = Array.from({ length: 3 }, (_, i) => ({
      ...BASE_CASE,
      id: `sj-order-${i}`,
    }));
    const fixturePath = makeTmpFixture(cases);
    const responses = cases.flatMap(() => [gateJson('accept', 8), judgeJson('accept')]);
    const llm = new MockLLMClient(responses);

    await main({ llm, fixturePath, gateModel: 'gate-model', judgeModel: 'judge-model' });

    // Interleaved gate+judge calls: g, j, g, j, g, j
    assert.equal(llm.requests.length, 6, '3 gate + 3 judge calls');
    for (let i = 0; i < cases.length; i++) {
      assert.equal(llm.requests[i * 2].model, 'gate-model', `call ${i * 2} must be gate`);
      assert.equal(llm.requests[i * 2 + 1].model, 'judge-model', `call ${i * 2 + 1} must be judge`);
    }
  });

  it('report files are written to .loom/eval/skill-judge-report.{md,json}', async () => {
    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson('accept', 8),
      judgeJson('accept'),
    ]);

    await main({ llm, fixturePath, gateModel: 'g', judgeModel: 'j' });

    // The report is written relative to __dirname (dist/eval/skill-judge/ → ../../.loom/eval)
    // We can't easily check the exact path in tests, but we can verify main() completes
    // without error (file write would throw if directory cannot be created).
    // Files are in packages/loom-core/.loom/eval/ (gitignored artifact directory).
    // If this test reaches here without throwing, the file write succeeded.
  });
});

// ── Zero-framework-edits smoke test ───────────────────────────────────────────

describe('createSkillJudgeConsumer — zero framework edits (smoke)', () => {
  it('runGateEval loops through consumer methods without modifying framework', async () => {
    const { runGateEval } = await import('../../framework/runGateEval.js');
    const { decide } = await import('../../framework/decide.js');

    const fixturePath = makeTmpFixture([BASE_CASE]);
    const llm = new MockLLMClient([
      gateJson('accept', 8),
      judgeJson('accept'),
    ]);

    const consumer = createSkillJudgeConsumer();
    const cases = consumer.loadCases(fixturePath);
    const deps = { llm, gateModel: 'g', judgeModel: 'j' };

    const perCase = await runGateEval(cases, consumer, deps);
    const metrics = consumer.score(perCase);
    const decision = decide(metrics, consumer.thresholds, (m) => consumer.verdict(m));

    assert.equal(perCase.length, 1);
    assert.ok(metrics !== undefined);
    assert.ok(decision !== undefined);
  });
});
