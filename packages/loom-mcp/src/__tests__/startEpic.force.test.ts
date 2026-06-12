import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  MockLLMClient,
  MockWorkerRunner,
  openDatabase,
  resetDatabaseForTest,
  AuditLog,
  EpicStore,
} from '@loom-ai/core';
import type { LLMRequest, BriefRefinement } from '@loom-ai/core';
import { HANDLERS } from '../tools/handlers.js';
import type { ToolContext } from '../tools/context.js';

let repo: string;
let background: Promise<unknown>[];
let prevLoomHome: string | undefined;
let loomHomeDir: string;

// Captured by reference so the ctx() factory and the tests share one mock per
// case (handler calls createLLM once; refiner + planner ride the same mock).
let currentLLM: MockLLMClient;

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

/** brief_gate_forced rows via an independent connection — does not disturb the
 *  cached singleton the handler/planner is still holding. */
function forcedRowsViaFreshConn(): Array<{ allowed: number | null; detail: string | null }> {
  const probe = new Database(path.join(repo, '.loom', 'loom.db'), { readonly: true });
  try {
    return probe
      .prepare("SELECT allowed, detail FROM audit_log WHERE action = 'brief_gate_forced'")
      .all() as Array<{ allowed: number | null; detail: string | null }>;
  } finally {
    probe.close();
  }
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-force-'));
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  background = [];
  currentLLM = new MockLLMClient(pipelineResponder({ ready: false, score: 2 }));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

const BRIEF = 'Build a small demo feature for verifying the forced gate override path.';

describe('loom_start_epic { force: true }', () => {
  it('forces past a gate rejection: status planning/forced and an mcp audit row', async () => {
    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF, force: true })) as {
      status: string;
      forced?: boolean;
      epic_ids: string[];
    };
    // Early return: planning continues in the background; the forced override
    // is recorded synchronously before the planner runs (NFR-2 ordering).
    assert.equal(r.status, 'planning');
    assert.equal(r.forced, true);
    assert.deepEqual(r.epic_ids, ['epic-001']);
    await Promise.all(background);

    const db = openDatabase(path.join(repo, '.loom'));
    const forced = new AuditLog(db).recent(50).filter((x) => x.action === 'brief_gate_forced');
    assert.equal(forced.length, 1);
    const row = forced[0];
    assert.equal(row.allowed, 1);
    assert.equal(row.command, BRIEF.slice(0, 120));
    const detail = JSON.parse(row.detail!);
    assert.equal(detail.entry_point, 'mcp');
    assert.equal(detail.ready, false);
    assert.equal(detail.quality_score, 2);
    assert.equal(detail.threshold, 6);
    assert.deepEqual(detail.critique, FAILING_CRITIQUE);
    assert.deepEqual(detail.questions, FAILING_QUESTIONS);
  });

  it('writes the audit row BEFORE the planner consumes anything (NFR-2)', async () => {
    let forcedAtPlannerStart: ReturnType<typeof forcedRowsViaFreshConn> | undefined;
    currentLLM = new MockLLMClient(
      pipelineResponder({
        ready: false,
        score: 2,
        onPlannerStart: () => {
          forcedAtPlannerStart = forcedRowsViaFreshConn();
        },
      })
    );
    await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF, force: true });
    // Planning runs in the background now; await it so the planner has made
    // its first call and onPlannerStart has snapshotted the audit table.
    await Promise.all(background);

    assert.ok(forcedAtPlannerStart, 'planner made its first call');
    assert.equal(forcedAtPlannerStart!.length, 1, 'forced row durable before planner ran');
    assert.deepEqual(JSON.parse(forcedAtPlannerStart![0].detail!).critique, FAILING_CRITIQUE);
  });

  it('refiner still runs; its critique is the one embedded in the row', async () => {
    await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF, force: true });
    await Promise.all(background);
    const refinerCalls = currentLLM.requests.filter((r) =>
      r.messages[r.messages.length - 1].content.includes('Apply the discipline above')
    );
    assert.equal(refinerCalls.length, 1);

    const db = openDatabase(path.join(repo, '.loom'));
    const row = new AuditLog(db).recent(50).find((x) => x.action === 'brief_gate_forced')!;
    assert.deepEqual(JSON.parse(row.detail!).critique, FAILING_CRITIQUE);
  });

  it('force:true with a PASSING gate takes the normal pass path — no forced row, no forced flag', async () => {
    currentLLM = new MockLLMClient(pipelineResponder({ ready: true, score: 9 }));
    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF, force: true })) as {
      status: string;
      forced?: boolean;
    };
    assert.equal(r.status, 'planning');
    assert.equal(r.forced, undefined, 'no forced flag when the gate would have passed anyway');
    await Promise.all(background);

    const db = openDatabase(path.join(repo, '.loom'));
    const forced = new AuditLog(db).recent(50).filter((x) => x.action === 'brief_gate_forced');
    assert.equal(forced.length, 0);
  });
});

describe('loom_start_epic without force', () => {
  it('failing gate returns rejected with the full payload shape including ready', async () => {
    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as {
      status: string;
      reason: string;
      ready: boolean;
      quality_score: number;
      min_quality_score: number;
      critique: BriefRefinement['critique'];
      questions: string[];
      refined_brief?: string;
      message: string;
    };
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'brief_quality_below_threshold');
    assert.equal(r.ready, false);
    assert.equal(r.quality_score, 2);
    assert.equal(r.min_quality_score, 6);
    assert.deepEqual(r.critique, FAILING_CRITIQUE);
    assert.deepEqual(r.questions, FAILING_QUESTIONS);
    assert.equal(typeof r.refined_brief, 'string');
    assert.equal(typeof r.message, 'string');

    const db = openDatabase(path.join(repo, '.loom'));
    const forced = new AuditLog(db).recent(50).filter((x) => x.action === 'brief_gate_forced');
    assert.equal(forced.length, 0, 'a rejected (unforced) gate writes no forced row');
    assert.equal(new EpicStore(db).get('epic-001'), undefined, 'planner never ran');
  });

  it('passing gate plans normally with zero forced rows', async () => {
    currentLLM = new MockLLMClient(pipelineResponder({ ready: true, score: 9 }));
    const r = (await HANDLERS.loom_start_epic(ctx(), { brief: BRIEF })) as { status: string };
    assert.equal(r.status, 'planning');
    await Promise.all(background);

    const db = openDatabase(path.join(repo, '.loom'));
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'planned');
    const forced = new AuditLog(db).recent(50).filter((x) => x.action === 'brief_gate_forced');
    assert.equal(forced.length, 0);
  });
});
