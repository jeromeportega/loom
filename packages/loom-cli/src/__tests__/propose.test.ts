/**
 * Integration tests for `loom propose` (runPropose).
 *
 * Tests inject stub refiner + planner seams and a pre-built in-memory DB
 * so no real LLM calls or policy.yaml are needed. process.exit is captured.
 *
 * Owner: story-005-006
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';
import {
  resetDatabaseForTest,
  createDatabase,
  EpicStore,
  LessonStore,
  OpportunityStore,
  AuditLog,
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import type { BriefRefinement } from '@loom-ai/core';
import { runPropose } from '../commands/propose.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePassRefinement(rough: string): BriefRefinement {
  return {
    ready: true,
    original: rough,
    refined_brief: '# Proposed\n\nClear brief.',
    quality_score: 8,
    critique: { strong_points: ['clear'], ambiguities: [], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

function makeFailRefinement(rough: string): BriefRefinement {
  return {
    ready: false,
    original: rough,
    quality_score: 3,
    critique: { strong_points: [], ambiguities: ['too vague'], missing_scope: [], untestable_claims: [], hidden_complexity: [] },
    questions: ['What is the goal?'],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

interface Captured { logs: string[]; errors: string[]; exitCode: number | null }

async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origLog = console.log;
  const origErr = console.error;
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  // Also capture soft exit-code (process.exitCode = 1; return) in addition to process.exit()
  if (exitCode === null && typeof process.exitCode === 'number') {
    exitCode = process.exitCode;
  }
  process.exitCode = origExitCode;
  return { logs, errors, exitCode };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let tmpDir: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let db: Database.Database;

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-'));
  fs.mkdirSync(path.join(tmpDir, '.loom'), { recursive: true });
  db = createDatabase(':memory:');
});

afterEach(() => {
  resetDatabaseForTest();
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── runPropose ───────────────────────────────────────────────────────────────

describe('runPropose', () => {
  it('invokes proposeNextEpic and prints the resulting epic id', async () => {
    const epicId = 'epic-001';
    new EpicStore(db).create(epicId, 'Test Epic');

    const { logs, errors, exitCode } = await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
      });
    });

    assert.equal(exitCode, null, 'should not exit with error');
    const out = logs.join('\n');
    assert.ok(out.includes(epicId), `output must include the epic id; got: ${out}`);
    assert.equal(errors.length, 0, `no errors: ${errors.join(', ')}`);
  });

  it('exits 1 and prints critique when brief quality gate fails', async () => {
    const { errors, exitCode } = await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { return makeFailRefinement(rough); } },
        _planner: { async run() { throw new Error('should not be called'); } },
      });
    });

    assert.equal(exitCode, 1, 'should exit 1 on gate fail');
    const errOut = errors.join('\n');
    assert.ok(
      errOut.includes('quality gate') || errOut.includes('score') || errOut.includes('vague'),
      `errors should mention gate failure: ${errOut}`
    );
  });

  it('invokes proposeNextEpic exactly once per call', async () => {
    const epicId = 'epic-001';
    new EpicStore(db).create(epicId, 'Test Epic');
    let refinerCalls = 0;

    await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { refinerCalls++; return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
      });
    });

    assert.equal(refinerCalls, 1, 'proposeNextEpic must run exactly once');
  });

  it('writes proposed_by=loom on the epic', async () => {
    const epicId = 'epic-001';
    const store = new EpicStore(db);
    store.create(epicId, 'Test Epic');

    await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
      });
    });

    const row = db
      .prepare('SELECT proposed_by FROM epics WHERE id = ?')
      .get(epicId) as { proposed_by: string | null };
    assert.equal(row.proposed_by, 'loom', 'proposed_by must be loom after propose');
  });

  it('exits 1 when no .loom directory found (production path, no injection)', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-no-init-'));
    const { exitCode, errors } = await capture(async () => {
      await runPropose({ _projectRoot: emptyDir });
    });
    fs.rmSync(emptyDir, { recursive: true, force: true });
    assert.equal(exitCode, 1);
    assert.ok(errors.some(e => /not initialized/i.test(e)));
  });

  it('--top-lessons limits the lessons passed to proposeNextEpic (n=1 yields at most 1)', async () => {
    const epicId = 'epic-001';
    new EpicStore(db).create(epicId, 'Test Epic');
    const lessonStore = new LessonStore(db);
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    // Insert 4 lessons with distinct categories so ranking doesn't deduplicate them
    for (let i = 0; i < 4; i++) {
      lessonStore.insert([{
        epic_id: `ep${i}`,
        category: `cat-${i}`,
        observation: `obs${i}`,
        general_rule: `rule-${i}`,
        applied_as: null,
        applied_ref: null,
        created_at: new Date(base + i * 1000).toISOString(),
      }]);
    }

    let capturedBrief = '';
    await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
        topLessons: 1,
      });
    });

    // composeBrief emits "*(from epic <id>)*" once per lesson; exactly 1 with topLessons=1
    const lessonEntries = (capturedBrief.match(/\*\(from epic /g) ?? []).length;
    assert.equal(lessonEntries, 1, `expected exactly 1 lesson entry in brief with topLessons=1, got ${lessonEntries}`);
  });

  it('--top-opps limits the opportunities passed to proposeNextEpic (n=1 yields at most 1)', async () => {
    const epicId = 'epic-001';
    new EpicStore(db).create(epicId, 'Test Epic');
    const oppStore = new OpportunityStore(db);
    const now = new Date().toISOString();
    // Insert 3 open opportunities via the proper store API
    oppStore.upsertRanked([
      { id: 0, key: 'opp-1', title: 'Opportunity One', rationale: 'r1', impact: 0.9, effort: 0.3, confidence: 0.8, score: 2.4, rank: 1, status: 'open', signal_count: 3, member_keys: [], evidence: [], scoped_epic_id: null, created_at: now, updated_at: now },
      { id: 0, key: 'opp-2', title: 'Opportunity Two', rationale: 'r2', impact: 0.7, effort: 0.4, confidence: 0.7, score: 1.75, rank: 2, status: 'open', signal_count: 2, member_keys: [], evidence: [], scoped_epic_id: null, created_at: now, updated_at: now },
      { id: 0, key: 'opp-3', title: 'Opportunity Three', rationale: 'r3', impact: 0.5, effort: 0.5, confidence: 0.6, score: 1.1, rank: 3, status: 'open', signal_count: 1, member_keys: [], evidence: [], scoped_epic_id: null, created_at: now, updated_at: now },
    ]);

    let capturedBrief = '';
    await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
        topOpps: 1,
      });
    });

    // composeBrief emits "### <title>" once per opportunity; exactly 1 with topOpps=1
    const oppEntries = (capturedBrief.match(/^### /gm) ?? []).length;
    assert.equal(oppEntries, 1, `expected exactly 1 opportunity in brief with topOpps=1, got ${oppEntries}`);
  });

  it('--json emits { ok: true, epicId } as valid JSON on success', async () => {
    const epicId = 'epic-001';
    new EpicStore(db).create(epicId, 'Test Epic');

    const { logs, exitCode } = await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { return makePassRefinement(rough); } },
        _planner: { async run() { return { epicIds: [epicId] }; } },
        json: true,
      });
    });

    assert.equal(exitCode, null, 'should not exit with error');
    const jsonLine = logs.find(l => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'JSON output must be present');
    const parsed = JSON.parse(jsonLine!) as { ok: boolean; epicId: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.epicId, epicId);
  });

  it('--json emits { ok: false, critique } and exits 1 on gate fail', async () => {
    const { logs, exitCode } = await capture(async () => {
      await runPropose({
        _db: db,
        _projectRoot: tmpDir,
        _refiner: { async refine(rough) { return makeFailRefinement(rough); } },
        _planner: { async run() { throw new Error('should not be called'); } },
        json: true,
      });
    });

    assert.equal(exitCode, 1, 'should exit 1 on gate fail');
    const jsonLine = logs.find(l => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'JSON output must be present even on failure');
    const parsed = JSON.parse(jsonLine!) as { ok: boolean; critique: unknown };
    assert.equal(parsed.ok, false);
    assert.ok(parsed.critique, 'critique must be present');
  });
});

// ─── loom propose CLI registration ────────────────────────────────────────────

describe('loom propose — CLI registration', () => {
  it('propose command is registered in the CLI index', () => {
    // Check the CLI index references propose using path resolution consistent with the rest of the suite
    const srcPath = resolve(__dirname, '../index.js');
    if (!fs.existsSync(srcPath)) return; // skip when compiled output not present
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.ok(src.includes('propose'), 'propose command must be registered in CLI index');
  });
});
