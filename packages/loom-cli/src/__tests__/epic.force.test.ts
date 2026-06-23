import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  MockLLMClient,
  resetDatabaseForTest,
  AuditLog,
  EpicStore,
  resolveRepoStatePaths,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import type { LLMRequest, BriefRefinement } from '@loom-ai/core';
import { runEpic } from '../commands/epic.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

// A critique we can assert is embedded verbatim in the forced audit row.
const FAILING_CRITIQUE: BriefRefinement['critique'] = {
  strong_points: ['names a concrete deliverable'],
  ambiguities: ['"fast" is not quantified'],
  missing_scope: ['no error handling described'],
  untestable_claims: ['"users will be happy"'],
  hidden_complexity: ['implies a schema migration'],
};
const FAILING_QUESTIONS = ['What is the success metric?', 'Which users are in scope?'];

function jsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

/**
 * Drives the whole pipeline: the BriefRefiner call then the four planner
 * stages. `ready`/`score` shape the gate verdict; `onPlannerStart` fires the
 * instant the planner makes its first LLM call (Analyst brief) so a test can
 * snapshot durable state at that moment.
 */
function pipelineResponder(opts: {
  ready: boolean;
  score: number;
  onPlannerStart?: () => void;
}) {
  return (req: LLMRequest): string => {
    const last = req.messages[req.messages.length - 1].content;
    if (last.includes('Apply the discipline above')) {
      return jsonBlock({
        ready: opts.ready,
        quality_score: opts.score,
        refined_brief: '# Brief\n\n## Goal\nShip it.',
        critique: opts.ready
          ? {
              strong_points: ['clear'],
              ambiguities: [],
              missing_scope: [],
              untestable_claims: [],
              hidden_complexity: [],
            }
          : FAILING_CRITIQUE,
        // Readiness is code-derived (score floor AND blocking_gaps empty); the
        // model's `ready` is ignored. Surface a blocking gap to drive not-ready.
        blocking_gaps: opts.ready ? [] : ['critical requirement undefined — planner would have to invent it'],
        questions: opts.ready ? [] : FAILING_QUESTIONS,
        delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
      });
    }
    if (last.includes('Produce the project brief')) {
      opts.onPlannerStart?.();
      return '# Brief\n\n## The Problem\nA gap.';
    }
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
  };
}

/** Read brief_gate_forced rows via an independent connection (does not touch
 *  the cached singleton the planner is still using). */
function forcedRowsViaFreshConn(): Array<{
  command: string | null;
  allowed: number | null;
  detail: string | null;
}> {
  const { dbPath } = resolveRepoStatePaths(tmpDir, {});
  const probe = new Database(dbPath, { readonly: true });
  try {
    return probe
      .prepare("SELECT command, allowed, detail FROM audit_log WHERE action = 'brief_gate_forced'")
      .all() as Array<{ command: string | null; allowed: number | null; detail: string | null }>;
  } finally {
    probe.close();
  }
}

/** Run runEpic in-process, capturing process.exit and silencing its console
 *  chatter. Returns the exit code (null when it ran to completion). */
async function runEpicCapture(
  brief: string,
  opts: { force?: boolean; llm: MockLLMClient }
): Promise<number | null> {
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
    await runEpic(brief, opts);
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-epic-force-'));
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

const BRIEF = 'Build a small demo feature for verifying the forced gate override path.';

describe('loom epic --force', () => {
  it('forces past a gate rejection: planner runs and a brief_gate_forced audit row is written', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
    const exitCode = await runEpicCapture(BRIEF, { force: true, llm });

    // Did not bail out — the planner was reached and produced an epic.
    assert.equal(exitCode, null);
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned', 'planner was invoked');

    // The forced override is audit-logged with the full critique embedded.
    const forced = new AuditLog(db).recent(50).filter((r) => r.action === 'brief_gate_forced');
    assert.equal(forced.length, 1, 'exactly one forced-start audit row');
    const row = forced[0];
    assert.equal(row.allowed, 1);
    assert.equal(row.command, BRIEF.slice(0, 120));
    const detail = JSON.parse(row.detail!);
    assert.equal(detail.entry_point, 'cli');
    assert.equal(detail.ready, false);
    assert.equal(detail.quality_score, 2);
    assert.equal(detail.threshold, 6);
    assert.deepEqual(detail.critique, FAILING_CRITIQUE, 'full critique object embedded');
    assert.deepEqual(detail.questions, FAILING_QUESTIONS);
    resetDatabaseForTest();
  });

  it('writes the audit row BEFORE the planner consumes anything (ordering invariant / NFR-2)', async () => {
    let forcedAtPlannerStart: ReturnType<typeof forcedRowsViaFreshConn> | undefined;
    const llm = new MockLLMClient(
      pipelineResponder({
        ready: false,
        score: 2,
        onPlannerStart: () => {
          forcedAtPlannerStart = forcedRowsViaFreshConn();
        },
      })
    );
    const exitCode = await runEpicCapture(BRIEF, { force: true, llm });
    assert.equal(exitCode, null);

    assert.ok(forcedAtPlannerStart, 'planner made its first call');
    assert.equal(
      forcedAtPlannerStart!.length,
      1,
      'brief_gate_forced row was durable before the planner ran'
    );
    const detail = JSON.parse(forcedAtPlannerStart![0].detail!);
    assert.equal(detail.entry_point, 'cli');
    assert.deepEqual(detail.critique, FAILING_CRITIQUE);
  });

  it('refiner still runs on the forced path; its critique is the one embedded in the row', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
    await runEpicCapture(BRIEF, { force: true, llm });

    const refinerCalls = llm.requests.filter((r) =>
      r.messages[r.messages.length - 1].content.includes('Apply the discipline above')
    );
    assert.equal(refinerCalls.length, 1, 'refiner was invoked exactly once');

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    const row = new AuditLog(db).recent(50).find((r) => r.action === 'brief_gate_forced')!;
    assert.deepEqual(JSON.parse(row.detail!).critique, FAILING_CRITIQUE);
    resetDatabaseForTest();
  });

  it('without --force, a failing gate rejects (exit 1) and writes no forced row', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
    const exitCode = await runEpicCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, 1, 'CLI exits non-zero on a failed gate');

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    const forced = new AuditLog(db).recent(50).filter((r) => r.action === 'brief_gate_forced');
    assert.equal(forced.length, 0, 'no forced row without --force');
    // The epic row is reserved at submission (before the refiner), so it exists
    // even when the gate later rejects — but the planner never completed it, so
    // it must NOT be 'planned'. (The terminal 'rejected' write is story-007-006.)
    const reserved = new EpicStore(db).get('epic-001');
    assert.notEqual(reserved?.status, 'planned', 'planner never completed the epic');
    resetDatabaseForTest();
  });

  it('passing gate plans normally and writes zero brief_gate_forced rows (with or without force)', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: true, score: 9 }));
    const exitCode = await runEpicCapture(BRIEF, { force: true, llm });
    assert.equal(exitCode, null);

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned');
    const forced = new AuditLog(db).recent(50).filter((r) => r.action === 'brief_gate_forced');
    assert.equal(forced.length, 0, 'a passing gate never audits a forced override');
    resetDatabaseForTest();
  });
});

