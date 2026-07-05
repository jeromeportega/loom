/**
 * story-066-004 — loom publish accepts a finalizing epic and carries it forward.
 *
 * Tests at two levels:
 *   1. EpicPublisher unit tests — assert the old `publish_pending`-only precondition
 *      no longer rejects a `finalizing` epic (FR-7), and that the _resume injectable
 *      is invoked instead.
 *   2. CLI-adapter tests (`runPublish`) — assert a `finalizing` epic is routed to
 *      EpicFinalizer.resume() via the `_resume` seam, reaches `done` (FR-6), and
 *      that non-recoverable cases (noop-terminal) surface a clear error.
 *
 * Uses the openDatabase singleton trick: seed via openDatabase(loomDir) in beforeEach;
 * runPublish's own openProjectDatabase(projectRoot) call returns the same instance.
 * resetDatabaseForTest() clears the singleton between tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
  EpicPublisher,
  AuditLog,
} from '@loom-ai/core';
import type { FinalizeResult } from '@loom-ai/core';
import { runPublish } from '../commands/publish.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MINIMAL_POLICY = `git:\n  allowed_remotes: []\nagents:\n  min_brief_quality_score: 6\n  max_concurrent: 5\n  review_strategy: "comment"\n  skill_generation: "on"\n`;
const FINALIZE_REF = 'loom/finalize/epic-001-abc1234';
const PR_URL = 'https://github.com/org/repo/pull/42';

let tmpDir: string;
let loomDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  prevCwd = process.cwd();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-publish-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-publish-cli-'));
  loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), MINIMAL_POLICY);
  process.chdir(tmpDir);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  if (prevLoomHome === undefined) {
    delete process.env.LOOM_HOME;
  } else {
    process.env.LOOM_HOME = prevLoomHome;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
});

// ─── Capture helper ───────────────────────────────────────────────────────────

interface Captured { logs: string[]; errors: string[]; exitCode: number | null }

class ExitSignal extends Error {}

async function capture(fn: () => Promise<void>): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errors, exitCode };
}

// ─── DB seed helpers ──────────────────────────────────────────────────────────

function seedFinalizingEpic(phase: 'merging' | 'gate' | 'review' | 'pushing' | 'opening_pr' = 'merging') {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create('epic-001', 'Test Epic');
  store.beginFinalizing('epic-001', phase);
  return { db, store };
}

function seedPublishPendingEpic() {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create('epic-001', 'Test Epic');
  store.publishPending('epic-001', FINALIZE_REF, 'push failed during finalize');
  return { db, store };
}

// ─── Mock resume that returns a successful merged result ──────────────────────

function makeMockResume(prUrl = PR_URL): (epicId: string) => Promise<FinalizeResult> {
  return async (_epicId: string): Promise<FinalizeResult> => ({
    status: 'merged',
    url: prUrl,
    conflicted: [],
    merged: [],
    cleaned: [],
    note: `Epic ${_epicId} published — opened PR: ${prUrl}`,
  });
}

// ─── EpicPublisher unit tests — FR-7 precondition removed ────────────────────

describe('EpicPublisher.publish() — finalizing epic accepted (FR-7)', () => {
  it('[FR-7] finalizing epic with _resume stub → accepted and returns stub result (not refused)', () => {
    const { db, store } = seedFinalizingEpic();

    const syncResume = (_epicId: string) => ({
      status: 'published' as const,
      epicId: _epicId,
      prUrl: PR_URL,
      note: 'resume stub invoked',
    });

    const publisher = new EpicPublisher({ projectRoot: tmpDir, db, _resume: syncResume });
    const result = publisher.publish('epic-001');

    assert.equal(result.status, 'published', 'finalizing epic must be accepted, not refused');
    assert.equal(result.prUrl, PR_URL);

    // Status in DB unchanged — resume stub is a no-op on the DB (production resume() owns writes)
    assert.equal(store.get('epic-001')?.status, 'finalizing', 'DB state unchanged by stub');
  });

  it('[FR-7] finalizing epic without _resume → refused with "finalizing" in note (not old publish_pending message)', () => {
    const { db } = seedFinalizingEpic();
    const publisher = new EpicPublisher({ projectRoot: tmpDir, db });
    const result = publisher.publish('epic-001');

    assert.equal(result.status, 'refused');
    assert.ok(result.note.toLowerCase().includes('finalizing'), `note should mention "finalizing", got: ${result.note}`);
    assert.ok(!result.note.includes('reconcile'), 'note must not contain old reconcile hint for finalizing epics');
  });

  it('[FR-7] _resume is invoked with the correct epicId', () => {
    const { db } = seedFinalizingEpic();
    let capturedId: string | undefined;
    const publisher = new EpicPublisher({
      projectRoot: tmpDir,
      db,
      _resume: (id) => {
        capturedId = id;
        return { status: 'published' as const, epicId: id, prUrl: PR_URL, note: 'ok' };
      },
    });

    publisher.publish('epic-001');
    assert.equal(capturedId, 'epic-001', '_resume must receive the epicId');
  });

  it('[regression] publish_pending epic still works through EpicPublisher (existing path unchanged)', () => {
    const { db } = seedPublishPendingEpic();
    const publisher = new EpicPublisher({
      projectRoot: tmpDir,
      db,
      openPr: () => PR_URL,
    });
    const result = publisher.publish('epic-001');
    assert.equal(result.status, 'published');
    assert.equal(result.prUrl, PR_URL);
  });

  it('[regression] in_progress epic → refused with reconcile hint (existing precondition intact)', () => {
    const db = openDatabase(loomDir);
    const store = new EpicStore(db);
    store.create('epic-001', 'Test');
    // epic is 'in_progress' by default after create

    const publisher = new EpicPublisher({ projectRoot: tmpDir, db });
    const result = publisher.publish('epic-001');
    assert.equal(result.status, 'refused');
    assert.ok(result.note.includes('reconcile'), `note must hint at reconcile for non-publish_pending epics, got: ${result.note}`);
  });
});

// ─── CLI adapter tests — runPublish + EpicFinalizer.resume() (FR-6, FR-7) ────

describe('runPublish — finalizing epic accepted and carries forward (FR-6, FR-7)', () => {
  it('[FR-7] finalizing epic → resume() is invoked (not rejected)', async () => {
    seedFinalizingEpic();
    let resumeCalled = false;

    const result = await capture(async () => {
      await runPublish('epic-001', {
        _resume: async (epicId) => {
          resumeCalled = true;
          return {
            status: 'merged',
            url: PR_URL,
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId} published`,
          };
        },
      });
    });

    assert.ok(resumeCalled, 'EpicFinalizer.resume() must be invoked for a finalizing epic');
    assert.equal(result.exitCode, null, 'success path must not call process.exit()');
  });

  it('[FR-6] carry forward — merged result prints PR URL and exits success', async () => {
    seedFinalizingEpic('pushing');

    const result = await capture(async () => {
      await runPublish('epic-001', { _resume: makeMockResume(PR_URL) });
    });

    assert.equal(result.exitCode, null, 'success: no process.exit()');
    assert.ok(
      result.logs.some((l) => l.includes(PR_URL)),
      `PR URL ${PR_URL} must appear in output, got: ${result.logs.join('|')}`,
    );
  });

  it('[FR-6] carry forward — partial (some conflicts) still succeeds', async () => {
    seedFinalizingEpic();

    const result = await capture(async () => {
      await runPublish('epic-001', {
        _resume: async () => ({
          status: 'partial',
          url: PR_URL,
          conflicted: ['story-001-001'],
          merged: ['story-001-002'],
          cleaned: [],
          note: 'Opened epic PR with 1 conflict',
        }),
      });
    });

    assert.equal(result.exitCode, null, 'partial status is a success path (PR was opened)');
    assert.ok(result.logs.some((l) => l.includes(PR_URL)));
  });

  it('[regression guard — noop-terminal] skipped result → error surfaced, exits 1', async () => {
    seedFinalizingEpic();

    const result = await capture(async () => {
      await runPublish('epic-001', {
        _resume: async () => ({
          status: 'skipped',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: 'no remote configured',
        }),
      });
    });

    assert.equal(result.exitCode, 1, 'noop-terminal must exit 1');
    assert.ok(
      result.errors.some((e) => e.includes('no remote configured')),
      `error must surface the noop-terminal note, got: ${result.errors.join('|')}`,
    );
  });

  it('[regression guard — publish_pending] failed-to-open-PR returns error', async () => {
    seedFinalizingEpic();

    const result = await capture(async () => {
      await runPublish('epic-001', {
        _resume: async () => ({
          status: 'publish_pending',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: 'push failed; retry with loom publish',
        }),
      });
    });

    assert.equal(result.exitCode, 1, 'publish_pending from resume() must exit 1 — still stranded');
  });

  it('[regression] publish_pending epic → routed to EpicPublisher (resume() NOT called)', async () => {
    seedPublishPendingEpic();
    let resumeCalled = false;

    const result = await capture(async () => {
      await runPublish('epic-001', {
        _resume: async () => { resumeCalled = true; return { status: 'merged', url: PR_URL, conflicted: [], merged: [], cleaned: [], note: 'ok' }; },
        _openPr: () => PR_URL,
      });
    });

    assert.ok(!resumeCalled, 'publish_pending must NOT call _resume — it goes through EpicPublisher');
    assert.equal(result.exitCode, null, 'publish_pending success path exits 0');
  });

  it('[init guard] missing policy.yaml → exits 1 with init error', async () => {
    fs.rmSync(path.join(loomDir, 'policy.yaml'));

    const result = await capture(async () => {
      await runPublish('epic-001', { _resume: makeMockResume() });
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((e) => /not initialized/i.test(e)));
  });
});

// ─── Deleted branch: no gh pr view probe in publish.ts ───────────────────────

describe('deleted branch — publish.ts no longer reimplements gh pr view probe', () => {
  it('publish.ts source does not contain a gh pr view probe (detectResumePhase handles it)', async () => {
    // The probe was in EpicPublisher._publish() for the finalizing path.
    // Now detectResumePhase inside EpicFinalizer.resume() handles it.
    // Assert that the CLI-level publish command does not re-implement the probe.
    // Read the TypeScript source (dist/__tests__ → package root → src/commands)
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'commands', 'publish.ts'), 'utf8');
    assert.ok(
      !src.includes("'pr', 'view'") && !src.includes('"pr", "view"'),
      'publish.ts must not reimplement a gh pr view probe — detectResumePhase handles this',
    );
  });
});
