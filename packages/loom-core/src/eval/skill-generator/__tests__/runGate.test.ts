import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMClient, LLMRequest, LLMResponse } from '../../../llm/LLMClient.js';
import { EMPTY_USAGE } from '../../../llm/LLMClient.js';
import { runSkillGeneratorGate } from '../runGate.js';
import { DEFAULT_GATE_MODEL, resolveSkillGeneratorModels } from '../models.js';
import type { SkillGeneratorCase } from '../caseSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A valid agentskills.io SKILL.md the mock extractor might emit. */
const VALID_SKILL_MD = `---
name: loom-eval-test-skill
description: A test skill produced during eval
metadata:
  source: generated
  category: testing
---

# Eval Test Skill

When writing eval cases, create isolated :memory: databases and ephemeral temp dirs
so the operator's state is never mutated (NFR-1/4). Use a recording client that
forwards only the extractor call and returns a canned accept for the SkillJudge.
`;

function makeCase(overrides: Partial<SkillGeneratorCase> = {}): SkillGeneratorCase {
  return {
    id: 'eval-test-001',
    source: 'worthy',
    work: {
      story: {
        id: 'story-099-001',
        title: 'Add ephemeral db isolation to eval gate',
        description: 'Each eval case must use a fresh :memory: db.',
        acceptance_criteria: ['Fresh db per case', 'No operator state touched'],
      },
      summary: 'Implemented per-case :memory: db isolation.',
      diff_context: '+const db = createDatabase(":memory:");\n-// shared db removed',
      existing_skills: [],
    },
    rubric: {
      expected_decision: 'generate',
      expected_themes: ['isolation', 'eval'],
      spurious_traps: [],
    },
    rationale: 'Isolation is a key invariant for eval correctness.',
    ...overrides,
  };
}

/** Builds a mock LLM client with scripted responses (FIFO queue). */
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

/** Builds a mock LLM that throws on any call. */
function makeThrowingLLM(msg = 'simulated LLM failure'): LLMClient {
  return { async complete() { throw new Error(msg); } };
}

// ── (1) First-call-wins — generate decision ───────────────────────────────────

describe('runSkillGeneratorGate — first-call-wins → generate (ADR-002)', () => {
  it('returns { status: ok, decision: generate, skillMd: <raw text> } when first complete() returns a SKILL.md body', async () => {
    const llm = makeMockLLM([VALID_SKILL_MD]);
    const c = makeCase();

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok', `expected ok, got: ${JSON.stringify(result)}`);
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'generate');
    assert.equal(result.output.skillMd, VALID_SKILL_MD,
      'skillMd must hold the raw captured text from the first complete() call');
  });

  it('only the first complete() call is forwarded to gateModel — subsequent calls are canned', async () => {
    const llm = makeMockLLM([VALID_SKILL_MD]);
    const c = makeCase();

    await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    // The real llm should receive exactly one call (the extractor).
    // The SkillJudge's call is intercepted and returns a canned response.
    assert.equal(llm.requests.length, 1,
      'only the extractor call should reach deps.llm; SkillJudge call must use canned response');
    assert.equal(llm.requests[0].model, 'haiku-test',
      'the extractor call must use deps.gateModel');
  });
});

// ── (2) First-call-wins — none decision ───────────────────────────────────────

describe('runSkillGeneratorGate — first-call-wins → none (ADR-002)', () => {
  it('"NONE" response → { decision: none, skillMd: null }', async () => {
    const llm = makeMockLLM(['NONE']);
    const c = makeCase({ rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] } });

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'none');
    assert.equal(result.output.skillMd, null);
  });

  it('empty-string response → { decision: none, skillMd: null }', async () => {
    const llm = makeMockLLM(['']);
    const c = makeCase({ rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] } });

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'none');
  });

  it('lowercase "none" response → { decision: none, skillMd: null }', async () => {
    const llm = makeMockLLM(['none']);
    const c = makeCase({ rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] } });

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'none');
  });

  it('"none " (NONE-prefixed with suffix) → { decision: none, skillMd: null }', async () => {
    // raw.toUpperCase().startsWith('NONE') must match 'NONE'-prefixed strings
    const llm = makeMockLLM(['none but with trailing content']);
    const c = makeCase({ rubric: { expected_decision: 'none', expected_themes: [], spurious_traps: [] } });

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'none',
      'any text starting with NONE (case-insensitive) must derive "none" decision');
  });
});

// ── (3) Subsequent calls use canned accept ────────────────────────────────────