describe('loom epic commander wiring', () => {
  it('exposes --force on the epic command help', () => {
    const help = execFileSync('node', [LOOM_CLI, 'epic', '--help'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    assert.match(help, /--force/);
    assert.match(help, /Skip the brief-quality gate/);
  });
});

// ── Three-outcome gate routing (story-012-001) ───────────────────────────────

describe('three-outcome gate routing', () => {
  it('pass-clean (ready: true, score >= threshold) → exits 0, planner runs', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: true, score: 9 }));
    const exitCode = await runEpicCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, null, 'pass-clean exits 0 (null means no explicit exit)');

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned', 'planner was invoked');
    resetDatabaseForTest();
  });

  it('below-threshold (ready: true, score < threshold) → exits 1, planner not run', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: true, score: 2 }));
    const exitCode = await runEpicCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, 1, 'below-threshold exits 1');

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.notEqual(new EpicStore(db).get('epic-001')?.status, 'planned', 'planner not invoked');
    resetDatabaseForTest();
  });

  it('pass-with-clarifications (ready: false, score >= threshold) → exits 3, distinct from 0/1/2', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 8 }));
    const exitCode = await runEpicCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, 3, 'pass-with-clarifications exits 3');
    assert.notEqual(exitCode, 0);
    assert.notEqual(exitCode, 1);
    assert.notEqual(exitCode, 2);

    // Planner never ran — reserved row must be cleaned up (not left dangling)
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'rejected', 'row cleaned up on exit 3');
    resetDatabaseForTest();
  });

  it('pass-with-clarifications + --force → proceeds to planning, writes brief_gate_forced row', async () => {
    const llm = new MockLLMClient(pipelineResponder({ ready: false, score: 8 }));
    const exitCode = await runEpicCapture(BRIEF, { force: true, llm });
    assert.equal(exitCode, null, 'forced past pass-with-clarifications exits 0');

    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned', 'planner was invoked');
    const forced = new AuditLog(db).recent(50).filter((r) => r.action === 'brief_gate_forced');
    assert.equal(forced.length, 1, 'one forced audit row written for pass-with-clarifications');
    const detail = JSON.parse(forced[0].detail!);
    assert.equal(detail.entry_point, 'cli');
    assert.equal(detail.ready, false);
    assert.equal(detail.quality_score, 8);
    assert.equal(detail.threshold, 6);
    resetDatabaseForTest();
  });

  it('audit row exists before process exits on forced pass-with-clarifications (NFR-2)', async () => {
    let forcedAtPlannerStart: ReturnType<typeof forcedRowsViaFreshConn> | undefined;
    const llm = new MockLLMClient(
      pipelineResponder({
        ready: false,
        score: 8,
        onPlannerStart: () => {
          forcedAtPlannerStart = forcedRowsViaFreshConn();
        },
      })
    );
    await runEpicCapture(BRIEF, { force: true, llm });
    assert.ok(forcedAtPlannerStart, 'planner made its first call');
    assert.equal(
      forcedAtPlannerStart!.length,
      1,
      'brief_gate_forced row was durable before the planner ran'
    );
  });

  it('threshold semantics unchanged: score === threshold with ready: true → pass-clean, exits 0', async () => {
    // Boundary: score exactly equal to threshold (default 6) should be a pass.
    const llm = new MockLLMClient(pipelineResponder({ ready: true, score: 6 }));
    const exitCode = await runEpicCapture(BRIEF, { force: false, llm });
    assert.equal(exitCode, null, 'boundary score (=== threshold) with ready: true exits 0');
  });
});
