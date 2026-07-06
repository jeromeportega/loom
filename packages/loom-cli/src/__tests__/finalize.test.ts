/**
 * story-066-002 — loom finalize --resume CLI surface tests.
 *
 * Unit/CLI-adapter tests: EpicFinalizer.resume is injected via the _finalizer
 * seam so no real git/gh invocations or remote state is required. Tests verify
 * wiring, error surfacing, and the four acceptance criteria.
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
} from '@loom-ai/core';
import type { FinalizeResult } from '@loom-ai/core';
import { runFinalize } from '../commands/finalize.js';
import { capture } from './testUtils.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tmpDir: string;
let loomDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const MINIMAL_POLICY = `git:\n  allowed_remotes: []\nagents:\n  min_brief_quality_score: 6\n  max_concurrent: 5\n  review_strategy: "comment"\n  skill_generation: "on"\n`;

beforeEach(() => {
  resetDatabaseForTest();
  prevCwd = process.cwd();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-finalize-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-finalize-cli-'));
  loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), MINIMAL_POLICY);
  process.chdir(tmpDir);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

/** Seed a finalizing epic in the shared singleton DB. */
function seedFinalizingEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'finalizing');
}

/** Seed a publish_pending epic in the shared singleton DB. */
function seedPublishPendingEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'publish_pending');
}

/** Seed an in_progress epic (not stranded). */
function seedInProgressEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'in_progress');
}

/** Seed a done epic. */
function seedDoneEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'done');
}

/** Build a FinalizeResult stub for a successfully landed epic. */
function mergedResult(epicId: string, prUrl = 'https://github.com/org/repo/pull/42'): FinalizeResult {
  return {
    status: 'merged',
    url: prUrl,
    conflicted: [],
    merged: [],
    cleaned: [],
    note: `Epic ${epicId} published — opened PR: ${prUrl}`,
  };
}

/** Build a FinalizeResult stub for a noop-terminal case (no usable remote). */
function noopTerminalResult(note = 'no remote configured'): FinalizeResult {
  return {
    status: 'skipped',
    conflicted: [],
    merged: [],
    cleaned: [],
    note,
  };
}

// ─── Init guard ──────────────────────────────────────────────────────────────

describe('runFinalize — init guard', () => {
  it('exits 1 when .loom/policy.yaml is absent', async () => {
    fs.rmSync(path.join(loomDir, 'policy.yaml'));
    const { exitCode, errors } = await capture(() => runFinalize('epic-001', { resume: true }));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /not initialized/i.test(e)));
  });
});

// ─── Missing --resume flag ────────────────────────────────────────────────────

describe('runFinalize — missing --resume flag', () => {
  it('exits 1 with a usage message when --resume is omitted', async () => {
    const { exitCode, errors } = await capture(() => runFinalize('epic-001', {}));
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => /--resume/i.test(e)),
      `expected "--resume" in error output; got: ${JSON.stringify(errors)}`
    );
  });

  it('exits 1 with a usage message when resume is explicitly false', async () => {
    const { exitCode, errors } = await capture(() => runFinalize('epic-001', { resume: false }));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /--resume/i.test(e)));
  });
});

// ─── Unknown / invalid epic id ───────────────────────────────────────────────

describe('runFinalize — unknown epic id', () => {
  it('exits 1 with a clear error for an epic not in the DB', async () => {
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-999', { resume: true })
    );
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => /epic-999/i.test(e)),
      `expected "epic-999" in error output; got: ${JSON.stringify(errors)}`
    );
  });
});

// ─── Not-stranded (non-recoverable status) ──────────────────────────────────

describe('runFinalize — not stranded (status not in recoverable set)', () => {
  it('exits 1 with an actionable error for an in_progress epic', async () => {
    seedInProgressEpic();
    const resumeCalled = { count: 0 };
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async () => {
            resumeCalled.count++;
            return mergedResult('epic-001');
          },
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.equal(resumeCalled.count, 0, 'resume() must NOT be called for a non-recoverable epic');
    assert.ok(
      errors.some((e) => /in_progress|not.*recoverable|finalizing|publish_pending/i.test(e)),
      `expected recoverable-state guidance in error; got: ${JSON.stringify(errors)}`
    );
  });

  it('exits 1 for a done epic without mutating state', async () => {
    seedDoneEpic();
    const resumeCalled = { count: 0 };
    const { exitCode } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async () => {
            resumeCalled.count++;
            return mergedResult('epic-001');
          },
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.equal(resumeCalled.count, 0, 'resume() must NOT be called for a done epic');
  });
});

