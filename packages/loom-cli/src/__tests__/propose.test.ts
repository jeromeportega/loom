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
import path from 'node:path';
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
});

// ─── loom propose CLI registration ────────────────────────────────────────────

describe('loom propose — CLI registration', () => {
  it('propose command is registered in the CLI index', async () => {
    // Check the CLI index references runPropose
    const srcPath = require.resolve('../index.js');
    const src = fs.readFileSync(srcPath, 'utf8');
    assert.ok(src.includes('propose'), 'propose command must be registered in CLI index');
  });
});
