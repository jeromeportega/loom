import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MockLLMClient,
  MockWorkerRunner,
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
  Planner,
} from '@loom-ai/core';
import type {
  LLMClient,
  LLMRequest,
  LLMResponse,
} from '@loom-ai/core';
import { HANDLERS } from '../handlers.js';
import type { ToolContext } from '../context.js';

let repo: string;
let background: Promise<unknown>[];
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let currentLLM: LLMClient;

const BRIEF = 'Build a small demo feature for verifying the in-process planner continuation.';

// A responder that passes the brief-quality gate (ready: true / high score)
// then drives the full Analyst → PM → Architect chain.
function passingPipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('Apply the discipline above')) {
    return (
      '```json\n' +
      JSON.stringify({
        ready: true,
        quality_score: 9,
        refined_brief: '# Brief\n\n## Goal\nShip it.',
        critique: {
          strong_points: ['concrete goal'],
          ambiguities: [],
          missing_scope: [],
          untestable_claims: [],
          hidden_complexity: [],
        },
        questions: [],
        delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
      }) +
      '\n```'
    );
  }
  if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return (
      '```json\n' +
      JSON.stringify({
        epics: [
          {
            epic_id: eid,
            title: 'Epic produced by the planner',
            priority: 'must-have',
            prd_ref: 'x',
            requirements: ['FR-1'],
            stories: [
              {
                id: `story-${num}-001`,
                title: 'The single story',
                description: 'do it',
                acceptance_criteria: ['works'],
                estimated_complexity: 'small',
                dependencies: [],
              },
            ],
          },
        ],
      }) +
      '\n```'
    );
  }
  if (last.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message: ' + last.slice(0, 60));
}

/**
 * Wraps a responder so the FIRST planner LLM call (the Analyst persona)
 * blocks on a manually-released gate. The brief-gate refiner call runs
 * synchronously; only the planner is paused. Lets a test prove the handler
 * returns the epic id BEFORE the planner promise resolves — no sleeps, no
 * wall-clock race.
 */
function gatedPlannerLLM(): { llm: LLMClient; release: () => void; firstPlannerCallStarted: Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstPlannerCallStartedResolve!: () => void;
  const firstPlannerCallStarted = new Promise<void>((resolve) => {
    firstPlannerCallStartedResolve = resolve;
  });
  let plannerStarted = false;

  const llm: LLMClient = {
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const last = req.messages[req.messages.length - 1].content;
      const isPlannerCall = last.includes('Produce the project brief');
      if (isPlannerCall && !plannerStarted) {
        plannerStarted = true;
        firstPlannerCallStartedResolve();
        await gate; // hold the planner until the test releases it
      }
      const text = passingPipelineResponder(req);
      return { text, model: req.model, stopReason: 'end_turn', usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestCount: 1,
        costUsd: 0,
      } };
    },
  };
  return { llm, release, firstPlannerCallStarted };
}

function ctx(): ToolContext {
  return {
    projectRoot: repo,
    loomDir: path.join(repo, '.loom'),
    createLLM: () => currentLLM,
    createWorker: () => new MockWorkerRunner({ status: 'done' }),
    background: (_label, work) => background.push(work),
  };
}

