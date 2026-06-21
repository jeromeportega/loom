import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { judgeSkillAdmissibility } from '../judge.js';
import { scoreInBand } from '../bands.js';
import type { SkillJudgeEvalCase } from '../caseSchema.js';
import type { JudgeResult } from '../../../skills/SkillJudge.js';
import { DEFAULT_JUDGE_MODEL } from '../../framework/models.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

function makeLLMJudgment(
  independent_verdict: 'accept' | 'reject',
  band_defensible = true,
  reason = 'Test reason.',
): string {
  return wrapJson({ independent_verdict, band_defensible, reason });
}

function makeCase(overrides: Partial<SkillJudgeEvalCase> = {}): SkillJudgeEvalCase {
  return {
    id:                'sj-test-001',
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

function makeOutput(overrides: Partial<JudgeResult> = {}): JudgeResult {
  return {
    score:   8,
    verdict: 'accept',
    reason:  'Well-formed and reusable.',
    ...overrides,
  };
}

const DEPS = { llm: new MockLLMClient([]) as LLMClient, judgeModel: 'judge-model' };

// ── decision_correct — deterministic ─────────────────────────────────────────

describe('judgeSkillAdmissibility — decision_correct (deterministic)', () => {
  it('true when gate verdict matches expected_decision (accept/accept)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'accept' }),
      makeOutput({ verdict: 'accept' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, true);
  });

  it('true when gate verdict matches expected_decision (reject/reject)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('reject')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'reject', category: 'reject' }),
      makeOutput({ verdict: 'reject', score: 2 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, true);
  });

  it('false when gate verdict mismatches expected_decision (accept when reject expected)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'reject', category: 'reject' }),
      makeOutput({ verdict: 'accept' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, false);
  });

  it('false when gate verdict mismatches expected_decision (reject when accept expected)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('reject')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'accept' }),
      makeOutput({ verdict: 'reject' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, false);
  });
});

// ── band_in_range — delegates to scoreInBand ──────────────────────────────────

describe('judgeSkillAdmissibility — band_in_range (delegates to scoreInBand)', () => {
  it('true when score is in expected band (good band, score=8)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_band: 'good' }),
      makeOutput({ score: 8 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.band_in_range, true);
  });

  it('false when score is out of expected band (good band, score=4)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_band: 'good' }),
      makeOutput({ score: 4 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.band_in_range, false);
  });

  it('false when score is the 999 fail-open sentinel', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_band: 'good' }),
      makeOutput({ score: 999, verdict: 'accept', reason: 'judge unavailable — defaulting to accept' }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.band_in_range, false, '999 sentinel must yield band_in_range=false');
  });
});

// ── scoreInBand unit tests (from bands.ts) ────────────────────────────────────

describe('scoreInBand — band boundary math (τ=1)', () => {
  it('good [7,10]: s=7 in band', () => { assert.equal(scoreInBand(7, 'good'), true); });
  it('good [7,10]: s=6 in band (lo-τ)', () => { assert.equal(scoreInBand(6, 'good'), true); });
  it('good [7,10]: s=5 out of band', () => { assert.equal(scoreInBand(5, 'good'), false); });
  it('good [7,10]: s=10 in band', () => { assert.equal(scoreInBand(10, 'good'), true); });
  it('good [7,10]: s=11 in band (hi+τ)', () => { assert.equal(scoreInBand(11, 'good'), true); });
  it('good [7,10]: s=12 out of band', () => { assert.equal(scoreInBand(12, 'good'), false); });

  it('bad [0,4]: s=0 in band', () => { assert.equal(scoreInBand(0, 'bad'), true); });
  it('bad [0,4]: s=4 in band', () => { assert.equal(scoreInBand(4, 'bad'), true); });
  it('bad [0,4]: s=5 in band (hi+τ)', () => { assert.equal(scoreInBand(5, 'bad'), true); });
  it('bad [0,4]: s=6 out of band', () => { assert.equal(scoreInBand(6, 'bad'), false); });

  it('borderline [5,6]: s=4 in band (lo-τ)', () => { assert.equal(scoreInBand(4, 'borderline'), true); });
  it('borderline [5,6]: s=3 out of band', () => { assert.equal(scoreInBand(3, 'borderline'), false); });
  it('borderline [5,6]: s=7 in band (hi+τ)', () => { assert.equal(scoreInBand(7, 'borderline'), true); });
  it('borderline [5,6]: s=8 out of band', () => { assert.equal(scoreInBand(8, 'borderline'), false); });

  it('999 sentinel is out of every band', () => {
    assert.equal(scoreInBand(999, 'bad'), false);
    assert.equal(scoreInBand(999, 'borderline'), false);
    assert.equal(scoreInBand(999, 'good'), false);
  });

  it('negative score is always out of band', () => {
    assert.equal(scoreInBand(-1, 'bad'), false);
    assert.equal(scoreInBand(-1, 'borderline'), false);
    assert.equal(scoreInBand(-1, 'good'), false);
  });
});

// ── LLM-contributed fields surfaced from mock response ────────────────────────

describe('judgeSkillAdmissibility — LLM-contributed fields', () => {
  it('surfaces independent_verdict, band_defensible, and reason from LLM response', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('reject', false, 'The skill is too vague.')]);
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.independent_verdict, 'reject');
    assert.equal(result.judgment.band_defensible, false);
    assert.equal(result.judgment.reason, 'The skill is too vague.');
  });

  it('independent_verdict can be accept', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept', true, 'Crisp and reusable.')]);
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.independent_verdict, 'accept');
    assert.equal(result.judgment.band_defensible, true);
  });

  it('decision_correct and band_in_range come from TypeScript, not from LLM', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const result = await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'reject' }),
      makeOutput({ verdict: 'accept', score: 1 }),
      { llm, judgeModel: 'j' },
    );
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.judgment.decision_correct, false, 'decision_correct is computed, not from LLM');
    assert.equal(result.judgment.band_in_range, false, 'band_in_range is computed, not from LLM');
  });
});