// ─── Happy path — lands done ──────────────────────────────────────────────────

describe('runFinalize — happy path (stranded epic lands done)', () => {
  it('calls resume() exactly once and exits 0 for a finalizing epic, landing it as done', async () => {
    seedFinalizingEpic();
    let callCount = 0;
    let calledWith: string | undefined;
    const { exitCode } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async (epicId: string) => {
            callCount++;
            calledWith = epicId;
            // resume() owns the done write (the CLI must NOT write done itself —
            // that could set status=done with epic_pr_url=NULL). Mirror the real
            // state machine here so the DB assertion reflects resume()'s behavior.
            new EpicStore(openDatabase(loomDir)).updateStatus(epicId, 'done');
            return mergedResult(epicId);
          },
        },
      })
    );
    assert.equal(exitCode, null, 'must not call process.exit on success');
    assert.equal(callCount, 1, 'resume() must be called exactly once');
    assert.equal(calledWith, 'epic-001', 'resume() must be called with the correct epic id');
    // Acceptance criterion: the command lands the epic as done in the DB (via resume()).
    const db = openDatabase(loomDir);
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'done', 'epic must be in done status after successful resume');
  });

  it('prints PR URL and note on success', async () => {
    seedFinalizingEpic();
    const prUrl = 'https://github.com/org/repo/pull/99';
    const { logs, exitCode } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async (epicId: string) => mergedResult(epicId, prUrl),
        },
      })
    );
    assert.equal(exitCode, null);
    assert.ok(logs.some((l) => l.includes(prUrl)), `expected PR URL in output; got: ${JSON.stringify(logs)}`);
    assert.ok(logs.some((l) => /published|opened/i.test(l)), `expected success note; got: ${JSON.stringify(logs)}`);
  });

  it('works for a publish_pending epic as well as finalizing', async () => {
    seedPublishPendingEpic();
    let callCount = 0;
    const { exitCode } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async (epicId: string) => {
            callCount++;
            return mergedResult(epicId);
          },
        },
      })
    );
    assert.equal(exitCode, null);
    assert.equal(callCount, 1, 'resume() must be called for publish_pending epics');
  });
});

// ─── Noop-terminal (no usable remote) ───────────────────────────────────────

describe('runFinalize — noop-terminal (no usable remote)', () => {
  it('exits 1 with the noop note when resume() returns skipped', async () => {
    seedFinalizingEpic();
    const note = 'no remote configured';
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async () => noopTerminalResult(note),
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => e.includes(note)),
      `expected noop note "${note}" in error output; got: ${JSON.stringify(errors)}`
    );
  });

  it('surfaces a hint about allowed_remotes on noop-terminal', async () => {
    seedFinalizingEpic();
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async () =>
            noopTerminalResult('remote "https://github.com/org/repo.git" is not in policy.git.allowed_remotes'),
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => /allowed_remotes/i.test(e)),
      `expected allowed_remotes hint; got: ${JSON.stringify(errors)}`
    );
  });

  it('does NOT mutate epic state on noop-terminal', async () => {
    seedFinalizingEpic();
    await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async () => noopTerminalResult('no remote configured'),
        },
      })
    );
    const db = openDatabase(loomDir);
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.status, 'finalizing', 'status must remain finalizing on noop-terminal');
  });
});

// ─── Error paths from resume() ───────────────────────────────────────────────

describe('runFinalize — resume() returns error statuses', () => {
  it('exits 1 and prints note when resume() returns failed', async () => {
    seedFinalizingEpic();
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async (epicId: string): Promise<FinalizeResult> => ({
            status: 'failed',
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId} finalize failed`,
          }),
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /failed/i.test(e)));
  });

  it('exits 1 when resume() returns publish_pending (push failed)', async () => {
    seedFinalizingEpic();
    const { exitCode, errors } = await capture(() =>
      runFinalize('epic-001', {
        resume: true,
        _finalizer: {
          resume: async (epicId: string): Promise<FinalizeResult> => ({
            status: 'publish_pending',
            conflicted: [],
            merged: [],
            cleaned: [],
            note: `Epic ${epicId}: push failed`,
          }),
        },
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => e.length > 0), 'some error output must be shown');
  });
});