function gitc(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-cont-'));
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  background = [];
  currentLLM = new MockLLMClient(passingPipelineResponder);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('loom_start_epic — in-process continuation (early epic-id return)', () => {
  it('returns a non-empty epic id BEFORE the planner promise resolves', async () => {
    const gated = gatedPlannerLLM();
    currentLLM = gated.llm;

    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as {
      status: string;
      run_id: string;
      epic_ids: string[];
    };

    // The handler resolved while the planner is still parked on the gate —
    // i.e. before its promise resolves. This is the deterministic ordering
    // assertion: id-first, planning-later.
    assert.equal(r.status, 'planning');
    assert.ok(r.run_id && r.run_id.length > 0, 'a non-empty epic id is returned');
    assert.equal(r.run_id, 'epic-001');
    assert.deepEqual(r.epic_ids, ['epic-001']);
    assert.equal(background.length, 1, 'planning was handed to the background sink');

    // Prove the planner promise is genuinely still pending: race it against a
    // resolved sentinel; the sentinel must win because the gate is unreleased.
    const sentinel = Symbol('pending');
    const winner = await Promise.race([
      background[0].then(() => 'planner-done'),
      Promise.resolve(sentinel),
    ]);
    assert.equal(winner, sentinel, 'planner promise must NOT have resolved before the early return');

    // Release the gate and let planning complete.
    gated.release();
    await Promise.all(background);
  });

  it('the returned epic id is immediately re-attachable via loom_get_status (status planning)', async () => {
    const gated = gatedPlannerLLM();
    currentLLM = gated.llm;

    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as { run_id: string };

    // Re-attach via loom_get_status while planning is still in flight — the
    // fire-and-forget did NOT drop the row.
    const status = (await HANDLERS.loom_get_status(ctx(), { epic_id: r.run_id })) as {
      epics: { id: string; status: string; stories: unknown[] }[];
    };
    assert.equal(status.epics.length, 1, 'the planning epic is visible to loom_get_status');
    assert.equal(status.epics[0].id, r.run_id);
    assert.equal(status.epics[0].status, 'planning');

    // The row carries its live planning phase (re-attachable mid-plan).
    const db = openDatabase(path.join(repo, '.loom'));
    const row = new EpicStore(db).get(r.run_id)!;
    assert.equal(row.status, 'planning');
    assert.equal(row.planning_phase, 'analyst', 'parked at the first persona while gated');

    gated.release();
    await Promise.all(background);
  });

  it('detached-exit honesty: a never-completing planner leaves the epic in planning, not done/failed', async () => {
    const gated = gatedPlannerLLM();
    currentLLM = gated.llm;

    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as { run_id: string };

    // Simulate the process never finishing planning: we never release the
    // gate. The honest state is 'planning' — not silently 'done' or 'failed'.
    const db = openDatabase(path.join(repo, '.loom'));
    const row = new EpicStore(db).get(r.run_id)!;
    assert.equal(row.status, 'planning', 'an incomplete in-process plan stays planning (honest)');
    assert.notEqual(row.status, 'done');
    assert.notEqual(row.status, 'failed');
    assert.equal(row.error, null, 'no error recorded while still planning');

    // Clean up the parked promise so the test runner can exit.
    gated.release();
    await Promise.all(background);
  });

  it('allocates the epic id EXACTLY once — the handler reserves and the planner adopts it', async () => {
    // Cross-cutting regression guard (epic-007 / FR-5 single-allocation seam):
    // the in-process continuation must reserve the row and hand the id to the
    // planner as `reservedId`, NOT compute `nextEpicId` here and let `run()`
    // self-allocate a second time. Count every `nextEpicId` call across the
    // whole start→plan flow; the contract demands exactly one.
    const gated = gatedPlannerLLM();
    currentLLM = gated.llm;

    let allocCount = 0;
    const origNext = Planner.nextEpicId;
    (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = (database) => {
      allocCount++;
      return origNext(database);
    };

    try {
      const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as {
        run_id: string;
      };
      // Reservation + adoption both finish before the gate releases, so the
      // single allocation has already happened by the time the handler returns.
      assert.equal(allocCount, 1, 'nextEpicId is called exactly once across handler + planner');
      assert.equal(r.run_id, 'epic-001');

      // The returned id maps to a reserved row carrying a DERIVED placeholder
      // title (not the bare '(planning…)' literal) — proving the handler ran
      // beginPlanning + setTitle, not just the planner's self-reservation.
      const db = openDatabase(path.join(repo, '.loom'));
      const row = new EpicStore(db).get(r.run_id)!;
      assert.equal(row.status, 'planning');
      assert.notEqual(row.title, '(planning…)', 'the handler set a derived placeholder title');
      assert.ok(row.title.length > 0);
    } finally {
      (Planner as { nextEpicId: typeof Planner.nextEpicId }).nextEpicId = origNext;
    }

    gated.release();
    await Promise.all(background);
  });

  it('a planner crash lands the epic as failed with a retrievable error — not rejected', async () => {
    // Pass the brief gate, then crash the planner's first persona call to
    // simulate an infra kill mid-plan.
    currentLLM = {
      async complete(req: LLMRequest): Promise<LLMResponse> {
        const last = req.messages[req.messages.length - 1].content;
        if (last.includes('Apply the discipline above')) {
          return {
            text: passingPipelineResponder(req),
            model: req.model,
            stopReason: 'end_turn',
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              requestCount: 1,
              costUsd: 0,
            },
          };
        }
        throw new Error('planner crashed: simulated infra kill');
      },
    };

    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as {
      status: string;
      run_id: string;
    };
    assert.equal(r.status, 'planning', 'still returns early even though planning will crash');

    // The backgrounded planner rejects; swallow it (production logs it).
    await Promise.allSettled(background);

    const db = openDatabase(path.join(repo, '.loom'));
    const row = new EpicStore(db).get(r.run_id)!;
    assert.equal(row.status, 'failed', 'a crash lands as failed');
    assert.notEqual(row.status, 'rejected', 'a crash is not a human rejection');
    assert.ok(row.error && row.error.length > 0, 'the error is retrievable and non-empty');
    assert.equal(row.error, 'planner crashed: simulated infra kill');
    assert.ok(!row.error!.includes('\n'), 'the stored error is a single-line message, not a stack');
  });
});
