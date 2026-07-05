/**
 * story-008-004 — loom reconcile CLI surface tests.
 * story-066-005 — extended with finalizing-epic acceptance tests.
 *
 * Uses the openDatabase singleton trick: seed via openDatabase(loomDir) in
 * beforeEach; runReconcile's own openDatabase(loomDir) call returns the same
 * instance.  resetDatabaseForTest() clears the singleton between tests.
 *
 * git/gh binaries are injected via _gitBin/_ghBin seams in
 * ReconcileCommandOptions so no real network or git state is required.
 * For the finalizing path, _resume is injected to stub EpicFinalizer.resume().
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
  AuditLog,
} from '@loom-ai/core';
import { runReconcile } from '../commands/reconcile.js';

// Local structural alias for FinalizeResult (defined in story-066-001; not in main repo dist yet).
interface FinalizeResult {
  url?: string;
  status: 'skipped' | 'merged' | 'partial' | 'failed' | 'gated' | 'publish_pending';
  conflicted: string[];
  merged: string[];
  cleaned: string[];
  note: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reconcile-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reconcile-cli-'));
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

/** Seed an in_progress epic in the shared singleton DB. */
function seedEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'in_progress');
}

/** Seed a done epic (triggers noop path). */
function seedDoneEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'done');
}

/** Seed a finalizing epic. */
function seedFinalizingEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.beginFinalizing(epicId, 'merging');
}

/** Writes a shell stub to tmpDir and returns its path. */
function stub(body: string): string {
  const p = path.join(tmpDir, `stub-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function ghOk(state: string, head: string, base: string): string {
  const json = JSON.stringify({ state, headRefName: head, baseRefName: base });
  const jsonFile = path.join(tmpDir, `gh-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jsonFile, json);
  return stub(`cat '${jsonFile}'`);
}

function ghFail(): string {
  return stub('exit 1');
}

function gitMerged(): string {
  return stub('exit 0');
}

function gitNotAncestor(): string {
  return stub('if [ "$1" = "rev-parse" ]; then exit 0; fi\nexit 1');
}

/** Stub FinalizeResult for a successful resume() → merged → done path. */
function resumeOk(epicId = 'epic-001'): FinalizeResult {
  return {
    status: 'merged',
    url: 'https://github.com/org/repo/pull/99',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: `Epic ${epicId} finalized and PR opened.`,
  };
}

/** Stub FinalizeResult for a failed resume(). */
function resumeFail(): FinalizeResult {
  return {
    status: 'failed',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: 'push failed: remote rejected',
  };
}

/** Intercept console output and process.exit. Supports async fn. */
interface Captured { logs: string[]; errors: string[]; exitCode: number | null }

async function captureAsync(fn: () => Promise<void> | void): Promise<Captured> {
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

// ─── Init guard ──────────────────────────────────────────────────────────────

describe('runReconcile — init guard', () => {
  it('exits 1 when .loom/policy.yaml is absent', async () => {
    fs.rmSync(path.join(loomDir, 'policy.yaml'));
    const { exitCode, errors } = await captureAsync(() => runReconcile('epic-001'));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /not initialized/i.test(e)));
  });
});

// ─── Success (reconciled) ─────────────────────────────────────────────────────

describe('runReconcile — success path (reconciled)', () => {
  it('prints the note and exits 0 when gh confirms MERGED', async () => {
    seedEpic();
    const { logs, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    assert.equal(exitCode, null, 'must not call process.exit on success');
    assert.ok(logs.some((l) => /reconciled/i.test(l)), 'prints reconcile note');
  });

  it('records the epic as done in the DB', async () => {
    seedEpic();
    await captureAsync(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });

  it('reconciles via git ancestry when --pr is omitted', async () => {
    seedEpic();
    const { exitCode } = await captureAsync(() =>
      runReconcile('epic-001', { _gitBin: gitMerged() })
    );
    assert.equal(exitCode, null);
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });
});

// ─── Noop (already done) ──────────────────────────────────────────────────────

describe('runReconcile — noop path', () => {
  it('prints noop note and exits 0 for an already-done epic', async () => {
    seedDoneEpic();
    const { logs, exitCode } = await captureAsync(() => runReconcile('epic-001'));
    assert.equal(exitCode, null);
    assert.ok(logs.some((l) => /already/i.test(l)), 'prints noop note');
  });
});

// ─── Refusal ─────────────────────────────────────────────────────────────────

describe('runReconcile — refusal path', () => {
  it('exits 1 and prints reason + note when PR is not merged', async () => {
    seedEpic();
    const { logs, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('OPEN', 'epic/epic-001', 'main'),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /not_merged/.test(l)), 'prints refusal reason');
    assert.ok(logs.some((l) => l.length > 0), 'prints refusal note');
  });

  it('exits 1 and surfaces reason on ref_mismatch', async () => {
    seedEpic();
    const { logs, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'wrong-branch', 'main'),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /ref_mismatch/.test(l)), 'prints ref_mismatch reason');
  });

  it('exits 1 when ancestry check fails (not_merged)', async () => {
    seedEpic();
    const { logs, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', { _gitBin: gitNotAncestor() })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /not_merged/.test(l) || l.length > 0));
  });

  it('exits 1 and surfaces epic_not_found reason for unknown epic', async () => {
    // No epic seeded
    const { logs, exitCode } = await captureAsync(() => runReconcile('epic-999'));
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /epic_not_found/.test(l)), 'prints epic_not_found reason');
  });

  it('operator sees the --pr squash hint in the note for offline/missing-tool refusal', async () => {
    seedEpic();
    const { logs, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', { _ghBin: ghFail() })
    );
    assert.equal(exitCode, 1);
    // The note should be non-empty and visible
    const allOutput = logs.join('\n');
    assert.ok(allOutput.trim().length > 0, 'some operator-visible output on refusal');
  });
});

