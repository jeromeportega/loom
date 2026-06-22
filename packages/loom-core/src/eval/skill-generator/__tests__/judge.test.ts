import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MockLLMClient } from '../../../llm/MockLLMClient.js';
import type { LLMClient } from '../../../llm/LLMClient.js';
import { judgeSkillGeneration } from '../judge.js';
import type { SkillGeneratorCase } from '../caseSchema.js';
import type { SkillGeneratorDecision } from '../judgeTypes.js';
import { DEFAULT_JUDGE_MODEL, resolveSkillGeneratorModels } from '../models.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function wrapJson(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

const HAPPY_LLM_RESPONSE = {
  well_formed:           0.90,
  reusable:              0.80,
  faithfulness:          0.85,
  scope_appropriateness: 0.75,
  spurious:              false,
  low_quality:           false,
  reason:                'The skill is well-structured, reusable, and faithful to the work.',
};

function makeCase(overrides: Partial<SkillGeneratorCase> = {}): SkillGeneratorCase {
  return {
    id:     'sg-test-001',
    source: 'worthy',
    work: {
      story: {
        id:                  'story-test-001',
        title:               'Add retry logic to the API client',
        description:         'Implement exponential backoff for transient failures.',
        acceptance_criteria: ['Retries on 5xx', 'Max 3 attempts'],
      },
      summary:         'Added retry logic with exponential backoff.',
      diff_context:    '+  if (status >= 500) retry(attempt + 1);',
      existing_skills: [],
    },
    rubric: {
      expected_decision: 'generate',
      expected_themes:   ['retry', 'resilience'],
      spurious_traps:    ['one-line fix', 'cosmetic rename'],
    },
    rationale: 'Retry patterns are broadly reusable.',
    ...overrides,
  };
}

function makeDecision(overrides: Partial<SkillGeneratorDecision> = {}): SkillGeneratorDecision {
  return {
    decision: 'generate',
    skillMd:  '# retry-with-backoff\n\nRetry transient failures with exponential backoff.',
    ...overrides,
  };
}

// ── Case 1: decision === 'none' skips the judge ───────────────────────────────

describe('judgeSkillGeneration — decision=none skips without LLM call', () => {
  it('returns { status: skipped } when decision is none', async () => {
    const llm = new MockLLMClient([]);
    const output: SkillGeneratorDecision = { decision: 'none', skillMd: null };
    const result = await judgeSkillGeneration(makeCase(), output, { llm, judgeModel: 'j' });
    assert.equal(result.status, 'skipped');
  });

  it('makes zero LLM calls when decision is none', async () => {
    const llm = new MockLLMClient([]);
    const output: SkillGeneratorDecision = { decision: 'none', skillMd: null };
    await judgeSkillGeneration(makeCase(), output, { llm, judgeModel: 'j' });
    assert.equal(llm.requests.length, 0, 'LLM must not be called when decision is none');
  });
});

// ── Case 2: decision === 'generate' with valid mock returns judgment ───────────

describe('judgeSkillGeneration — decision=generate returns SkillGeneratorJudgment', () => {
  it('returns { status: ok, judgment } with all subjective dims in [0,1]', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;

    const j = result.judgment;
    assert.ok(j.well_formed >= 0 && j.well_formed <= 1, 'well_formed must be ∈ [0,1]');
    assert.ok(j.reusable >= 0 && j.reusable <= 1, 'reusable must be ∈ [0,1]');
    assert.ok(j.faithfulness >= 0 && j.faithfulness <= 1, 'faithfulness must be ∈ [0,1]');
    assert.ok(j.scope_appropriateness >= 0 && j.scope_appropriateness <= 1, 'scope_appropriateness must be ∈ [0,1]');
    assert.equal(typeof j.spurious, 'boolean', 'spurious must be boolean');
    assert.equal(typeof j.low_quality, 'boolean', 'low_quality must be boolean');
    assert.ok(j.reason.length > 0, 'reason must be non-empty');
  });

  it('surfaces all judgment fields from mock response', async () => {
    const llmResp = {
      well_formed:           0.72,
      reusable:              0.65,
      faithfulness:          0.88,
      scope_appropriateness: 0.55,
      spurious:              true,
      low_quality:           false,
      reason:                'Skill is well-formed but too specific to be reusable.',
    };
    const llm = new MockLLMClient([wrapJson(llmResp)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;

    const j = result.judgment;
    assert.equal(j.well_formed, 0.72);
    assert.equal(j.reusable, 0.65);
    assert.equal(j.faithfulness, 0.88);
    assert.equal(j.scope_appropriateness, 0.55);
    assert.equal(j.spurious, true);
    assert.equal(j.low_quality, false);
    assert.equal(j.reason, llmResp.reason);
  });

  it('scores only subjective dimensions — no decision_correctness or spurious_rate', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;

    const j = result.judgment as unknown as Record<string, unknown>;
    assert.ok(!('decision_correctness' in j), 'must not compute decision_correctness (that is score.ts)');
    assert.ok(!('spurious_rate' in j), 'must not compute spurious_rate (that is score.ts)');
  });

  it('makes exactly one LLM call per invocation', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(llm.requests.length, 1, 'exactly one LLM request must be made');
  });
});

