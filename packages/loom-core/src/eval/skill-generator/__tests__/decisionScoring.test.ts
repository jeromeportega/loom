/**
 * Deterministic mocked-LLM tests for the four FR-7 decision-scoring behaviours.
 *
 * Strategy (ADR-004): feed real `runSkillGeneratorGate` output into
 * `scoreSkillGenerator` — do NOT hand-attach `_eval`.  This exercises the
 * producer→scorer seam and prevents a recurrence of the original bug where
 * pure-scorer unit tests passed while the end-to-end seam was broken.
 *
 * All LLM/judge calls are mocked; no live network calls are made (NFR-1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { LLMClient, LLMRequest, LLMResponse } from '../../../llm/LLMClient.js';
import { EMPTY_USAGE } from '../../../llm/LLMClient.js';
import { runSkillGeneratorGate } from '../runGate.js';
import { judgeSkillGeneration } from '../judge.js';
import { scoreSkillGenerator } from '../score.js';
import type { SkillGeneratorGateOutput } from '../score.js';
import type { SkillGeneratorCase } from '../caseSchema.js';
import type { SkillGeneratorJudgment } from '../judgeTypes.js';
import type { RunRecord } from '../../framework/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const VALID_SKILL_MD = `---
name: loom-seam-test-skill
description: A test skill produced during decision-scoring seam tests
metadata:
  source: generated
  category: testing
---

# Seam Test Skill

When testing the gate→score seam, use mocked LLM responses to ensure
determinism and to confirm no live API calls are made (NFR-1).
`;

function makeCase(overrides: Partial<SkillGeneratorCase> = {}): SkillGeneratorCase {
  return {
    id:     'seam-test-001',
    source: 'worthy',
    work: {
      story: {
        id:                  'story-seam-001',
        title:               'Seam test story',
        description:         'Testing the gate→score seam.',
        acceptance_criteria: ['Gate attaches _eval', 'Score reads _eval correctly'],
      },
      summary:         'Implemented seam test.',
      diff_context:    '+const x = 1;\n// seam-test-diff-marker',
      existing_skills: [],
    },
    rubric: {
      expected_decision: 'generate',
      expected_themes:   ['isolation'],
      spurious_traps:    [],
    },
    rationale: 'Testing the producer→scorer seam.',
    ...overrides,
  };
}

/** FIFO mock LLM — same pattern as runGate.test.ts (shared test contract). */
function makeMockLLM(responses: string[]): LLMClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  let idx = 0;
  return {
    requests,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push(req);
      const text = responses[idx++];
      if (text === undefined) throw new Error('MockLLM: no more scripted responses');
      return { text, model: req.model, stopReason: 'end_turn', usage: { ...EMPTY_USAGE } };
    },
  };
}

/** LLM that asserts no call is made — used to enforce NFR-1 on NONE paths. */
function makeThrowingLLM(): LLMClient {
  return {
    async complete(): Promise<LLMResponse> {
      throw new Error('live LLM call forbidden in this test (NFR-1)');
    },
  };
}

/** Valid judge response matching LLMResponseSchema in judge.ts. */
function judgeJson(overrides: Partial<{
  well_formed: number;
  reusable: number;
  faithfulness: number;
  scope_appropriateness: number;
  spurious: boolean;
  low_quality: boolean;
  reason: string;
}> = {}): string {
  return JSON.stringify({
    well_formed:           0.90,
    reusable:              0.85,
    faithfulness:          0.88,
    scope_appropriateness: 0.80,
    spurious:              false,
    low_quality:           false,
    reason:                'Seam test mock judgment.',
    ...overrides,
  });
}

// ── FR-7a: correct NONE on a trivial case ─────────────────────────────────────