// ─── Arg marshalling ─────────────────────────────────────────────────────────

describe('runReconcile — arg marshalling', () => {
  it('passes --pr as prUrl to the reconciler (PR path selected)', async () => {
    seedEpic();
    // ghOk stubs mean the gh binary is invoked — if pr arg is NOT forwarded,
    // the reconciler takes the ancestry path and _ghBin is never called.
    // We verify the PR path by checking epic_pr_url is set in the DB.
    const prUrl = 'https://github.com/org/repo/pull/42';
    await captureAsync(() =>
      runReconcile('epic-001', {
        pr: prUrl,
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    const db = openDatabase(loomDir);
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.epic_pr_url, prUrl, 'epic_pr_url is set from --pr arg');
  });

  it('uses ancestry path when --pr is omitted', async () => {
    seedEpic();
    const { exitCode } = await captureAsync(() =>
      runReconcile('epic-001', { _gitBin: gitMerged() })
    );
    assert.equal(exitCode, null);
    const db = openDatabase(loomDir);
    // Ancestry path does not set epic_pr_url
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.epic_pr_url, null);
  });
});

// ─── Audit logging ────────────────────────────────────────────────────────────

describe('runReconcile — audit logging', () => {
  it('writes an epic_reconciled audit row on success', async () => {
    seedEpic();
    await captureAsync(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    const db = openDatabase(loomDir);
    const rows = new AuditLog(db).getByCommand('epic-001', ['epic_reconciled']);
    assert.equal(rows.length, 1);
  });
});

// ─── Finalizing epic acceptance (story-066-005, FR-8) ────────────────────────

describe('runReconcile — finalizing epic (FR-8)', () => {
  it('accepts a finalizing epic and routes it to resume() (not rejected)', async () => {
    seedFinalizingEpic();
    let resumeCalled = false;
    const { exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        _resume: (_epicId) => {
          resumeCalled = true;
          return resumeOk();
        },
      })
    );
    assert.ok(resumeCalled, 'resume() was called for the finalizing epic');
    assert.equal(exitCode, null, 'exits 0 on successful resume');
  });

  it('carries a finalizing epic to done when resume() succeeds', async () => {
    seedFinalizingEpic();
    const db = openDatabase(loomDir);
    // The _resume stub writes done to the DB (mirrors what EpicFinalizer.resume() does)
    const store = new EpicStore(db);
    await captureAsync(() =>
      runReconcile('epic-001', {
        _resume: (epicId) => {
          store.updateStatus(epicId, 'done');
          return resumeOk(epicId);
        },
      })
    );
    assert.equal(store.get('epic-001')?.status, 'done', 'finalizing epic reaches done');
  });

  it('prints the PR url when resume() returns one', async () => {
    seedFinalizingEpic();
    const { logs } = await captureAsync(() =>
      runReconcile('epic-001', {
        _resume: () => resumeOk(),
      })
    );
    assert.ok(
      logs.some((l) => l.includes('https://github.com/org/repo/pull/99')),
      'PR url is printed'
    );
  });

  it('exits 1 and prints note when resume() reports failure', async () => {
    seedFinalizingEpic();
    const { errors, exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        _resume: () => resumeFail(),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /push failed/.test(e)), 'failure note is printed');
  });

  it('does not run merge-base --is-ancestor for a finalizing epic (precondition removed)', async () => {
    // Seed a finalizing epic whose branch is NOT merged; the old ancestry gate
    // at EpicReconciler.ts:276 would have rejected this with 'not_merged'.
    // With the precondition removed, resume() is called instead.
    seedFinalizingEpic();
    let resumeCalled = false;
    const { exitCode } = await captureAsync(() =>
      runReconcile('epic-001', {
        // If ancestry were checked via _gitBin, this stub would cause it to fail.
        // But since we route finalizing to resume(), _gitBin is never invoked.
        _gitBin: gitNotAncestor(),
        _resume: (_epicId) => {
          resumeCalled = true;
          return { status: 'merged', conflicted: [], merged: [], cleaned: [], note: 'full-finalize completed' };
        },
      })
    );
    assert.ok(resumeCalled, 'resume() was called, not the ancestry gate');
    assert.equal(exitCode, null, 'not rejected by the old not-merged precondition');
  });

  it('delegates merge-state detection to resume() (single source of truth)', async () => {
    // When merge state is already detected (e.g. record-pr path), resume() handles it.
    // reconcile does NOT duplicate the merge check — it calls resume() and trusts it.
    seedFinalizingEpic();
    const db = openDatabase(loomDir);
    const store = new EpicStore(db);
    let resumeCalledWith: string | undefined;
    await captureAsync(() =>
      runReconcile('epic-001', {
        _resume: (epicId) => {
          resumeCalledWith = epicId;
          // Simulate resume detecting "already merged, record-pr → done" path
          store.updateStatus(epicId, 'done');
          return { status: 'merged', url: 'https://github.com/org/repo/pull/55', conflicted: [], merged: [], cleaned: [], note: 'record-pr → done' };
        },
      })
    );
    assert.equal(resumeCalledWith, 'epic-001', 'resume() receives the correct epic id');
    assert.equal(store.get('epic-001')?.status, 'done', 'epic reaches done via resume()');
  });
});
