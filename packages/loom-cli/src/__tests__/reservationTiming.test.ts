import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resetDatabaseForTest, EMPTY_USAGE, resolveRepoStatePaths } from '@loom-ai/core';
import type { LLMClient, LLMRequest, LLMResponse } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

const PASS_REFINEMENT = {
  ready: true,
  quality_score: 9,
  refined_brief: '# Brief\n\n## Goal\nShip it.',
  critique: {
    strong_points: ['clear'],
    ambiguities: [],
    missing_scope: [],
    untestable_claims: [],
    hidden_complexity: [],
  },
  questions: [],
  delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
};

/** Scripts the four planner stages (the work after the refiner gate). */
function plannerStage(last: string): string {
  if (last.includes('Produce the project brief')) return '# Brief\n\n## The Problem\nA gap.';
  if (last.includes('Headless task A: produce the PRD')) return '# PRD\n\n## Goals\nShip it.';
  if (last.includes('Headless task B: produce the epic')) {
    const m = last.match(/starting at "(epic-\d+)"/);
    const eid = m ? m[1] : 'epic-001';
    const num = eid.slice(5);
    return jsonBlock({
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
    });
  }
  if (last.includes('Headless task A: produce the architecture'))
    return '# Architecture\n\n## Architecture Philosophy\nBoring tech.';
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error('unexpected planning message: ' + last.slice(0, 60));
}

function isRefinerCall(req: LLMRequest): boolean {
  return req.messages[req.messages.length - 1].content.includes('Apply the discipline above');
}

function asResponse(req: LLMRequest, text: string): LLMResponse {
  return { text, model: req.model, stopReason: 'end_turn', usage: { ...EMPTY_USAGE } };
}

/**
 * An LLMClient whose refiner call is gated on a controllable deferred. The
 * test resolves the gate only AFTER it has inspected the DB mid-flight, so we
 * assert the reserved row is durable BEFORE the first await completes — with
 * NO sleeps/timers.
 */
class GatedRefinerClient implements LLMClient {
  constructor(
    private gate: Promise<void>,
    private opts: { onRefinerCalled?: () => void } = {}
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    if (isRefinerCall(req)) {
      this.opts.onRefinerCalled?.();
      await this.gate;
      return asResponse(req, jsonBlock(PASS_REFINEMENT));
    }
    return asResponse(req, plannerStage(req.messages[req.messages.length - 1].content));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Reads an epic row via an independent connection — does NOT touch the cached
 *  singleton the in-flight runEpic is still using. */
function epicRowViaFreshConn(id: string): {
  id: string;
  title: string;
  status: string;
  planning_phase: string | null;
} | undefined {
  const { dbPath } = resolveRepoStatePaths(tmpDir, {});
  const probe = new Database(dbPath, { readonly: true });
  try {
    return probe.prepare('SELECT id, title, status, planning_phase FROM epics WHERE id = ?').get(id) as
      | { id: string; title: string; status: string; planning_phase: string | null }
      | undefined;
  } finally {
    probe.close();
  }
}

function allEpicIdsViaFreshConn(): string[] {
  const { dbPath } = resolveRepoStatePaths(tmpDir, {});
  const probe = new Database(dbPath, { readonly: true });
  try {
    return (probe.prepare('SELECT id FROM epics ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id
    );
  } finally {
    probe.close();
  }
}

async function runEpicCapture(brief: string, llm: LLMClient): Promise<number | null> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = () => {};
  console.error = () => {};
  try {
    await runEpic(brief, { llm });
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return exitCode;
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reservation-cli-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: tmpDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpDir });
  execFileSync('node', [LOOM_CLI, 'init'], { cwd: tmpDir, stdio: 'ignore' });

  prevCwd = process.cwd();
  process.chdir(tmpDir);
  resetDatabaseForTest();
});

afterEach(() => {
  process.chdir(prevCwd);
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('runEpic reservation timing', () => {
  it('reserves a visible epic row with a derived title + planning phase BEFORE the refiner resolves', async () => {
    const gate = deferred();
    let midFlight: ReturnType<typeof epicRowViaFreshConn>;
    const llm = new GatedRefinerClient(gate.promise, {
      // Fires while the refiner await is still pending — snapshot durable state.
      onRefinerCalled: () => {
        midFlight = epicRowViaFreshConn('epic-001');
        gate.resolve();
      },
    });

    const brief = '# Reserve the epic row\n\nProve the row is durable before the refiner returns.';
    const exitCode = await runEpicCapture(brief, llm);
    assert.equal(exitCode, null, 'the run completed');

    // The row was visible to an independent reader the instant the refiner was
    // called — i.e. before the first await resolved.
    assert.ok(midFlight, 'epic row is durable before the refiner resolves');
    assert.equal(midFlight!.id, 'epic-001');
    assert.equal(midFlight!.title, 'Reserve the epic row', 'derived placeholder title (first heading)');
    assert.equal(midFlight!.status, 'planning');
    assert.ok(midFlight!.planning_phase, 'a non-null planning_phase is set at reservation');
  });

  it('derives the placeholder from the first 60 chars when the brief has no heading', async () => {
    const gate = deferred();
    let midFlight: ReturnType<typeof epicRowViaFreshConn>;
    const llm = new GatedRefinerClient(gate.promise, {
      onRefinerCalled: () => {
        midFlight = epicRowViaFreshConn('epic-001');
        gate.resolve();
      },
    });

    const brief =
      'Build a small headless demo feature that exercises the reservation path with no heading at all.';
    await runEpicCapture(brief, llm);
    assert.ok(midFlight);
    assert.equal(midFlight!.title, brief.slice(0, 60));
  });

  it('replaces the placeholder with the planner title once planning completes', async () => {
    const gate = deferred();
    const llm = new GatedRefinerClient(gate.promise, { onRefinerCalled: () => gate.resolve() });
    await runEpicCapture('# Some heading\n\nDo the work.', llm);

    const done = epicRowViaFreshConn('epic-001')!;
    assert.equal(done.status, 'planned');
    assert.equal(done.title, 'Epic produced by the planner', 'planner title replaced the placeholder');
    assert.equal(done.planning_phase, null);
  });

  it('a second submission reserves the next id after the first completed', async () => {
    // Submission-order allocation across two sequential runEpic invocations:
    // exactly one nextEpicId allocation per submission, ids monotonically
    // increasing. (The out-of-order-completion interleaving is exercised
    // deterministically at the Planner level in
    // loom-core/src/planner/__tests__/reservation.test.ts.)
    const first = new GatedRefinerClient(Promise.resolve());
    assert.equal(await runEpicCapture('# First\n\nThe first one.', first), null);
    resetDatabaseForTest();

    const second = new GatedRefinerClient(Promise.resolve());
    assert.equal(await runEpicCapture('# Second\n\nThe second one.', second), null);

    assert.deepEqual(allEpicIdsViaFreshConn(), ['epic-001', 'epic-002'], 'ids in submission order');
  });
});
