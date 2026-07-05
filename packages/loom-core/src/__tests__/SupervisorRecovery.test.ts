/**
 * Tests for Supervisor.selectEpics recoverable routing (FR-6, story-066-003).
 * Covers:
 *  - finalizing/publish_pending epics are routed to the recoverable set
 *  - run() calls EpicFinalizer.resume() for each recoverable epic
 *  - after resume() returns merged, the epic is in epicsProcessed and status=done
 *  - without epicFinalizer, recoverable epics end up in epicsSkipped
 *  - run() does NOT introduce its own lock around resume() (relies on LeaseStore in resume)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { EpicFinalizer } from '../orchestrator/EpicFinalizer.js';
import type { FinalizeResult } from '../orchestrator/EpicFinalizer.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function seedStrandedEpic(db: ReturnType<typeof openDatabase>, epicId: string, status: 'finalizing' | 'publish_pending'): void {
  const epicStore = new EpicStore(db);
  epicStore.create(epicId, `${epicId} title`);
  if (status === 'finalizing') {
    epicStore.updateStatus(epicId, 'approved');
    epicStore.beginFinalizing(epicId, 'pushing');
  } else {
    epicStore.updateStatus(epicId, 'approved');
    epicStore.publishPending(epicId, `loom/finalize/${epicId}-abc1234`, 'push rejected: non-fast-forward');
  }
}

function mergedResult(epicId: string): FinalizeResult {
  return {
    status: 'merged',
    conflicted: [],
    merged: [`story/${epicId}-001`],
    cleaned: [],
    note: '',
  };
}

function skippedResult(): FinalizeResult {
  return {
    status: 'skipped',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: 'lease held by another process',
  };
}

function fakeFinalizer(
  resumeImpl: (epicId: string) => Promise<FinalizeResult>
): EpicFinalizer {
  return {
    finalize: async (_epicId: string) => mergedResult(_epicId),
    resume: resumeImpl,
  } as unknown as EpicFinalizer;
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sup-recovery-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('Supervisor — selectEpics recoverable routing (FR-6, story-066-003)', () => {
  it('finalizing epic is routed to recoverable (not skipped) and resume() is called', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');

    const resumeCalls: string[] = [];
    const fin = fakeFinalizer(async (epicId) => {
      resumeCalls.push(epicId);
      new EpicStore(db).updateStatus(epicId, 'done');
      return mergedResult(epicId);
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: fin,
    }).run();

    assert.ok(resumeCalls.includes('epic-001'), 'resume() must be called for finalizing epic');
    assert.ok(!result.epicsSkipped.includes('epic-001'), 'finalizing epic must not appear in skipped');
    assert.ok(result.epicsProcessed.includes('epic-001'), 'finalizing epic must appear in epicsProcessed after recovery');
  });

  it('publish_pending epic is routed to recoverable and resume() is called', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-002', 'publish_pending');

    const resumeCalls: string[] = [];
    const fin = fakeFinalizer(async (epicId) => {
      resumeCalls.push(epicId);
      new EpicStore(db).updateStatus(epicId, 'done');
      return mergedResult(epicId);
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: fin,
    }).run();

    assert.ok(resumeCalls.includes('epic-002'), 'resume() must be called for publish_pending epic');
    assert.ok(!result.epicsSkipped.includes('epic-002'), 'publish_pending epic must not appear in skipped');
    assert.ok(result.epicsProcessed.includes('epic-002'), 'publish_pending epic must appear in epicsProcessed after recovery');
  });

  it('stranded epic reaches done status after resume() returns merged', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');

    // The resume stub mirrors what the real EpicFinalizer.resume() does when
    // it successfully records the PR URL and calls updateStatus('done').
    const fin = fakeFinalizer(async (epicId) => {
      const epicStore = new EpicStore(db);
      epicStore.recordPrUrl(epicId, 'https://github.com/org/repo/pull/1');
      epicStore.clearFinalizePhase(epicId);
      epicStore.updateStatus(epicId, 'done');
      return mergedResult(epicId);
    });

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: fin,
    }).run();

    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'done', 'epic must reach done after resume()');
  });

  it('when resume() returns skipped (lease held), epic lands in epicsSkipped', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');

    const fin = fakeFinalizer(async (_epicId) => skippedResult());

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: fin,
    }).run();

    assert.ok(result.epicsSkipped.includes('epic-001'), 'lease-skipped epic must land in epicsSkipped');
    assert.ok(!result.epicsProcessed.includes('epic-001'), 'lease-skipped epic must not be in epicsProcessed');
  });

  it('without epicFinalizer, recoverable epics appear in epicsSkipped (FR-9 path)', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      // No epicFinalizer wired
    }).run();

    assert.ok(result.epicsSkipped.includes('epic-001'), 'finalizing epic without finalizer must appear in skipped');
    assert.ok(!result.epicsProcessed.includes('epic-001'));
  });

  it('run() does NOT add a local lease for recoverable epics (relies on resume()\'s own LeaseStore)', async () => {
    // Verify that run() calls resume() twice on the same epic (simulating two
    // concurrent runs) without the Supervisor acquiring its own lock. The
    // resume() mock itself never blocks, confirming no run-local guard.
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');

    let resumeCallCount = 0;
    const fin = fakeFinalizer(async (epicId) => {
      resumeCallCount++;
      new EpicStore(db).updateStatus(epicId, 'done');
      return mergedResult(epicId);
    });

    // Two supervisors see the same finalizing epic (e.g. overlapping run calls).
    // The Supervisor must pass both through to resume() — the per-epic
    // serialization is resume()'s responsibility, not run()'s.
    await Promise.all([
      new Supervisor({
        projectRoot: repo,
        db,
        worker: new MockWorkerRunner({ status: 'done' }),
        maxConcurrent: 1,
        epicFinalizer: fin,
        lease: false, // disable dispatch lease for this concurrency test
      }).run(['epic-001']),
      new Supervisor({
        projectRoot: repo,
        db,
        worker: new MockWorkerRunner({ status: 'done' }),
        maxConcurrent: 1,
        epicFinalizer: fin,
        lease: false,
      }).run(['epic-001']),
    ]);

    assert.ok(resumeCallCount >= 1, 'resume() must be called at least once');
    // Both supervisors must reach resume() — if run() added its own lock the
    // second call would be blocked and count would stay at 1.
    assert.ok(resumeCallCount >= 2, 'no run-local guard blocked concurrent resume() calls');
  });

  it('selectEpics: finalizing/publish_pending sorted into recoverable, not skipped — explicit ids', async () => {
    const db = openDatabase(path.join(repo, '.loom'));
    seedStrandedEpic(db, 'epic-001', 'finalizing');
    seedStrandedEpic(db, 'epic-002', 'publish_pending');

    const resumeCalls: string[] = [];
    const fin = fakeFinalizer(async (epicId) => {
      resumeCalls.push(epicId);
      new EpicStore(db).updateStatus(epicId, 'done');
      return mergedResult(epicId);
    });

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: fin,
    }).run(['epic-001', 'epic-002']);

    assert.ok(resumeCalls.includes('epic-001'), 'finalizing epic in explicit ids → resume() called');
    assert.ok(resumeCalls.includes('epic-002'), 'publish_pending epic in explicit ids → resume() called');
    assert.ok(!result.epicsSkipped.includes('epic-001'), 'finalizing must not be skipped');
    assert.ok(!result.epicsSkipped.includes('epic-002'), 'publish_pending must not be skipped');
  });
});
