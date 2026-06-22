import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { SkillJudge, type JudgeResult, type SkillJudgeOptions } from '../../../skills/SkillJudge.js';
import { runSkillJudgeGate, DEFAULT_GATE_MODEL } from '../runGate.js';
import type { SkillJudgeEvalCase } from '../caseSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function makeCase(overrides: Partial<SkillJudgeEvalCase> = {}): SkillJudgeEvalCase {
  return {
    id:                'sj-gate-test-001',
    source:            'anchor',
    category:          'accept',
    skill_md:          '# My Skill\n\nDo the thing.',
    existing_skills:   [],
    expected_decision: 'accept',
    expected_band:     'good',
    rationale:         'A solid reusable skill.',
    ...overrides,
  };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    score:   8,
    verdict: 'accept',
    reason:  'Well-formed and reusable.',
    ...overrides,
  };
}

/** Factory backed by a pre-built JudgeResult — no LLM call needed. */
function fixedResultFactory(result: JudgeResult) {
  return (_opts: SkillJudgeOptions): SkillJudge => ({
    async judge(_skillMd: string, _existingSkills: unknown): Promise<JudgeResult> {
      return result;
    },
  } as unknown as SkillJudge);
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('runSkillJudgeGate — happy path', () => {
  it('returns { status: ok } with the judge output on a normal result', async () => {
    const judgeResult = makeJudgeResult({ score: 8, verdict: 'accept', reason: 'Crisp and reusable.' });
    const factory = fixedResultFactory(judgeResult);
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.score, 8, 'AC4: score must be captured in output');
    assert.equal(result.output.verdict, 'accept', 'AC4: accept/reject verdict must be captured');
    assert.equal(result.output.reason, 'Crisp and reusable.');
  });

  it('propagates a reject verdict correctly', async () => {
    const factory = fixedResultFactory(makeJudgeResult({ score: 2, verdict: 'reject', reason: 'Too vague.' }));
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.verdict, 'reject');
    assert.equal(result.output.score, 2);
  });
});

// ── Fail-open sentinel (ADR-005) ──────────────────────────────────────────────

describe('runSkillJudgeGate — fail-open sentinel (ADR-005)', () => {
  it('maps score:999 sentinel to { status: failed, detail: fail-open }', async () => {
    const failOpenResult: JudgeResult = {
      score:   999,
      verdict: 'accept',
      reason:  'judge unavailable — defaulting to accept',
    };
    const factory = fixedResultFactory(failOpenResult);
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'failed', 'score:999 must NOT produce a genuine accept');
    if (result.status !== 'failed') return;
    assert.equal(result.detail, 'fail-open');
  });

  it('verdict:accept with score:999 is still detected as fail-open, not a real accept', async () => {
    const factory = fixedResultFactory({ score: 999, verdict: 'accept', reason: 'judge unavailable' });
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'failed', 'a fail-open accept must never be recorded as a genuine accept');
  });

  it('score:998 (below sentinel) is treated as a genuine result, not fail-open', async () => {
    const factory = fixedResultFactory(makeJudgeResult({ score: 998, verdict: 'reject' }));
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'ok', 'score:998 is not the sentinel and must be treated as ok');
  });

  it('score:1000 (above sentinel) is treated as a genuine result, not fail-open', async () => {
    const factory = fixedResultFactory(makeJudgeResult({ score: 1000, verdict: 'reject' }));
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'ok', 'score:1000 is not the sentinel and must be treated as ok');
  });
});

// ── Sentinel-drift pin ────────────────────────────────────────────────────────

describe('runSkillJudgeGate — sentinel-drift pin', () => {
  it('detection keys on score===999 exactly (drift guard)', async () => {
    // Verify that score:999 triggers fail-open but score:998 and score:1000 do not.
    // If SkillJudge changes its fail-open sentinel, this test will break loudly.
    const sentinelFactory = fixedResultFactory({ score: 999, verdict: 'accept', reason: 'judge unavailable' });
    const belowFactory    = fixedResultFactory({ score: 998, verdict: 'accept', reason: 'fine' });
    const aboveFactory    = fixedResultFactory({ score: 1000, verdict: 'accept', reason: 'fine' });
    const deps = { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' };

    const sentinel = await runSkillJudgeGate(makeCase(), deps, sentinelFactory);
    const below    = await runSkillJudgeGate(makeCase(), deps, belowFactory);
    const above    = await runSkillJudgeGate(makeCase(), deps, aboveFactory);

    assert.equal(sentinel.status, 'failed', 'score:999 must be fail-open');
    assert.equal(below.status,    'ok',     'score:998 must NOT be fail-open');
    assert.equal(above.status,    'ok',     'score:1000 must NOT be fail-open');
  });

  it('production SkillJudge returns score:999 on error (sentinel drift guard)', async () => {
    // If SkillJudge changes its fail-open sentinel value, this test breaks — alerting that
    // the detection in runSkillJudgeGate must also be updated.
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('simulated LLM outage'); },
    };
    const judge = new SkillJudge({
      llm:        throwingLLM,
      model:      'x',
      loadPrompt: (_name: string) => '{{CONTEXT}}',
    });
    const failOpenResult = await judge.judge('# skill', []);
    assert.equal(failOpenResult.score, 999, 'SkillJudge fail-open sentinel must be score:999');
    assert.ok(
      failOpenResult.reason.includes('judge unavailable'),
      'SkillJudge fail-open reason must contain "judge unavailable"',
    );
  });
});

// ── Observe-only call-through ──────────────────────────────────────────────────