describe('runSkillGeneratorGate — canned accept for SkillJudge (ADR-002)', () => {
  it('SkillJudge internal calls do NOT reach deps.llm — only the first call is forwarded', async () => {
    // The generator will call llm once (extractor) and then SkillJudge calls it again.
    // Our recording client must intercept that second call and return a canned accept.
    const llm = makeMockLLM([VALID_SKILL_MD]);
    const c = makeCase();

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok', `gate must not fail: ${JSON.stringify(result)}`);
    // Only ONE call must reach the real llm — the extractor. SkillJudge is intercepted.
    assert.equal(llm.requests.length, 1,
      `expected 1 real LLM call (extractor), got ${llm.requests.length}`);
  });

  it('gate decision is correct even when SkillJudge would have needed a real LLM hit', async () => {
    // If the canned accept didn't work, the SkillJudge call would throw (queue exhausted),
    // and the generator would swallow it (returning null). The gate would then see no
    // recorded raw text and return { status: failed }.
    // If the gate returns ok, the canned accept worked.
    const llm = makeMockLLM([VALID_SKILL_MD]); // only one response — SkillJudge must use canned
    const c = makeCase();

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.equal(result.status, 'ok',
      'with a single scripted response, canned accept must keep the gate working');
    if (result.status !== 'ok') return;
    assert.equal(result.output.decision, 'generate');
  });
});

// ── (4) Null recorded raw → { status: failed } ───────────────────────────────

describe('runSkillGeneratorGate — null recorded raw (ADR-002)', () => {
  it('returns { status: failed } when the extractor LLM call throws (generator swallows, raw stays null)', async () => {
    // The throwing LLM causes the first complete() to throw. The generator's afterStory()
    // catches the error and returns null. The recording client never records — raw stays null.
    const c = makeCase();

    const result = await runSkillGeneratorGate(c, {
      llm: makeThrowingLLM('extractor LLM outage'),
      gateModel: 'haiku-test',
    });

    assert.equal(result.status, 'failed',
      'null recorded raw must produce { status: failed }');
  });

  it('gate never throws — always returns ok or failed', async () => {
    const c = makeCase();
    let threw = false;
    try {
      await runSkillGeneratorGate(c, { llm: makeThrowingLLM(), gateModel: 'haiku-test' });
    } catch {
      threw = true;
    }
    assert.ok(!threw, 'runSkillGeneratorGate must never throw past the boundary');
  });
});

// ── (5) Isolation — T2 / NFR-1/4 ─────────────────────────────────────────────

describe('runSkillGeneratorGate — isolation (T2, NFR-1/4)', () => {
  it('nothing is written to the repo .loom/skills/ after a generate case', async () => {
    const llm = makeMockLLM([VALID_SKILL_MD]);
    const c = makeCase();

    await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    // Anchor to the monorepo root. LOOM_REPO_ROOT env var wins when set (e.g. CI);
    // otherwise walk up from __dirname (CJS, compiled to dist/eval/skill-generator/__tests__/).
    const repoRoot = process.env['LOOM_REPO_ROOT'] ?? path.resolve(__dirname, '../../../../../../');
    const repoSkillsDir = path.join(repoRoot, '.loom', 'skills');
    if (fs.existsSync(repoSkillsDir)) {
      const files = fs.readdirSync(repoSkillsDir);
      const evalWritten = files.filter((f) => f.includes('eval-test'));
      assert.equal(evalWritten.length, 0,
        `gate must not write to repo .loom/skills/; found: ${evalWritten.join(', ')}`);
    }
    // If the dir doesn't exist, we're fine — the gate definitely didn't write there.
  });

  it('nothing is written to ~/.loom/skills/generated/ after a generate case', async () => {
    const llm = makeMockLLM([VALID_SKILL_MD]);
    const c = makeCase();
    const globalGeneratedDir = path.join(os.homedir(), '.loom', 'skills', 'generated');
    const beforeFiles = fs.existsSync(globalGeneratedDir)
      ? fs.readdirSync(globalGeneratedDir)
      : [];

    await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    const afterFiles = fs.existsSync(globalGeneratedDir)
      ? fs.readdirSync(globalGeneratedDir)
      : [];
    assert.deepEqual(afterFiles, beforeFiles,
      '~/.loom/skills/generated/ must not be modified by the gate runner');
  });

  it('parallel invocations are independently isolated — no cross-case leakage', async () => {
    const c1 = makeCase({ id: 'iso-case-001' });
    const c2 = makeCase({ id: 'iso-case-002' });

    // Each case uses its own fresh :memory: db.
    const [r1, r2] = await Promise.all([
      runSkillGeneratorGate(c1, { llm: makeMockLLM([VALID_SKILL_MD]), gateModel: DEFAULT_GATE_MODEL }),
      runSkillGeneratorGate(c2, { llm: makeMockLLM(['NONE']), gateModel: DEFAULT_GATE_MODEL }),
    ]);

    assert.equal(r1.status, 'ok', 'case 1 must succeed independently');
    assert.equal(r2.status, 'ok', 'case 2 must succeed independently');
    if (r1.status === 'ok') assert.equal(r1.output.decision, 'generate');
    if (r2.status === 'ok') assert.equal(r2.output.decision, 'none');
  });
});

// ── (6) DB marshaling — seeded data reaches the generator ────────────────────

