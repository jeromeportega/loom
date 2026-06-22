import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSkillGeneratorModels,
  DEFAULT_GATE_MODEL,
  DEFAULT_JUDGE_MODEL,
} from '../models.js';

// ── Env isolation ─────────────────────────────────────────────────────────────

let savedGate:  string | undefined;
let savedJudge: string | undefined;

beforeEach(() => {
  savedGate  = process.env.LOOM_EVAL_GATE_MODEL;
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

// ── Exported constants ────────────────────────────────────────────────────────

describe('models — exported constants', () => {
  it('DEFAULT_GATE_MODEL equals the production skill_gen_model', () => {
    assert.equal(DEFAULT_GATE_MODEL, 'claude-haiku-4-5-20251001');
  });

  it('DEFAULT_JUDGE_MODEL re-exports claude-opus-4-8 from framework', () => {
    assert.equal(DEFAULT_JUDGE_MODEL, 'claude-opus-4-8');
  });

  it('DEFAULT_GATE_MODEL and DEFAULT_JUDGE_MODEL are distinct', () => {
    assert.notEqual(DEFAULT_GATE_MODEL, DEFAULT_JUDGE_MODEL);
  });
});

// ── Default resolution (no opts, no env) ─────────────────────────────────────

describe('resolveSkillGeneratorModels — defaults when no opts and env unset', () => {
  it('gateModel defaults to DEFAULT_GATE_MODEL', () => {
    const { gateModel } = resolveSkillGeneratorModels();
    assert.equal(gateModel, DEFAULT_GATE_MODEL);
  });

  it('judgeModel defaults to DEFAULT_JUDGE_MODEL', () => {
    const { judgeModel } = resolveSkillGeneratorModels();
    assert.equal(judgeModel, DEFAULT_JUDGE_MODEL);
  });

  it('returns defaults when called with empty opts object', () => {
    const { gateModel, judgeModel } = resolveSkillGeneratorModels({});
    assert.equal(gateModel, DEFAULT_GATE_MODEL);
    assert.equal(judgeModel, DEFAULT_JUDGE_MODEL);
  });
});

// ── opts take highest precedence ─────────────────────────────────────────────

describe('resolveSkillGeneratorModels — opts override env and defaults (FR-7)', () => {
  it('opts.gateModel wins over LOOM_EVAL_GATE_MODEL env', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'env-gate';
    const { gateModel } = resolveSkillGeneratorModels({ gateModel: 'opts-gate' });
    assert.equal(gateModel, 'opts-gate');
  });

  it('opts.gateModel wins over default when env is unset', () => {
    const { gateModel } = resolveSkillGeneratorModels({ gateModel: 'explicit-gate' });
    assert.equal(gateModel, 'explicit-gate');
  });

  it('opts.judgeModel wins over LOOM_EVAL_JUDGE_MODEL env', () => {
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-judge';
    const { judgeModel } = resolveSkillGeneratorModels({ judgeModel: 'opts-judge' });
    assert.equal(judgeModel, 'opts-judge');
  });

  it('opts.judgeModel wins over default when env is unset', () => {
    const { judgeModel } = resolveSkillGeneratorModels({ judgeModel: 'explicit-judge' });
    assert.equal(judgeModel, 'explicit-judge');
  });

  it('opts overrides both models independently', () => {
    process.env.LOOM_EVAL_GATE_MODEL  = 'env-gate';
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-judge';
    const { gateModel, judgeModel } = resolveSkillGeneratorModels({
      gateModel:  'opts-gate',
      judgeModel: 'opts-judge',
    });
    assert.equal(gateModel, 'opts-gate');
    assert.equal(judgeModel, 'opts-judge');
  });
});

// ── Env overrides defaults (second rung) ─────────────────────────────────────

describe('resolveSkillGeneratorModels — env overrides default (second rung)', () => {
  it('LOOM_EVAL_GATE_MODEL overrides DEFAULT_GATE_MODEL when opts.gateModel unset', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'env-gate-override';
    const { gateModel } = resolveSkillGeneratorModels();
    assert.equal(gateModel, 'env-gate-override');
  });

  it('LOOM_EVAL_JUDGE_MODEL overrides DEFAULT_JUDGE_MODEL when opts.judgeModel unset', () => {
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-judge-override';
    const { judgeModel } = resolveSkillGeneratorModels();
    assert.equal(judgeModel, 'env-judge-override');
  });

  it('gate env does not affect judgeModel', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'env-gate-only';
    const { judgeModel } = resolveSkillGeneratorModels();
    assert.equal(judgeModel, DEFAULT_JUDGE_MODEL);
  });

  it('judge env does not affect gateModel', () => {
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-judge-only';
    const { gateModel } = resolveSkillGeneratorModels();
    assert.equal(gateModel, DEFAULT_GATE_MODEL);
  });

  it('both env vars set independently', () => {
    process.env.LOOM_EVAL_GATE_MODEL  = 'env-g';
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-j';
    const { gateModel, judgeModel } = resolveSkillGeneratorModels();
    assert.equal(gateModel, 'env-g');
    assert.equal(judgeModel, 'env-j');
  });
});

// ── undefined opts fields fall through correctly ──────────────────────────────

describe('resolveSkillGeneratorModels — undefined opts fields fall through correctly', () => {
  it('opts.gateModel undefined falls through to env', () => {
    process.env.LOOM_EVAL_GATE_MODEL = 'env-gate-fallthrough';
    const { gateModel } = resolveSkillGeneratorModels({ gateModel: undefined });
    assert.equal(gateModel, 'env-gate-fallthrough');
  });

  it('opts.judgeModel undefined falls through to env', () => {
    process.env.LOOM_EVAL_JUDGE_MODEL = 'env-judge-fallthrough';
    const { judgeModel } = resolveSkillGeneratorModels({ judgeModel: undefined });
    assert.equal(judgeModel, 'env-judge-fallthrough');
  });

  it('opts.gateModel undefined falls through to default when env also unset', () => {
    const { gateModel } = resolveSkillGeneratorModels({ gateModel: undefined });
    assert.equal(gateModel, DEFAULT_GATE_MODEL);
  });
});