describe('runSkillJudgeGate — observe-only call-through (AC3)', () => {
  it('passes c.skill_md to judge.judge() unchanged', async () => {
    let capturedSkillMd: string | undefined;
    const capturingFactory = (_opts: SkillJudgeOptions): SkillJudge => ({
      async judge(skillMd: string, _existingSkills: unknown): Promise<JudgeResult> {
        capturedSkillMd = skillMd;
        return makeJudgeResult();
      },
    } as unknown as SkillJudge);

    const skill = '# Unique Skill\n\nSpecific instructions.\n';
    const c = makeCase({ skill_md: skill });
    await runSkillJudgeGate(c, { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' }, capturingFactory);

    assert.equal(capturedSkillMd, skill, 'skill_md must pass through to judge unchanged');
  });

  it('passes c.existing_skills by reference to judge.judge()', async () => {
    let capturedExistingSkills: unknown;
    const capturingFactory = (_opts: SkillJudgeOptions): SkillJudge => ({
      async judge(_skillMd: string, existingSkills: unknown): Promise<JudgeResult> {
        capturedExistingSkills = existingSkills;
        return makeJudgeResult();
      },
    } as unknown as SkillJudge);

    const existingSkills = [{ name: 'existing-skill', description: 'Does something.' }];
    const c = makeCase({ existing_skills: existingSkills });
    await runSkillJudgeGate(c, { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' }, capturingFactory);

    // Same reference — the adapter must not clone or mutate the array
    assert.strictEqual(capturedExistingSkills, existingSkills, 'existing_skills must be passed by reference, not copied');
  });

  it('passes multiple existing_skills entries through unchanged', async () => {
    let capturedExistingSkills: unknown;
    const capturingFactory = (_opts: SkillJudgeOptions): SkillJudge => ({
      async judge(_skillMd: string, existingSkills: unknown): Promise<JudgeResult> {
        capturedExistingSkills = existingSkills;
        return makeJudgeResult();
      },
    } as unknown as SkillJudge);

    const existingSkills = [
      { name: 'skill-a', description: 'Does A.' },
      { name: 'skill-b', description: 'Does B.' },
    ];
    const c = makeCase({ existing_skills: existingSkills });
    await runSkillJudgeGate(c, { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' }, capturingFactory);

    assert.deepEqual(capturedExistingSkills, existingSkills);
  });
});

// ── Gate model resolution (FR-5) ──────────────────────────────────────────────

describe('runSkillJudgeGate — gate model resolution (FR-5)', () => {
  it('DEFAULT_GATE_MODEL is claude-haiku-4-5-20251001 (the shipping skill_gen model)', () => {
    assert.equal(DEFAULT_GATE_MODEL, 'claude-haiku-4-5-20251001');
  });

  it('passes deps.gateModel to the judge factory', async () => {
    let capturedModel: string | undefined;
    const modelCapturingFactory = (opts: SkillJudgeOptions): SkillJudge => {
      capturedModel = opts.model;
      return {
        async judge(): Promise<JudgeResult> { return makeJudgeResult(); },
      } as unknown as SkillJudge;
    };

    await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'claude-haiku-4-5-20251001' },
      modelCapturingFactory,
    );
    assert.equal(capturedModel, 'claude-haiku-4-5-20251001');
  });

  it('uses LOOM_EVAL_GATE_MODEL override when injected via deps.gateModel', async () => {
    let capturedModel: string | undefined;
    const modelCapturingFactory = (opts: SkillJudgeOptions): SkillJudge => {
      capturedModel = opts.model;
      return {
        async judge(): Promise<JudgeResult> { return makeJudgeResult(); },
      } as unknown as SkillJudge;
    };

    const overrideModel = 'claude-sonnet-4-6';
    await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: overrideModel },
      modelCapturingFactory,
    );
    assert.equal(capturedModel, overrideModel, 'override model must be passed to the judge factory');
  });
});

// ── _judgeFactory is test-only ────────────────────────────────────────────────

describe('runSkillJudgeGate — _judgeFactory is test-only', () => {
  it('default path constructs real SkillJudge and calls deps.llm', async () => {
    const llm = new MockLLMClient([
      wrapJson({ score: 7, verdict: 'accept', reason: 'Good skill.' }),
    ]);
    // No _judgeFactory — real SkillJudge is constructed with deps.llm
    const result = await runSkillJudgeGate(makeCase(), { llm: llm as LLMClient, gateModel: 'g' });
    assert.equal(llm.requests.length, 1, 'real SkillJudge must call deps.llm exactly once');
    assert.equal(result.status, 'ok');
  });

  it('default path fails-open (score:999) when the LLM throws, not to an error', async () => {
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('outage'); },
    };
    // Real SkillJudge catches the error internally and returns score:999
    // The adapter then maps that to { status: 'failed', detail: 'fail-open' }
    const result = await runSkillJudgeGate(makeCase(), { llm: throwingLLM, gateModel: 'g' });
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.equal(result.detail, 'fail-open', 'LLM error must propagate as fail-open, not as an undetected exception');
  });
});

// ── Error propagation (catch path) ───────────────────────────────────────────

describe('runSkillJudgeGate — error propagation', () => {
  it('maps a thrown exception from judge.judge() to { status: failed }', async () => {
    const throwingFactory = (_opts: SkillJudgeOptions): SkillJudge => ({
      async judge(): Promise<JudgeResult> { throw new Error('unexpected judge failure'); },
    } as unknown as SkillJudge);

    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      throwingFactory,
    );
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.ok(result.detail.includes('unexpected judge failure'));
  });
});
