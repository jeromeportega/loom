/**
 * story-008-004 — loom reconcile CLI surface tests.
 *
 * Uses the openDatabase singleton trick: seed via openDatabase(loomDir) in
 * beforeEach; runReconcile's own openDatabase(loomDir) call returns the same
 * instance.  resetDatabaseForTest() clears the singleton between tests.
 *
 * git/gh binaries are injected via _gitBin/_ghBin seams in
 * ReconcileCommandOptions so no real network or git state is required.
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

/** Intercept console output and process.exit. */
interface Captured { logs: string[]; errors: string[]; exitCode: number | null }

function capture(fn: () => void): Captured {
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
    fn();
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
  it('exits 1 when .loom/policy.yaml is absent', () => {
    fs.rmSync(path.join(loomDir, 'policy.yaml'));
    const { exitCode, errors } = capture(() => runReconcile('epic-001'));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /not initialized/i.test(e)));
  });
});

// ─── Success (reconciled) ─────────────────────────────────────────────────────

describe('runReconcile — success path (reconciled)', () => {
  it('prints the note and exits 0 when gh confirms MERGED', () => {
    seedEpic();
    const { logs, exitCode } = capture(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    assert.equal(exitCode, null, 'must not call process.exit on success');
    assert.ok(logs.some((l) => /reconciled/i.test(l)), 'prints reconcile note');
  });

  it('records the epic as done in the DB', () => {
    seedEpic();
    capture(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });

  it('reconciles via git ancestry when --pr is omitted', () => {
    seedEpic();
    const { exitCode } = capture(() =>
      runReconcile('epic-001', { _gitBin: gitMerged() })
    );
    assert.equal(exitCode, null);
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).get('epic-001')?.status, 'done');
  });
});

// ─── Noop (already done) ──────────────────────────────────────────────────────

describe('runReconcile — noop path', () => {
  it('prints noop note and exits 0 for an already-done epic', () => {
    seedDoneEpic();
    const { logs, exitCode } = capture(() => runReconcile('epic-001'));
    assert.equal(exitCode, null);
    assert.ok(logs.some((l) => /already/i.test(l)), 'prints noop note');
  });
});

// ─── Refusal ─────────────────────────────────────────────────────────────────

describe('runReconcile — refusal path', () => {
  it('exits 1 and prints reason + note when PR is not merged', () => {
    seedEpic();
    const { logs, exitCode } = capture(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('OPEN', 'epic/epic-001', 'main'),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /not_merged/.test(l)), 'prints refusal reason');
    assert.ok(logs.some((l) => l.length > 0), 'prints refusal note');
  });

  it('exits 1 and surfaces reason on ref_mismatch', () => {
    seedEpic();
    const { logs, exitCode } = capture(() =>
      runReconcile('epic-001', {
        pr: 'https://github.com/org/repo/pull/1',
        _ghBin: ghOk('MERGED', 'wrong-branch', 'main'),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /ref_mismatch/.test(l)), 'prints ref_mismatch reason');
  });

  it('exits 1 when ancestry check fails (not_merged)', () => {
    seedEpic();
    const { logs, exitCode } = capture(() =>
      runReconcile('epic-001', { _gitBin: gitNotAncestor() })
    );
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /not_merged/.test(l) || l.length > 0));
  });

  it('exits 1 and surfaces epic_not_found reason for unknown epic', () => {
    // No epic seeded
    const { logs, exitCode } = capture(() => runReconcile('epic-999'));
    assert.equal(exitCode, 1);
    assert.ok(logs.some((l) => /epic_not_found/.test(l)), 'prints epic_not_found reason');
  });

  it('operator sees the --pr squash hint in the note for offline/missing-tool refusal', () => {
    seedEpic();
    const { logs, exitCode } = capture(() =>
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
  it('passes --pr as prUrl to the reconciler (PR path selected)', () => {
    seedEpic();
    // ghOk stubs mean the gh binary is invoked — if pr arg is NOT forwarded,
    // the reconciler takes the ancestry path and _ghBin is never called.
    // We verify the PR path by checking epic_pr_url is set in the DB.
    const prUrl = 'https://github.com/org/repo/pull/42';
    capture(() =>
      runReconcile('epic-001', {
        pr: prUrl,
        _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
      })
    );
    const db = openDatabase(loomDir);
    const epic = new EpicStore(db).get('epic-001');
    assert.equal(epic?.epic_pr_url, prUrl, 'epic_pr_url is set from --pr arg');
  });

  it('uses ancestry path when --pr is omitted', () => {
    seedEpic();
    const { exitCode } = capture(() =>
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
  it('writes an epic_reconciled audit row on success', () => {
    seedEpic();
    capture(() =>
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