describe('FR-7a — correct NONE (trivial): counted in scoredCases AND scored correct (seam test)', () => {
  it('runSkillGeneratorGate NONE → scoreSkillGenerator: scoredCases ≥ 1 and decisionCorrectness = 1.0', async () => {
    const c = makeCase({
      id:     'fr7a-trivial-001',
      source: 'trivial',
      rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] },
    });

    // Gate call: NONE response — runSkillGeneratorGate attaches _eval (not hand-built)
    const gateResult = await runSkillGeneratorGate(c, {
      llm:       makeMockLLM(['NONE']),
      gateModel: 'test-gate-haiku',
    });
    assert.equal(gateResult.status, 'ok', `gate must succeed; got: ${JSON.stringify(gateResult)}`);
    if (gateResult.status !== 'ok') return;

    assert.equal(gateResult.output.decision, 'none');
    assert.deepEqual(gateResult.output._eval, {
      expectedDecision: 'none',
      source: 'trivial',
    }, '_eval must be attached by runSkillGeneratorGate');

    // NONE decision → judge returns 'skipped' without any LLM call (NFR-1)
    const judgeResult = await judgeSkillGeneration(c, gateResult.output, {
      llm:        makeThrowingLLM(),
      judgeModel: 'test-judge-haiku',
    });
    assert.equal(judgeResult.status, 'skipped', 'NONE decision must skip judging (NFR-1)');

    const records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[] = [
      { caseId: c.id, gate: gateResult, judge: judgeResult },
    ];

    const m = scoreSkillGenerator(records);

    // FR-7a assertions
    assert.ok(m.scoredCases >= 1,
      `trivial NONE case must be counted in scoredCases; got scoredCases=${m.scoredCases}`);
    assert.equal(m.decisionCorrectness, 1.0,
      `correct NONE must score as correct decision; got decisionCorrectness=${m.decisionCorrectness}`);
  });
});

// ── FR-7b: correct generate ────────────────────────────────────────────────────

describe('FR-7b — correct generate: scores correct and contributes to decisionCorrectness (seam test)', () => {
  it('runSkillGeneratorGate generate → scoreSkillGenerator: decisionCorrectness = 1.0', async () => {
    const c = makeCase({
      id:     'fr7b-generate-001',
      source: 'worthy',
      rubric: { expected_decision: 'generate', expected_themes: ['isolation'], spurious_traps: [] },
    });

    // Gate call: skill MD response → decision = 'generate'
    const gateResult = await runSkillGeneratorGate(c, {
      llm:       makeMockLLM([VALID_SKILL_MD]),
      gateModel: 'test-gate-haiku',
    });
    assert.equal(gateResult.status, 'ok');
    if (gateResult.status !== 'ok') return;
    assert.equal(gateResult.output.decision, 'generate');

    // generate decision → judge is called with a mocked response
    const judgeResult = await judgeSkillGeneration(c, gateResult.output, {
      llm:        makeMockLLM([judgeJson()]),
      judgeModel: 'test-judge-haiku',
    });
    assert.equal(judgeResult.status, 'ok', 'generate case must have a judgment');

    const records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[] = [
      { caseId: c.id, gate: gateResult, judge: judgeResult },
    ];

    const m = scoreSkillGenerator(records);

    // FR-7b assertions
    assert.ok(m.scoredCases >= 1, 'generate case must contribute to scoredCases');
    assert.equal(m.decisionCorrectness, 1.0,
      `correct generate must score as correct; got decisionCorrectness=${m.decisionCorrectness}`);
  });
});

// ── FR-7c: incorrect decisions in both directions ─────────────────────────────

describe('FR-7c — incorrect decisions: both directions score as incorrect (seam test)', () => {
  it('NONE-when-expected-generate → decisionCorrectness < 1.0 (incorrect)', async () => {
    const c = makeCase({
      id:     'fr7c-none-when-generate-001',
      source: 'worthy',
      rubric: { expected_decision: 'generate', expected_themes: [], spurious_traps: [] },
    });

    // Mock returns NONE even though expected generate → incorrect decision
    const gateResult = await runSkillGeneratorGate(c, {
      llm:       makeMockLLM(['NONE']),
      gateModel: 'test-gate-haiku',
    });
    assert.equal(gateResult.status, 'ok');
    if (gateResult.status !== 'ok') return;
    assert.equal(gateResult.output.decision, 'none', 'gate must produce none decision');
    assert.equal(gateResult.output._eval.expectedDecision, 'generate', '_eval must reflect expected_decision from case');

    // NONE decision → judge skipped (no LLM call)
    const judgeResult = await judgeSkillGeneration(c, gateResult.output, {
      llm:        makeThrowingLLM(),
      judgeModel: 'test-judge-haiku',
    });
    assert.equal(judgeResult.status, 'skipped');

    const records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[] = [
      { caseId: c.id, gate: gateResult, judge: judgeResult },
    ];

    const m = scoreSkillGenerator(records);

    // FR-7c assertion: wrong direction must score as incorrect
    assert.ok(m.decisionCorrectness < 1.0,
      `NONE-when-expected-generate must score as incorrect; got decisionCorrectness=${m.decisionCorrectness}`);
    assert.equal(m.decisionCorrectness, 0,
      'single wrong decision in a 1-case set → decisionCorrectness = 0');
  });

  it('generate-when-expected-NONE → decisionCorrectness = 0 and spuriousGenerationRate = 1.0 (incorrect)', async () => {
    const c = makeCase({
      id:     'fr7c-generate-when-none-001',
      source: 'trivial',
      rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] },
    });

    // Mock returns skill MD even though expected NONE → spurious generate
    const gateResult = await runSkillGeneratorGate(c, {
      llm:       makeMockLLM([VALID_SKILL_MD]),
      gateModel: 'test-gate-haiku',
    });
    assert.equal(gateResult.status, 'ok');
    if (gateResult.status !== 'ok') return;
    assert.equal(gateResult.output.decision, 'generate', 'gate must produce generate decision');
    assert.equal(gateResult.output._eval.expectedDecision, 'none');

    // generate decision → judge is called (we mock it)
    const judgeResult = await judgeSkillGeneration(c, gateResult.output, {
      llm:        makeMockLLM([judgeJson()]),
      judgeModel: 'test-judge-haiku',
    });
    assert.equal(judgeResult.status, 'ok', 'judge must be called for spurious generate case');

    const records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[] = [
      { caseId: c.id, gate: gateResult, judge: judgeResult },
    ];

    const m = scoreSkillGenerator(records);

    // FR-7c assertions: wrong direction in the other way
    assert.equal(m.decisionCorrectness, 0,
      'generate-when-expected-NONE must score as incorrect decision');
    assert.equal(m.spuriousGenerationRate, 1.0,
      'generate-when-expected-NONE must raise spuriousGenerationRate to 1.0');
  });
});

