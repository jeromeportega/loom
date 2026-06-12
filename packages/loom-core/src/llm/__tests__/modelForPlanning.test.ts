import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelFor } from '../factory.js';
import { MockLLMClient } from '../MockLLMClient.js';
import { BriefRefiner } from '../../brief/BriefRefiner.js';
import { AnalystAgent } from '../../planner/AnalystAgent.js';
import { PolicySchema } from '../../types.js';

/**
 * Pins the refiner/planner model-routing contract (epic-001 §3): both entry
 * points construct the BriefRefiner with `modelFor(policy, 'planning')` — the
 * same resolution the Planner uses, including the cursor_model short-circuit —
 * and NEVER `policy.agents.model` (the worker-tier model).
 *
 * The worker model is set to a distinct sentinel throughout so any regression
 * back to `policy.agents.model` fails loudly rather than passing vacuously.
 */

const WORKER_SENTINEL = 'sentinel-worker-model-not-for-planning';
const CURSOR_PINNED = 'cursor-pinned-model-4';

// A minimal valid refiner response; these tests only assert the model id on
// the wire, not the refinement content.
const REFINER_JSON =
  '```json\n' +
  JSON.stringify({
    ready: true,
    refined_brief: '# Brief',
    critique: {
      strong_points: [],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  }) +
  '\n```';

describe('modelFor — planning-role resolution (refiner/planner routing)', () => {
  it('claude-cli: resolves the planning model, never the worker model', () => {
    const policy = PolicySchema.parse({ agents: { model: WORKER_SENTINEL } });
    assert.equal(modelFor(policy, 'planning'), 'claude-opus-4-7');
    assert.notEqual(modelFor(policy, 'planning'), policy.agents.model);
  });

  it('claude-cli: honors an explicit planning_model override', () => {
    const policy = PolicySchema.parse({
      agents: { model: WORKER_SENTINEL, planning_model: 'claude-opus-9-9' },
    });
    assert.equal(modelFor(policy, 'planning'), 'claude-opus-9-9');
  });

  it('cursor-cli: short-circuits to cursor_model — no Claude-namespaced id', () => {
    const policy = PolicySchema.parse({
      agents: {
        llm_backend: 'cursor-cli',
        model: WORKER_SENTINEL,
        cursor_model: CURSOR_PINNED,
        planning_model: 'claude-opus-4-7',
      },
    });
    const resolved = modelFor(policy, 'planning');
    // Pin the literal: equality-with-modelFor alone would pass vacuously if
    // modelFor itself regressed.
    assert.equal(resolved, CURSOR_PINNED);
    assert.notEqual(resolved, policy.agents.model);
    assert.notEqual(resolved, policy.agents.planning_model);
    assert.ok(!resolved.startsWith('claude-'));
  });

  it('guard: the worker-model sentinel never resolves for planning on either backend', () => {
    for (const llm_backend of ['claude-cli', 'cursor-cli'] as const) {
      const policy = PolicySchema.parse({
        agents: { llm_backend, model: WORKER_SENTINEL },
      });
      assert.notEqual(modelFor(policy, 'planning'), WORKER_SENTINEL);
    }
  });
});

describe('BriefRefiner / Planner — identical model on the wire (contract §3)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-modelfor-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function refinerWireModel(policy: ReturnType<typeof PolicySchema.parse>): Promise<string> {
    const llm = new MockLLMClient([REFINER_JSON]);
    const refiner = new BriefRefiner({
      projectRoot: tmpDir,
      llm,
      model: modelFor(policy, 'planning'),
    });
    await refiner.refine('a rough brief that needs refining');
    return llm.requests[0].model;
  }

  async function plannerWireModel(policy: ReturnType<typeof PolicySchema.parse>): Promise<string> {
    const llm = new MockLLMClient(['# Brief\n\nbody']);
    await new AnalystAgent({
      projectRoot: tmpDir,
      llm,
      model: modelFor(policy, 'planning'),
      runId: 'epic-001',
    }).run('a rough brief that needs refining');
    return llm.requests[0].model;
  }

  it('claude-cli: refiner and planner send the same planning model, not the worker sentinel', async () => {
    const policy = PolicySchema.parse({ agents: { model: WORKER_SENTINEL } });
    const refinerModel = await refinerWireModel(policy);
    const plannerModel = await plannerWireModel(policy);
    assert.equal(refinerModel, plannerModel);
    assert.equal(refinerModel, modelFor(policy, 'planning'));
    assert.equal(refinerModel, 'claude-opus-4-7');
    assert.notEqual(refinerModel, WORKER_SENTINEL);
  });

  it('cursor-cli: refiner and planner both send the pinned cursor_model', async () => {
    const policy = PolicySchema.parse({
      agents: {
        llm_backend: 'cursor-cli',
        model: WORKER_SENTINEL,
        cursor_model: CURSOR_PINNED,
      },
    });
    const refinerModel = await refinerWireModel(policy);
    const plannerModel = await plannerWireModel(policy);
    assert.equal(refinerModel, plannerModel);
    assert.equal(refinerModel, CURSOR_PINNED);
    assert.notEqual(refinerModel, WORKER_SENTINEL);
    assert.ok(!refinerModel.startsWith('claude-'));
  });
});
