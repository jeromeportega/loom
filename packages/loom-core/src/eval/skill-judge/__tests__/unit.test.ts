/**
 * story-038-005 — Consolidated unit tests for the SkillJudge eval pipeline.
 *
 * Covers the four modules this story is accountable for verifying:
 *   1. Loader  (loadSkillJudgeCases)              — valid load + malformed rejection
 *   2. Judge   (judgeSkillAdmissibility)           — wiring via MockLLMClient
 *   3. Runner  (runSkillJudgeGate)                 — fail-open sentinel ADR-005 pin
 *   4. Scorer  (scoreSkillJudge / skillJudgeVerdict) — pass and fail-closed paths
 *
 * Every test uses MockLLMClient — no real model calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { loadSkillJudgeCases } from '../loadCases.js';
import { judgeSkillAdmissibility } from '../judge.js';
import { runSkillJudgeGate } from '../runGate.js';
import { scoreSkillJudge, skillJudgeVerdict, SKILL_JUDGE_THRESHOLDS } from '../score.js';
import { SkillJudge, type JudgeResult, type SkillJudgeOptions } from '../../../skills/SkillJudge.js';
import type { SkillJudgeEvalCase } from '../caseSchema.js';
import type { RunRecord } from '../../framework/types.js';
import type { SkillJudgeJudgment } from '../judgeTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function makeCase(overrides: Partial<SkillJudgeEvalCase> = {}): SkillJudgeEvalCase {
  return {
    id:                'sj-unit-001',
    source:            'anchor',
    category:          'accept',
    skill_md:          '# Test Skill\n\nDo the thing reliably.',
    existing_skills:   [],
    expected_decision: 'accept',
    expected_band:     'good',
    rationale:         'A solid reusable skill.',
    ...overrides,
  };
}

function makeJudgeResult(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return { score: 8, verdict: 'accept', reason: 'Well-formed and reusable.', ...overrides };
}

/** Test-only SkillJudge factory that returns a fixed result without any LLM call. */
function fixedGateFactory(result: JudgeResult) {
  return (_opts: SkillJudgeOptions): SkillJudge => ({
    async judge(): Promise<JudgeResult> { return result; },
  } as unknown as SkillJudge);
}

function makeOkRecord(id: string): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return {
    caseId: id,
    gate:  { status: 'ok', output: makeJudgeResult() },
    judge: {
      status: 'ok',
      judgment: {
        decision_correct: true, band_in_range: true,
        independent_verdict: 'accept', band_defensible: true, reason: 'ok',
      },
    },
  };
}

function makeGateFailedRecord(id: string, detail = 'fail-open'): RunRecord<JudgeResult, SkillJudgeJudgment> {
  return {
    caseId: id,
    gate:  { status: 'failed', detail },
    judge: { status: 'skipped' },
  };
}

// ── 1. Loader ─────────────────────────────────────────────────────────────────

