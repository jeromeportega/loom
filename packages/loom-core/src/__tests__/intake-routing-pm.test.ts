/**
 * NFR-1 off-path PM message output-equivalence (story-045-001).
 *
 * Proves that when PlannerOptions.routing is absent (intake_routing = 'off'),
 * the PM agent's task B user message is byte-identical to the known baseline.
 *
 * Placed in src/__tests__/ (compiles to dist/__tests__/) so that PersonaLoader
 * resolves personas/ via path.resolve(__dirname, '../../personas') from
 * dist/planner/ — the standard loom-core production path. The test/ directory
 * compiles to dist-test/src/planner/ where that resolution fails.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PMAgent } from '../planner/PMAgent.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { LLMRequest } from '../llm/LLMClient.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const BRIEF = 'Add a user login form with email and password fields.';

// Task A response. Must start with '#' so trimToFirstHeading returns it unchanged.
const TASK_A_PRD = '# Login Form PRD\n\n## Goals\nShip a minimal login form.';

// Shared trigger phrases used by both the mock dispatcher and the assertions.
// Update here if PMAgent renames a task prompt — single-point change.
const TASK_A_TRIGGER = 'Headless task A: produce the PRD';
const TASK_B_TRIGGER = 'Headless task B: produce the epic';

// Snapshot of PMAgent task B user message. Compared byte-for-byte on each run.
// To regenerate: delete the .snap file and re-run the tests — the file is
// written on first run (tests pass), then committed and used for comparison.
const SNAPSHOT_FILE = path.resolve(
  __dirname,
  '../../src/__tests__/__snapshots__/task-b-baseline.snap'
);

const EPICS_JSON = JSON.stringify({
  epics: [
    {
      epic_id: 'epic-001',
      title: 'Login form',
      priority: 'must-have',
      prd_ref: 'placeholder',
      requirements: ['FR-1'],
      stories: [
        {
          id: 'story-001-001',
          title: 'Build login form',
          description: 'Implement the form.',
          acceptance_criteria: ['form renders'],
          estimated_complexity: 'small',
          dependencies: [],
        },
      ],
    },
  ],
});

// ── NFR-1 suite ───────────────────────────────────────────────────────────────

describe('NFR-1 off-path PM message output-equivalence (story-045-001)', () => {
  let tmpDir: string;
  let capturedRequests: LLMRequest[];

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nfr1-intake-routing-'));

    const llm = new MockLLMClient((req: LLMRequest): string => {
      const last = req.messages[req.messages.length - 1].content;
      if (last.includes(TASK_A_TRIGGER)) return TASK_A_PRD;
      if (last.includes(TASK_B_TRIGGER)) return '```json\n' + EPICS_JSON + '\n```';
      throw new Error(`Unexpected PM call: ${last.slice(0, 80)}`);
    });

    const ctx = {
      projectRoot: tmpDir,
      llm,
      model: 'test-model',
      runId: 'epic-001',
    };

    await new PMAgent(ctx).run(BRIEF, 1);
    capturedRequests = llm.requests;
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PMAgent makes exactly two LLM calls (task A PRD + task B epics) — no extra routing call', () => {
    assert.equal(
      capturedRequests.length,
      2,
      'PMAgent must make exactly 2 LLM calls for a clean single-epic run'
    );
  });

  it('task B user message is byte-identical to the known baseline (no routing block appended)', () => {
    const taskBReq = capturedRequests.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER))
    );
    assert.ok(taskBReq, 'Task B request must be present in captured calls');

    const taskBUserContent = taskBReq.messages.find(
      (m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER)
    )!.content;

    // Snapshot-based assertion. If missing, the file is written on first run
    // (tests pass) — commit the generated file. To regenerate after an
    // intentional PM prompt change: delete task-b-baseline.snap and re-run.
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
      fs.writeFileSync(SNAPSHOT_FILE, taskBUserContent, 'utf8');
    }
    const expectedBaseline = fs.readFileSync(SNAPSHOT_FILE, 'utf8');

    assert.equal(
      taskBUserContent,
      expectedBaseline,
      'Task B user message differs from snapshot (task-b-baseline.snap). ' +
        'If the PM prompt changed intentionally, delete the snapshot file and re-run to regenerate.'
    );
  });

  it('task B message contains no routing-specific text — PlannerOptions.routing is absent on the off-path', () => {
    const taskBReq = capturedRequests.find((r) =>
      r.messages.some((m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER))
    );
    assert.ok(taskBReq, 'Task B request must be present');

    const content = taskBReq.messages.find(
      (m) => m.role === 'user' && m.content.includes(TASK_B_TRIGGER)
    )!.content;

    // If story-045-002 accidentally injects routing on the off-path, these
    // routing-specific markers would appear in the message.
    assert.ok(
      !content.includes('sizing constraint') &&
        !content.includes('source:') &&
        !content.includes('EffectiveRouting') &&
        !content.includes('single cohesive story'),
      'task B message must not contain routing-specific text when routing is absent'
    );
  });
});