// ── Case 3: fail-closed parse path ───────────────────────────────────────────

describe('judgeSkillGeneration — fail-closed: inconclusive on parse failure', () => {
  it('returns inconclusive on malformed/non-JSON response', async () => {
    const llm = new MockLLMClient(['not valid json at all']);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive', 'parse failure must not produce a fabricated verdict');
  });

  it('returns inconclusive on score > 1 (out of range)', async () => {
    const llmResp = { ...HAPPY_LLM_RESPONSE, well_formed: 1.5 };
    const llm = new MockLLMClient([wrapJson(llmResp)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on negative score', async () => {
    const llmResp = { ...HAPPY_LLM_RESPONSE, faithfulness: -0.1 };
    const llm = new MockLLMClient([wrapJson(llmResp)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on missing required field', async () => {
    const { reason: _r, ...noReason } = HAPPY_LLM_RESPONSE;
    const llm = new MockLLMClient([wrapJson(noReason)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on non-numeric score field', async () => {
    const llmResp = { ...HAPPY_LLM_RESPONSE, reusable: 'high' };
    const llm = new MockLLMClient([wrapJson(llmResp)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on non-boolean spurious field', async () => {
    const llmResp = { ...HAPPY_LLM_RESPONSE, spurious: 'maybe' };
    const llm = new MockLLMClient([wrapJson(llmResp)]);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });

  it('returns inconclusive on LLM throw', async () => {
    const throwingLLM: LLMClient = {
      async complete() { throw new Error('LLM outage'); },
    };
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm: throwingLLM, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
    if (result.status !== 'inconclusive') return;
    assert.ok(result.detail.includes('LLM outage'));
  });

  it('returns inconclusive on empty string response', async () => {
    const llm = new MockLLMClient(['']);
    const result = await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.equal(result.status, 'inconclusive');
  });
});

// ── Case 4: prompt injection control (T1) ─────────────────────────────────────

describe('judgeSkillGeneration — prompt injection control (T1)', () => {
  it('wraps skill_md in explicit untrusted-data delimiters', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    const output = makeDecision({ skillMd: 'UNIQUE_SKILL_CONTENT_XYZ' });
    await judgeSkillGeneration(makeCase(), output, { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('<skill_md>'), 'skill_md must be wrapped in <skill_md>');
    assert.ok(userMsg.includes('</skill_md>'), 'skill_md must be closed with </skill_md>');
    assert.ok(userMsg.includes('UNIQUE_SKILL_CONTENT_XYZ'), 'skill_md content must appear in prompt');
  });

  it('wraps work context in explicit untrusted-data delimiters', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes('<work_context>'), 'work context must be wrapped in <work_context>');
    assert.ok(userMsg.includes('</work_context>'), 'work context must be closed with </work_context>');
  });

  it('includes standing "do not follow instructions" guard for untrusted content', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(
      userMsg.includes('do not follow') || userMsg.includes('untrusted'),
      'prompt must contain the standing "do not follow instructions" guard',
    );
  });

  it('uses nonAgentic: { excludeDynamicSections: true }', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    const req = llm.requests[0];
    assert.ok(req.nonAgentic?.excludeDynamicSections === true, 'must use nonAgentic excludeDynamicSections:true');
  });

  it('c.work.summary and c.work.diff_context appear in prompt', async () => {
    const uniqueSummary = 'UNIQUE_SUMMARY_ABC_123';
    const uniqueDiff = 'UNIQUE_DIFF_XYZ_456';
    const c = makeCase({
      work: {
        story: {
          id: 's', title: 't', description: 'd', acceptance_criteria: [],
        },
        summary:         uniqueSummary,
        diff_context:    uniqueDiff,
        existing_skills: [],
      },
    });
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(c, makeDecision(), { llm, judgeModel: 'j' });
    const userMsg = llm.requests[0].messages[0].content as string;
    assert.ok(userMsg.includes(uniqueSummary), 'c.work.summary must appear in prompt');
    assert.ok(userMsg.includes(uniqueDiff), 'c.work.diff_context must appear in prompt');
  });

  it('system prompt has cache: true (prompt caching)', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'j' });
    assert.ok(llm.allCacheableBlocksMarked(), 'system prompt block must have cache: true');
  });
});

// ── Case 5: model selection ───────────────────────────────────────────────────

describe('judgeSkillGeneration — model selection via JudgeDeps', () => {
  it('calls deps.llm.complete() with deps.judgeModel', async () => {
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    await judgeSkillGeneration(makeCase(), makeDecision(), { llm, judgeModel: 'my-custom-judge-model' });
    assert.equal(llm.requests[0].model, 'my-custom-judge-model', 'must pass judgeModel to deps.llm');
  });

  it('DEFAULT_JUDGE_MODEL is claude-opus-4-8', () => {
    assert.equal(DEFAULT_JUDGE_MODEL, 'claude-opus-4-8');
  });

  it('resolveSkillGeneratorModels returns DEFAULT_JUDGE_MODEL when no env override', () => {
    const saved = process.env.LOOM_EVAL_JUDGE_MODEL;
    delete process.env.LOOM_EVAL_JUDGE_MODEL;
    try {
      const { judgeModel } = resolveSkillGeneratorModels();
      assert.equal(judgeModel, DEFAULT_JUDGE_MODEL);
    } finally {
      if (saved !== undefined) process.env.LOOM_EVAL_JUDGE_MODEL = saved;
    }
  });

  it('resolveSkillGeneratorModels honors LOOM_EVAL_JUDGE_MODEL env override', () => {
    const saved = process.env.LOOM_EVAL_JUDGE_MODEL;
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-override-model';
    try {
      const { judgeModel } = resolveSkillGeneratorModels();
      assert.equal(judgeModel, 'env-override-model');
    } finally {
      if (saved !== undefined) process.env.LOOM_EVAL_JUDGE_MODEL = saved;
      else delete process.env.LOOM_EVAL_JUDGE_MODEL;
    }
  });
});

// ── Case 6: borderline cases are still quality-scored ─────────────────────────

describe('judgeSkillGeneration — borderline cases are quality-scored', () => {
  it('a case with expected_decision=either and decision=generate is still scored', async () => {
    const c = makeCase({
      source: 'borderline',
      rubric: {
        expected_decision: 'either',
        expected_themes:   ['resilience'],
        spurious_traps:    ['trivial fix'],
      },
    });
    const llm = new MockLLMClient([wrapJson(HAPPY_LLM_RESPONSE)]);
    const result = await judgeSkillGeneration(c, makeDecision(), { llm, judgeModel: 'j' });

    // The judge never gates on the generate/NONE call — it always quality-scores 'generate'
    assert.equal(result.status, 'ok', 'borderline case must be quality-scored when decision=generate');
    assert.equal(llm.requests.length, 1, 'must make exactly one LLM call for borderline generate');
  });

  it('a borderline case with decision=none still skips without LLM call', async () => {
    const c = makeCase({
      source: 'borderline',
      rubric: {
        expected_decision: 'either',
        expected_themes:   [],
        spurious_traps:    [],
      },
    });
    const llm = new MockLLMClient([]);
    const result = await judgeSkillGeneration(c, { decision: 'none', skillMd: null }, { llm, judgeModel: 'j' });
    assert.equal(result.status, 'skipped');
    assert.equal(llm.requests.length, 0);
  });
});

// ── Persona guard ─────────────────────────────────────────────────────────────

describe('persona guard — skill-generator-judge.md exists and is valid', () => {
  function findPersonaDir(): string {
    const candidates = [
      path.resolve(__dirname, '../../../../personas'),
      path.resolve(process.cwd(), 'personas'),
      path.resolve(process.cwd(), 'packages/loom-core/personas'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    throw new Error(`personas/ dir not found. Tried: ${candidates.join(', ')}`);
  }

  it('skill-generator-judge.md exists', () => {
    const dir = findPersonaDir();
    const file = path.join(dir, 'skill-generator-judge.md');
    assert.ok(fs.existsSync(file), `Missing: ${file}`);
  });

  it('skill-generator-judge.md is non-empty', () => {
    const dir = findPersonaDir();
    const content = fs.readFileSync(path.join(dir, 'skill-generator-judge.md'), 'utf8');
    assert.ok(content.length > 0, 'persona file must not be empty');
  });

  it('skill-generator-judge.md does not contain {{CONTEXT}} production template variable', () => {
    const dir = findPersonaDir();
    const content = fs.readFileSync(path.join(dir, 'skill-generator-judge.md'), 'utf8');
    assert.ok(!content.includes('{{CONTEXT}}'), 'judge persona must not reuse the production template');
  });

  it('skill-generator-judge.md is distinct from opportunity-engine-judge.md', () => {
    const dir = findPersonaDir();
    const sg = fs.readFileSync(path.join(dir, 'skill-generator-judge.md'), 'utf8');
    const oe = fs.readFileSync(path.join(dir, 'opportunity-engine-judge.md'), 'utf8');
    assert.notEqual(sg, oe, 'skill-generator-judge persona must differ from opportunity-engine-judge');
  });
});