describe('unit — loadSkillJudgeCases', () => {
  it('valid load: returns at least 5 cases from the default fixture', () => {
    const cases = loadSkillJudgeCases();
    assert.ok(Array.isArray(cases), 'should return an array');
    assert.ok(
      cases.length >= SKILL_JUDGE_THRESHOLDS.minScoredCases,
      `fixture must have ≥${SKILL_JUDGE_THRESHOLDS.minScoredCases} cases; got ${cases.length}`,
    );
  });

  it('malformed rejection: throws at load when skill_md is empty', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-unit-'));
    try {
      const fixturePath = path.join(tmp, 'empty-skill-md.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-01', source: 'anchor', category: 'accept',
          skill_md: '',
          expected_decision: 'accept', expected_band: 'good', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('malformed rejection: throws at load when expected_decision is an invalid enum', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sj-unit-'));
    try {
      const fixturePath = path.join(tmp, 'bad-decision.yaml');
      fs.writeFileSync(fixturePath, yaml.dump({
        cases: [{
          id: 'sj-bad-02', source: 'anchor', category: 'accept',
          skill_md: '# Skill\nDo thing.', expected_decision: 'maybe',
          expected_band: 'good', rationale: 'Test.',
        }],
      }), 'utf8');
      assert.throws(() => loadSkillJudgeCases(fixturePath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 2. Judge wiring via MockLLMClient ─────────────────────────────────────────

describe('unit — judgeSkillAdmissibility wiring (MockLLMClient)', () => {
  function mockJudgeResponse(
    independent_verdict: 'accept' | 'reject',
    band_defensible = true,
    reason = 'Test reason.',
  ): string {
    return wrapJson({ independent_verdict, band_defensible, reason });
  }

  it('decision_correct=true when gate verdict matches expected_decision (accept/accept)', async () => {
    const llm = new MockLLMClient([mockJudgeResponse('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'accept' }),
      makeJudgeResult({ verdict: 'accept', score: 8 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, true);
  });

  it('decision_correct=false when gate verdict mismatches expected_decision (accept when reject expected)', async () => {
    const llm = new MockLLMClient([mockJudgeResponse('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'reject', category: 'reject' }),
      makeJudgeResult({ verdict: 'accept' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, false);
  });

  it('band_in_range=true when score is within expected band (good, score=8)', async () => {
    const llm = new MockLLMClient([mockJudgeResponse('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_band: 'good' }),
      makeJudgeResult({ score: 8 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.band_in_range, true);
  });

  it('band_in_range=false for score=999 fail-open sentinel', async () => {
    const llm = new MockLLMClient([mockJudgeResponse('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_band: 'good' }),
      makeJudgeResult({ score: 999, verdict: 'accept', reason: 'judge unavailable — defaulting to accept' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.band_in_range, false, '999 sentinel must yield band_in_range=false');
  });

  it('surfaces independent_verdict, band_defensible, and reason from the mock LLM response', async () => {
    const llm = new MockLLMClient([mockJudgeResponse('reject', false, 'The skill is too vague.')]);
    const result = await judgeSkillAdmissibility(makeCase(), makeJudgeResult(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.independent_verdict, 'reject');
    assert.equal(result.judgment.band_defensible, false);
    assert.equal(result.judgment.reason, 'The skill is too vague.');
  });

  it('returns inconclusive when the LLM response is not parseable JSON', async () => {
    const llm = new MockLLMClient(['not valid json at all']);
    const result = await judgeSkillAdmissibility(makeCase(), makeJudgeResult(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'parse failure must not produce a fabricated verdict');
  });
});

// ── 3. Runner — fail-open sentinel pin (ADR-005) ──────────────────────────────

describe('unit — runSkillJudgeGate fail-open sentinel (ADR-005)', () => {
  it('score===999 maps to { status: failed, detail: "fail-open" }', async () => {
    const factory = fixedGateFactory({ score: 999, verdict: 'accept', reason: 'judge unavailable — defaulting to accept' });
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'failed', 'score:999 sentinel must NOT produce a genuine accept');
    if (result.status !== 'failed') return;
    assert.equal(result.detail, 'fail-open', 'detail must be the exact literal "fail-open"');
  });

  it('normal accept result (score=8) maps to { status: ok }', async () => {
    const factory = fixedGateFactory({ score: 8, verdict: 'accept', reason: 'Crisp and reusable.' });
    const result = await runSkillJudgeGate(
      makeCase(),
      { llm: new MockLLMClient([]) as LLMClient, gateModel: 'g' },
      factory,
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.score, 8);
    assert.equal(result.output.verdict, 'accept');
  });
});

// ── 4. Scorer — pass and fail-closed paths ────────────────────────────────────

describe('unit — scoreSkillJudge and skillJudgeVerdict', () => {
  it('proceed: ≥5 scored cases and all rates within thresholds', () => {
    const records = [
      makeOkRecord('c1'), makeOkRecord('c2'), makeOkRecord('c3'),
      makeOkRecord('c4'), makeOkRecord('c5'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 5);
    assert.equal(skillJudgeVerdict(m), 'proceed');
  });

  it('fail-closed: scoredCases < minScoredCases (5) → do-not-proceed', () => {
    // 4 ok records → scoredCases = 4, below the minimum threshold of 5
    const records = [
      makeOkRecord('c1'), makeOkRecord('c2'), makeOkRecord('c3'), makeOkRecord('c4'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 4);
    assert.ok(m.scoredCases < SKILL_JUDGE_THRESHOLDS.minScoredCases);
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('fail-closed: gateFailureRate > maxGateFailureRate (0.25) → do-not-proceed', () => {
    // 5 ok + 3 gate-failed = 8 total; gateFailureRate = 3/8 = 0.375 > 0.25
    // scoredCases = 5 ≥ 5, judgeInconclusiveRate = 0 — only gateFailureRate triggers
    const records = [
      makeOkRecord('c1'), makeOkRecord('c2'), makeOkRecord('c3'),
      makeOkRecord('c4'), makeOkRecord('c5'),
      makeGateFailedRecord('c6'), makeGateFailedRecord('c7'), makeGateFailedRecord('c8'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 5);
    assert.ok(
      m.gateFailureRate > SKILL_JUDGE_THRESHOLDS.maxGateFailureRate,
      `gateFailureRate ${m.gateFailureRate} must exceed ${SKILL_JUDGE_THRESHOLDS.maxGateFailureRate}`,
    );
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('fail-closed: empty input → scoredCases=0 → do-not-proceed', () => {
    const m = scoreSkillJudge([]);
    assert.equal(m.scoredCases, 0);
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });

  it('fail-closed: all gate failures → scoredCases=0 → do-not-proceed', () => {
    const records = [
      makeGateFailedRecord('c1'), makeGateFailedRecord('c2'),
      makeGateFailedRecord('c3'), makeGateFailedRecord('c4'),
      makeGateFailedRecord('c5'),
    ];
    const m = scoreSkillJudge(records);
    assert.equal(m.scoredCases, 0);
    assert.equal(skillJudgeVerdict(m), 'do-not-proceed');
  });
});
