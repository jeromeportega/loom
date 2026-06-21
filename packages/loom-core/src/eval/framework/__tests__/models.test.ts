import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEvalModels, DEFAULT_JUDGE_MODEL } from '../models.js';
import { PolicySchema } from '../../../types.js';
import { modelFor } from '../../../llm/factory.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePolicy(overrides: Record<string, unknown> = {}) {
  return PolicySchema.parse({ agents: overrides });
}

// Save and restore env vars around each test
let savedGate: string | undefined;
let savedJudge: string | undefined;

beforeEach(() => {
  savedGate = process.env.LOOM_EVAL_GATE_MODEL;
  savedJudge = process.env.LOOM_EVAL_JUDGE_MODEL;
  delete process.env.LOOM_EVAL_GATE_MODEL;
  delete process.env.LOOM_EVAL_JUDGE_MODEL;
});

afterEach(() => {
  if (savedGate === undefined) {
    delete process.env.LOOM_EVAL_GATE_MODEL;
  } else {
    process.env.LOOM_EVAL_GATE_MODEL = savedGate;
  }
  if (savedJudge === undefined) {
    delete process.env.LOOM_EVAL_JUDGE_MODEL;
  } else {
    process.env.LOOM_EVAL_JUDGE_MODEL = savedJudge;
  }
});

// ── Defaults when env is unset — AC4 ─────────────────────────────────────────

describe('resolveEvalModels — env unset → defaults (AC4)', () => {
  it('gateModel defaults to modelFor(policy, planning) when LOOM_EVAL_GATE_MODEL is unset', () => {
    const policy = makePolicy();
    const { gateModel } = resolveEvalModels(policy);
    assert.equal(gateModel, modelFor(policy, 'planning'));
  });

  it('judgeModel defaults to DEFAULT_JUDGE_MODEL when LOOM_EVAL_JUDGE_MODEL is unset', () => {
    const policy = makePolicy();
    const { judgeModel } = resolveEvalModels(policy);
    assert.equal(judgeModel, DEFAULT_JUDGE_MODEL);
    assert.equal(judgeModel, 'claude-opus-4-8');
  });

  it('defaults are independent of each other', () => {
    const policy = makePolicy();
    const { gateModel, judgeModel } = resolveEvalModels(policy);
    assert.notEqual(gateModel, judgeModel, 'gate and judge defaults must be distinct');
  });
});

// ── LOOM_EVAL_GATE_MODEL overrides gate model independently ──────────────────

describe('resolveEvalModels — LOOM_EVAL_GATE_MODEL overrides gate', () => {
  it('LOOM_EVAL_GATE_MODEL overrides gateModel while judgeModel stays default', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'custom-gate-model';
    const policy = makePolicy();
    const { gateModel, judgeModel } = resolveEvalModels(policy);
    assert.equal(gateModel, 'custom-gate-model');
    assert.equal(judgeModel, DEFAULT_JUDGE_MODEL, 'judgeModel unaffected by gate override');
  });
});

// ── LOOM_EVAL_JUDGE_MODEL overrides judge model independently ─────────────────

describe('resolveEvalModels — LOOM_EVAL_JUDGE_MODEL overrides judge', () => {
  it('LOOM_EVAL_JUDGE_MODEL overrides judgeModel while gateModel stays default', () => {
    process.env.LOOM_EVAL_JUDGE_MODEL = 'custom-judge-model';
    const policy = makePolicy();
    const { gateModel, judgeModel } = resolveEvalModels(policy);
    assert.equal(gateModel, modelFor(policy, 'planning'), 'gateModel unaffected by judge override');
    assert.equal(judgeModel, 'custom-judge-model');
  });
});

// ── Both env vars set → both override independently ──────────────────────────

describe('resolveEvalModels — both env vars override independently', () => {
  it('both LOOM_EVAL_GATE_MODEL and LOOM_EVAL_JUDGE_MODEL override independently', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'my-gate-model';
    process.env.LOOM_EVAL_JUDGE_MODEL = 'my-judge-model';
    const policy = makePolicy();
    const { gateModel, judgeModel } = resolveEvalModels(policy);
    assert.equal(gateModel, 'my-gate-model');
    assert.equal(judgeModel, 'my-judge-model');
  });
});

// ── cursor-cli policy follows modelFor short-circuit ─────────────────────────

describe('resolveEvalModels — gateModel follows modelFor for cursor-cli backend', () => {
  it('uses cursor_model when policy uses cursor-cli backend and env is unset', () => {
    const policy = makePolicy({ llm_backend: 'cursor-cli', cursor_model: 'sonnet-cursor' });
    const { gateModel } = resolveEvalModels(policy);
    assert.equal(gateModel, 'sonnet-cursor', 'gate model follows cursor_model for cursor-cli');
  });

  it('env var overrides even when backend is cursor-cli', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'override-even-on-cursor';
    const policy = makePolicy({ llm_backend: 'cursor-cli', cursor_model: 'sonnet-cursor' });
    const { gateModel } = resolveEvalModels(policy);
    assert.equal(gateModel, 'override-even-on-cursor');
  });
});
