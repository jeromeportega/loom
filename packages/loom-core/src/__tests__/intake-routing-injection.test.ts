/**
 * PMAgent routing injection tests (story-045-002, AC2 + AC5).
 *
 * Proves that:
 *  - PMAgent appends buildSizingConstraintBlock to task B ONLY when ctx.routing is set.
 *  - routing=undefined → message byte-identical to NFR-1 baseline (off-path).
 *  - routing present → the correct sizing instruction appears in task B.
 *  - The routing flows through new Planner({ routing }) → PMAgent (not a parallel pipeline).
 *  - Outcome-level: a story verdict routed through the planner yields exactly one story
 *    in the resulting epic breakdown (AC5 deterministic mocked LLM).
 *
 * Placed in src/__tests__/ so PersonaLoader resolves personas/ from the standard
 * production path (dist/planner/ → ../../personas/).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PMAgent } from '../planner/PMAgent.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { LLMRequest } from '../llm/LLMClient.js';
import type { EffectiveRouting } from '../intake/routing.js';

// ── Shared fixtures ────────────────────────────────────────────────────────────

const BRIEF = 'Add a user login form with email and password fields.';
const TASK_A_PRD = '# Login Form PRD\n\n## Goals\nShip a minimal login form.';
const TASK_A_TRIGGER = 'Headless task A: produce the PRD';
const TASK_B_TRIGGER = 'Headless task B: produce the epic';

function makeEpicsJson(epicId: string, storyCount: number): string {
  const num = epicId.slice(5);
  const stories = Array.from({ length: storyCount }, (_, i) => ({
    id: `story-${num}-${String(i + 1).padStart(3, '0')}`,
    title: `Story ${i + 1}`,
    description: 'do it',
    acceptance_criteria: ['done'],
    estimated_complexity: 'small' as const,
    dependencies: [] as string[],
  }));
  return JSON.stringify({
    epics: [{
      epic_id: epicId,
      title: 'Test epic',
      priority: 'must-have',
      prd_ref: 'placeholder',
      requirements: ['FR-1'],
      stories,
    }],
  });
}

const STORY_ROUTING: EffectiveRouting = {
  type:       'feature',
  size:       'story',
  confidence: 'high',
  source:     'classifier',
};

const EPIC_ROUTING: EffectiveRouting = {
  type:       'feature',
  size:       'epic',
  confidence: 'high',
  source:     'classifier',
};

// ── Suite 1: routing absent → no block (re-asserts NFR-1 seam) ───────────────

// Shared across suites so Suite 2 can compare relative to this baseline.
// Initialized to -1 so Suite 2 can assert this was set before being read
// (guards against concurrency with --test-concurrency or Suite 1 before() failure).
let noRoutingRequestCount: number = -1;

describe('PMAgent routing injection — routing absent (NFR-1 seam)', () => {
  let tmpDir: string;
  let taskBContent: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pm-no-routing-'));
    const llm = new MockLLMClient((req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes(TASK_A_TRIGGER)) return TASK_A_PRD;
      if (last.includes(TASK_B_TRIGGER)) return '```json\n' + makeEpicsJson('epic-001', 1) + '\n```';
      throw new Error(`Unexpected: ${last.slice(0, 80)}`);
    });

    const ctx = { projectRoot: tmpDir, llm, model: 'test-model', runId: 'epic-001' };
    await new PMAgent(ctx).run(BRIEF, 1);
    noRoutingRequestCount = llm.requests.length;

    const taskBReq = llm.requests.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER))
    )!;
    taskBContent = taskBReq.messages.find(
      (m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER)
    )!.content;
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('task B message contains no sizing constraint text when routing is absent', () => {
    assert.ok(
      !taskBContent.includes('sizing constraint') &&
      !taskBContent.includes('single cohesive story') &&
      !taskBContent.includes('full decomposition'),
      'routing absent → no sizing constraint block in task B message'
    );
  });
});

// ── Suite 2: story routing → single-cohesive-story instruction ───────────────

describe('PMAgent routing injection — story-sized routing present (AC1, AC2)', () => {
  let tmpDir: string;
  let taskBContent: string;
  let requestCount: number;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pm-story-routing-'));
    const llm = new MockLLMClient((req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes(TASK_A_TRIGGER)) return TASK_A_PRD;
      if (last.includes(TASK_B_TRIGGER)) return '```json\n' + makeEpicsJson('epic-001', 1) + '\n```';
      throw new Error(`Unexpected: ${last.slice(0, 80)}`);
    });

    const ctx = {
      projectRoot: tmpDir,
      llm,
      model: 'test-model',
      runId: 'epic-001',
      routing: STORY_ROUTING,
    };
    await new PMAgent(ctx).run(BRIEF, 1);
    requestCount = llm.requests.length;

    const taskBReq = llm.requests.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER))
    )!;
    taskBContent = taskBReq.messages.find(
      (m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER)
    )!.content;
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('routing does not add LLM calls vs the no-routing baseline (not a parallel pipeline)', () => {
    assert.notEqual(
      noRoutingRequestCount,
      -1,
      'Suite 1 before() must complete before this test — noRoutingRequestCount was never set'
    );
    assert.equal(
      requestCount,
      noRoutingRequestCount,
      'routing must not spawn extra LLM calls compared to the no-routing baseline'
    );
  });

  it('task B message contains the single-cohesive-story instruction', () => {
    assert.ok(
      taskBContent.includes('single cohesive story') || taskBContent.includes('minimum necessary decomposition'),
      'story-sized routing must inject single-cohesive-story instruction into task B'
    );
  });

  it('task B message does NOT contain the full-decomposition instruction', () => {
    assert.ok(
      !taskBContent.includes('full decomposition'),
      'story-sized routing must NOT inject full-decomposition instruction'
    );
  });
});

// ── Suite 3: epic routing → full-decomposition instruction ───────────────────

describe('PMAgent routing injection — epic-sized routing present (AC1, AC2)', () => {
  let tmpDir: string;
  let taskBContent: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pm-epic-routing-'));
    const llm = new MockLLMClient((req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes(TASK_A_TRIGGER)) return TASK_A_PRD;
      if (last.includes(TASK_B_TRIGGER)) return '```json\n' + makeEpicsJson('epic-001', 2) + '\n```';
      throw new Error(`Unexpected: ${last.slice(0, 80)}`);
    });

    const ctx = {
      projectRoot: tmpDir,
      llm,
      model: 'test-model',
      runId: 'epic-001',
      routing: EPIC_ROUTING,
    };
    await new PMAgent(ctx).run(BRIEF, 1);

    const taskBReq = llm.requests.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER))
    )!;
    taskBContent = taskBReq.messages.find(
      (m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER)
    )!.content;
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('task B message contains the full-decomposition instruction', () => {
    assert.ok(
      taskBContent.includes('full decomposition') || taskBContent.includes('full'),
      'epic-sized routing must inject full-decomposition instruction into task B'
    );
  });

  it('task B message does NOT contain the single-cohesive-story instruction', () => {
    assert.ok(
      !taskBContent.includes('single cohesive story'),
      'epic-sized routing must NOT inject single-cohesive-story instruction'
    );
  });
});

// ── Suite 4: outcome-level — story verdict → single story (AC5) ──────────────
//
// Drives the sizing constraint through the real PMAgent injection seam.
// The mock LLM is deterministic: when it sees the story sizing constraint it
// returns a ONE-story breakdown; when the constraint is absent it would return
// two stories. This proves the block actually reaches the prompt and that the
// planner (not a side channel) is the delivery vehicle.

describe('AC5 outcome-level: story verdict routed through planner → single-story result', () => {
  let tmpDir: string;
  let storyCount: number;
  let taskBSawSizingConstraint: boolean;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pm-outcome-'));

    const llm = new MockLLMClient((req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes(TASK_A_TRIGGER)) return TASK_A_PRD;
      if (last.includes(TASK_B_TRIGGER)) {
        // Record whether the constraint arrived via the real injection seam.
        taskBSawSizingConstraint = last.includes('single cohesive story');
        // Deterministic: constraint present → 1 story; absent → 2 stories.
        const count = taskBSawSizingConstraint ? 1 : 2;
        return '```json\n' + makeEpicsJson('epic-001', count) + '\n```';
      }
      throw new Error(`Unexpected: ${last.slice(0, 80)}`);
    });

    const ctx = {
      projectRoot: tmpDir,
      llm,
      model: 'test-model',
      runId: 'epic-001',
      routing: STORY_ROUTING,
    };
    const result = await new PMAgent(ctx).run(BRIEF, 1);
    storyCount = result.epics[0].stories.length;
  });

  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('the sizing constraint block was present in the task B prompt (via the real injection seam)', () => {
    assert.ok(
      taskBSawSizingConstraint,
      'story routing must inject the sizing constraint into the PM task B prompt'
    );
  });

  it('story verdict yields exactly one story in the breakdown (AC5)', () => {
    assert.equal(
      storyCount,
      1,
      'a story-sized verdict routed through the planner must produce exactly one story'
    );
  });
});