// ── Wiring — judge model and persona ─────────────────────────────────────────

describe('judgeSkillAdmissibility — prompt wiring', () => {
  it('passes judgeModel to the LLM request', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'my-judge-model' });
    assert.equal(llm.requests[0].model, 'my-judge-model');
  });

  it('sends exactly one LLM request', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(llm.requests.length, 1);
  });

  it('system prompt is cached (cache: true on system block)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.ok(llm.allCacheableBlocksMarked(), 'system prompt block must be cached');
  });

  it('includes skill_md in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    const uniqueSkill = '# Unique Skill XYZ\n\nSpecific instructions.';
    await judgeSkillAdmissibility(makeCase({ skill_md: uniqueSkill }), makeOutput(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('Unique Skill XYZ'), 'skill_md must appear in user message');
  });

  it('includes expected_decision and expected_band in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(
      makeCase({ expected_decision: 'reject', expected_band: 'bad' }),
      makeOutput(),
      { llm, judgeModel: 'j' },
    );
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('expected_decision: reject'));
    assert.ok(userMsg.includes('expected_band: bad'));
  });

  it('includes SkillJudge score and verdict in the user message', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(makeCase(), makeOutput({ score: 3, verdict: 'reject' }), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('score: 3'));
    assert.ok(userMsg.includes('verdict: reject'));
  });

  it('system prompt is built from skill-admissibility-judge persona (not production skill-judge.md)', async () => {
    const llm = new MockLLMClient([makeLLMJudgment('accept')]);
    await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    const systemText = llm.requests[0].system[0].text;
    assert.ok(systemText.length > 0, 'system prompt must be non-empty');
    assert.ok(
      systemText.includes('independent'),
      'skill-admissibility-judge prompt must mention independent assessment',
    );
    assert.ok(
      !systemText.includes('{{CONTEXT}}'),
      'production skill-judge template variable must not appear in judge persona',
    );
  });
});

// ── Model resolution (FR-5) ───────────────────────────────────────────────────

describe('model resolution (FR-5) — judgeModel defaults and circularity', () => {
  it('DEFAULT_JUDGE_MODEL is claude-opus-4-8', () => {
    assert.equal(DEFAULT_JUDGE_MODEL, 'claude-opus-4-8');
  });

  it('DEFAULT_JUDGE_MODEL differs from the gate haiku default (mitigates circularity)', () => {
    const GATE_DEFAULT = 'claude-haiku-4-5-20251001';
    assert.notEqual(DEFAULT_JUDGE_MODEL, GATE_DEFAULT, 'judge and gate defaults must be distinct');
  });
});

// ── Inconclusive path ─────────────────────────────────────────────────────────

describe('judgeSkillAdmissibility — inconclusive on parse failure', () => {
  it('returns inconclusive on unparseable LLM response', async () => {
    const llm = new MockLLMClient(['not valid json at all']);
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'parse failure must not produce a fabricated verdict');
  });

  it('returns inconclusive on invalid enum value in LLM response', async () => {
    const llm = new MockLLMClient([wrapJson({ independent_verdict: 'maybe', band_defensible: true, reason: 'x' })]);
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on missing required fields in LLM response', async () => {
    const llm = new MockLLMClient([wrapJson({ independent_verdict: 'accept' })]);
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on LLM outage (throwing client)', async () => {
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('LLM outage'); },
    };
    const result = await judgeSkillAdmissibility(makeCase(), makeOutput(), { llm: throwingLLM, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
    if (result.status !== 'inconclusive') return;
    assert.ok(result.detail.includes('LLM outage'));
  });
});

// ── Guard: persona files ──────────────────────────────────────────────────────

describe('persona guard — skill-admissibility-judge.md is distinct from skill-judge.md', () => {
  function findPersonaDir(): string {
    const candidates = [
      path.resolve(__dirname, '../../../../personas'),
      path.resolve(process.cwd(), 'personas'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    throw new Error(`personas/ dir not found. Tried: ${candidates.join(', ')}`);
  }

  it('skill-admissibility-judge.md exists', () => {
    const dir = findPersonaDir();
    const file = path.join(dir, 'skill-admissibility-judge.md');
    assert.ok(fs.existsSync(file), `Missing: ${file}`);
  });

  it('skill-judge.md still exists (production persona unmodified)', () => {
    const dir = findPersonaDir();
    const file = path.join(dir, 'skill-judge.md');
    assert.ok(fs.existsSync(file), `Missing: ${file}`);
  });

  it('skill-admissibility-judge.md content differs from skill-judge.md (circularity firewall)', () => {
    const dir = findPersonaDir();
    const judgeContent = fs.readFileSync(path.join(dir, 'skill-judge.md'), 'utf8');
    const admissibilityContent = fs.readFileSync(path.join(dir, 'skill-admissibility-judge.md'), 'utf8');
    assert.notEqual(admissibilityContent, judgeContent, 'persona files must be distinct');
  });

  it('skill-admissibility-judge.md does not contain the {{CONTEXT}} production template variable', () => {
    const dir = findPersonaDir();
    const content = fs.readFileSync(path.join(dir, 'skill-admissibility-judge.md'), 'utf8');
    assert.ok(!content.includes('{{CONTEXT}}'), 'judge persona must not reuse the production template');
  });
});
