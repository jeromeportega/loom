import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resetDatabaseForTest,
  openDatabase,
  EpicStore,
} from '@loom-ai/core';
import { HANDLERS } from '../tools/handlers.js';
import type { ToolContext } from '../tools/context.js';

let repo: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

function ctx(): ToolContext {
  return {
    projectRoot: repo,
    loomDir: path.join(repo, '.loom'),
    createLLM: () => {
      throw new Error('not used in this test');
    },
    createWorker: () => {
      throw new Error('not used in this test');
    },
    background: () => {},
  };
}

function gitc(args: string[]): void {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-phase-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-phase-'));
  gitc(['init', '-q', '-b', 'main']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

type EpicPayload = {
  id: string;
  status: string;
  planning_phase?: string;
  finalize_phase?: string;
  epic_pr_url?: string;
  error?: string;
};

async function getEpics(): Promise<EpicPayload[]> {
  const r = (await HANDLERS.loom_get_status(ctx(), {})) as { epics: EpicPayload[] };
  return r.epics;
}

describe('loom_get_status — conditional finalize_phase / planning_phase / epic_pr_url / error', () => {
  it('includes planning_phase only while status is planning', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-001', 'a brief');
    epics.updatePlanningPhase('epic-001', 'architect');

    const planning = (await getEpics()).find((e) => e.id === 'epic-001')!;
    assert.equal(planning.status, 'planning');
    assert.equal(planning.planning_phase, 'architect');
    assert.equal(planning.finalize_phase, undefined, 'no finalize_phase while planning');
    assert.equal(planning.epic_pr_url, undefined);
    assert.equal(planning.error, undefined);

    // Once planning completes, planning_phase must drop out of the payload.
    epics.completePlanning('epic-001', 'Real title');
    const planned = (await getEpics()).find((e) => e.id === 'epic-001')!;
    assert.equal(planned.status, 'planned');
    assert.equal(
      planned.planning_phase,
      undefined,
      'planning_phase is absent once status is no longer planning'
    );
  });

  it('includes finalize_phase only while status is finalizing', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-002', 'a brief');
    epics.completePlanning('epic-002', 'Title');
    epics.beginFinalizing('epic-002', 'review');

    const finalizing = (await getEpics()).find((e) => e.id === 'epic-002')!;
    assert.equal(finalizing.status, 'finalizing');
    assert.equal(finalizing.finalize_phase, 'review');
    assert.equal(
      finalizing.planning_phase,
      undefined,
      'no planning_phase while finalizing (ADR-1 symmetry — no leak)'
    );
  });

  it('includes epic_pr_url once recorded, regardless of phase', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-003', 'a brief');
    epics.completePlanning('epic-003', 'Title');
    epics.recordPrUrl('epic-003', 'https://example.com/pr/9');
    epics.updateStatus('epic-003', 'done');

    const done = (await getEpics()).find((e) => e.id === 'epic-003')!;
    assert.equal(done.status, 'done');
    assert.equal(done.epic_pr_url, 'https://example.com/pr/9');
    assert.equal(done.finalize_phase, undefined, 'done epic has no live finalize phase');
    assert.equal(done.planning_phase, undefined);
    assert.equal(done.error, undefined);
  });

  it('includes error only when status is failed', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-004', 'a brief');
    epics.completePlanning('epic-004', 'Title');
    epics.beginFinalizing('epic-004', 'pushing');
    epics.fail('epic-004', 'push rejected by remote');

    const failed = (await getEpics()).find((e) => e.id === 'epic-004')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'push rejected by remote');
    // fail() clears finalize_phase — the run is no longer in flight.
    assert.equal(failed.finalize_phase, undefined, 'finalize_phase cleared on failure');
    assert.equal(failed.planning_phase, undefined);
  });

  it('omits all four optional fields for a plain planned epic (no null pollution)', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    const epics = new EpicStore(db);
    epics.create('epic-005', 'Plain planned epic');

    const planned = (await getEpics()).find((e) => e.id === 'epic-005')!;
    assert.equal(planned.status, 'planned');
    assert.ok(!('planning_phase' in planned), 'planning_phase key absent');
    assert.ok(!('finalize_phase' in planned), 'finalize_phase key absent');
    assert.ok(!('epic_pr_url' in planned), 'epic_pr_url key absent');
    assert.ok(!('error' in planned), 'error key absent');
  });
});