// ── FR-7d: quality/faithfulness judging only for generate cases ───────────────

describe('FR-7d — quality/faithfulness judging: only for generate cases, never NONE (seam test)', () => {
  it('judge consulted only for generate; NONE skips judging; quality metrics derived from generate only', async () => {
    const generateCase = makeCase({
      id:     'fr7d-generate-001',
      source: 'worthy',
      rubric: { expected_decision: 'generate', expected_themes: ['isolation'], spurious_traps: [] },
    });
    const noneCase = makeCase({
      id:     'fr7d-none-001',
      source: 'trivial',
      rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] },
    });

    // Independent gate calls — each with its own mock LLM
    const gateGenerate = await runSkillGeneratorGate(generateCase, {
      llm:       makeMockLLM([VALID_SKILL_MD]),
      gateModel: 'test-gate-haiku',
    });
    const gateNone = await runSkillGeneratorGate(noneCase, {
      llm:       makeMockLLM(['NONE']),
      gateModel: 'test-gate-haiku',
    });

    assert.equal(gateGenerate.status, 'ok');
    assert.equal(gateNone.status, 'ok');
    if (gateGenerate.status !== 'ok' || gateNone.status !== 'ok') return;

    // Single judge LLM shared across both judge calls.
    // It carries exactly ONE scripted response — for the generate case.
    // If the NONE case also consumed a response, the queue would exhaust and the
    // subsequent generate call would throw, proving the NONE path hit the LLM.
    const judgeLLM = makeMockLLM([judgeJson({ faithfulness: 0.92 })]);

    const judgeGenerate = await judgeSkillGeneration(generateCase, gateGenerate.output, {
      llm:        judgeLLM,
      judgeModel: 'test-judge-haiku',
    });
    const judgeNone = await judgeSkillGeneration(noneCase, gateNone.output, {
      llm:        judgeLLM,   // reused — must NOT consume a response for NONE
      judgeModel: 'test-judge-haiku',
    });

    // FR-7d / NFR-1: judge LLM called exactly once (for generate case only)
    assert.equal(judgeLLM.requests.length, 1,
      `judge LLM must be called exactly once (generate only); got ${judgeLLM.requests.length} call(s)`);
    assert.equal(judgeGenerate.status, 'ok', 'generate case must have a judgment');
    assert.equal(judgeNone.status, 'skipped', 'NONE case must skip judging (NFR-1)');

    const records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[] = [
      { caseId: generateCase.id, gate: gateGenerate, judge: judgeGenerate },
      { caseId: noneCase.id,     gate: gateNone,     judge: judgeNone },
    ];

    const m = scoreSkillGenerator(records);

    // FR-7d assertions: quality metrics come from the generate case only
    assert.ok(m.faithfulness > 0, 'faithfulness must be non-zero (from generate case judgment)');
    assert.ok(m.skillQuality > 0, 'skillQuality must be non-zero (from generate case judgment)');
    assert.ok(
      Math.abs(m.faithfulness - 0.92) < 1e-9,
      `faithfulness must equal the generate-case mock value 0.92; got ${m.faithfulness}`,
    );
  });
});