describe('runSkillGeneratorGate — DB marshaling (seeded data reaches the generator)', () => {
  it('seeded diff_context appears in the LLM extractor prompt (AgentStore log_tail)', async () => {
    let capturedSystem = '';
    const llm: LLMClient = {
      async complete(req) {
        capturedSystem = req.system.map((b) => b.text).join('\n');
        return { text: 'NONE', model: req.model, stopReason: 'end_turn', usage: { ...EMPTY_USAGE } };
      },
    };
    const diffContext = '+const iso = createDatabase(":memory:");\n// unique diff marker abc123';
    const c = makeCase({ work: { ...makeCase().work, diff_context: diffContext } });

    await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.ok(
      capturedSystem.includes('abc123'),
      `diff_context must appear in the extractor system prompt; got: ${capturedSystem.slice(0, 400)}`,
    );
  });

  it('seeded summary appears in the LLM extractor prompt (AuditLog completion.detail.summary)', async () => {
    let capturedSystem = '';
    const llm: LLMClient = {
      async complete(req) {
        capturedSystem = req.system.map((b) => b.text).join('\n');
        return { text: 'NONE', model: req.model, stopReason: 'end_turn', usage: { ...EMPTY_USAGE } };
      },
    };
    const summary = 'Worker completed isolation work — unique-summary-marker-xyz789';
    const c = makeCase({ work: { ...makeCase().work, summary } });

    await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.ok(
      capturedSystem.includes('xyz789'),
      `summary must appear in the extractor system prompt; got: ${capturedSystem.slice(0, 400)}`,
    );
  });
});

// ── Model selection ───────────────────────────────────────────────────────────

describe('runSkillGeneratorGate — model selection', () => {
  it('DEFAULT_GATE_MODEL is claude-haiku-4-5-20251001 (safe default)', () => {
    assert.equal(DEFAULT_GATE_MODEL, 'claude-haiku-4-5-20251001');
  });

  it('LOOM_EVAL_GATE_MODEL env var overrides the default via resolveSkillGeneratorModels', () => {
    const saved = process.env.LOOM_EVAL_GATE_MODEL;
    try {
      process.env.LOOM_EVAL_GATE_MODEL = 'env-override-haiku';
      const { gateModel } = resolveSkillGeneratorModels();
      assert.equal(gateModel, 'env-override-haiku');
    } finally {
      if (saved === undefined) delete process.env.LOOM_EVAL_GATE_MODEL;
      else process.env.LOOM_EVAL_GATE_MODEL = saved;
    }
  });

  it('deps.gateModel is forwarded to the first extractor LLM call', async () => {
    const specificModel = 'claude-probe-model-for-rungate-test';
    const llm = makeMockLLM(['NONE']);
    const c = makeCase();

    await runSkillGeneratorGate(c, { llm, gateModel: specificModel });

    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0].model, specificModel,
      'extractor call must use the exact gateModel from deps');
  });

  it('does not read LOOM_EVAL_GATE_MODEL internally — model is resolved upstream by deps', async () => {
    const saved = process.env.LOOM_EVAL_GATE_MODEL;
    try {
      process.env.LOOM_EVAL_GATE_MODEL = 'env-model-must-be-ignored';
      const depsModel = 'deps-resolved-model-xyz';
      const llm = makeMockLLM(['NONE']);
      const c = makeCase();

      await runSkillGeneratorGate(c, { llm, gateModel: depsModel });

      assert.equal(llm.requests[0].model, depsModel,
        'gate must use deps.gateModel, not the env var');
    } finally {
      if (saved === undefined) delete process.env.LOOM_EVAL_GATE_MODEL;
      else process.env.LOOM_EVAL_GATE_MODEL = saved;
    }
  });
});

// ── SkillGenerator unchanged ──────────────────────────────────────────────────

describe('runSkillGeneratorGate — production SkillGenerator is byte-unchanged', () => {
  it('uses the production SkillGenerator class (not a reimplementation)', async () => {
    // The import itself is the assertion: if SkillGenerator was replaced, this module
    // would need to import something else. We verify the gate runs end-to-end using
    // the real class by confirming the prompt contains the skill-extractor template
    // (which only the real class loads via loadBundledPrompt('skill-extractor')).
    let capturedSystem = '';
    const llm: LLMClient = {
      async complete(req) {
        capturedSystem = req.system.map((b) => b.text).join('\n');
        return { text: 'NONE', model: req.model, stopReason: 'end_turn', usage: { ...EMPTY_USAGE } };
      },
    };
    const c = makeCase();

    const result = await runSkillGeneratorGate(c, { llm, gateModel: 'haiku-test' });

    assert.ok(result.status === 'ok' || result.status === 'failed',
      'gate must return a GateOutcome');
    // "agentskills.io-format" is a phrase unique to the bundled skill-extractor prompt —
    // if the runner swapped in a hand-rolled prompt, this assertion fails.
    assert.ok(
      capturedSystem.includes('agentskills.io-format'),
      `system prompt must contain the skill-extractor bundled template phrase; got: ${capturedSystem.slice(0, 400)}`,
    );
  });
});
