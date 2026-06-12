import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, EpicStore, resetDatabaseForTest } from '@loom-ai/core';
import type { RunOptions } from '../commands/run.js';
import { runApprove } from '../commands/gate.js';

/**
 * story-007-004 — `loom approve <id> --run` approves then chains into the SAME
 * `runRun` dispatch path so only a path that truly dispatches prints
 * 'dispatching now'. Bare `loom approve --run` (no id) is a usage error.
 *
 * These are integration tests on the approve command path: a real loom dir is
 * initialized and an epic seeded, but `runRun` is INJECTED as a stub so no real
 * supervisor or cursor-agent runs. process.exit / stdout / stderr are captured.
 */

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;
let prevCwd: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

interface RunRunCall {
  epicIds: string[];
  opts: RunOptions;
}

/** A stub dispatcher recording its calls and emitting a dispatch sentinel. */
function makeRunRunStub(): {
  fn: (epicIds: string[], opts?: RunOptions) => Promise<void>;
  calls: RunRunCall[];
} {
  const calls: RunRunCall[] = [];
  const fn = async (epicIds: string[], opts: RunOptions = {}): Promise<void> => {
    calls.push({ epicIds, opts });
    // Only a path that actually dispatches prints this. The non-run approve
    // path never reaches the stub, so this line cannot appear without it.
    console.log('  Dispatching story agents (stub).');
  };
  return { fn, calls };
}

interface Captured {
  exitCode: number | null;
  logs: string[];
  errors: string[];
}

/** Runs `fn`, capturing process.exit, console.log, and console.error. */
async function capture(fn: () => Promise<void> | void): Promise<Captured> {
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;
  class ExitSignal extends Error {}
  (process as unknown as { exit: (c?: number) => never }).exit = (c?: number) => {
    exitCode = c ?? 0;
    throw new ExitSignal();
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { exitCode, logs, errors };
}

function epicStatus(id: string): string | undefined {
  resetDatabaseForTest();
  const db = openDatabase(path.join(tmpDir, '.loom'));
  const status = new EpicStore(db).get(id)?.status;
  resetDatabaseForTest();
  return status;
}

function seedPlannedEpic(id: string, title: string): void {
  resetDatabaseForTest();
  const db = openDatabase(path.join(tmpDir, '.loom'));
  new EpicStore(db).create(id, title);
  resetDatabaseForTest();
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-approve-run-'));
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

describe('loom approve --run — chains into runRun (story-007-004)', () => {
  it('case 1: `approve <id> --run` approves AND calls runRun exactly once with that id', async () => {
    seedPlannedEpic('epic-101', 'Run-chained epic');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, logs, errors } = await capture(() =>
      runApprove('epic-101', {
        run: true,
        runRun: runRunStub,
        printOverlapAdvisory: () => {},
      })
    );

    assert.equal(exitCode, null, 'a successful approve+run never exits non-zero');
    assert.deepEqual(errors, [], 'no error on the happy path');
    assert.equal(epicStatus('epic-101'), 'approved', 'the epic is approved');

    // runRun called exactly once, with the explicit id — the thin seam.
    assert.equal(calls.length, 1, 'runRun is invoked exactly once');
    assert.deepEqual(calls[0].epicIds, ['epic-101'], 'runRun receives the explicit id');

    // 'dispatching now' is printed ONLY by the path that actually dispatches.
    const dispatched = logs.some((l) => /dispatching story agents/i.test(l));
    assert.ok(dispatched, 'the dispatch path printed its banner (only it can)');

    // The non-run run-hint must NOT print on the --run path: dispatch chained
    // instead of telling the operator to run `loom run` themselves.
    assert.ok(
      !logs.some((l) => l.includes('Next: run `loom run')),
      'the run-hint is suppressed when --run chains into dispatch'
    );
  });

  it('case 4: the overlap advisory is computed exactly ONCE across the whole --run flow', async () => {
    seedPlannedEpic('epic-102', 'Overlap-once epic');
    const { fn: runRunStub, calls } = makeRunRunStub();
    let overlapCalls = 0;

    await capture(() =>
      runApprove('epic-102', {
        run: true,
        runRun: runRunStub,
        printOverlapAdvisory: () => {
          overlapCalls += 1;
        },
      })
    );

    // Approve printed the advisory once; the chained runRun is told to suppress
    // its own copy via suppressOverlap so it is not printed twice.
    assert.equal(overlapCalls, 1, 'overlap advisory is printed exactly once at approve time');
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].opts.suppressOverlap,
      true,
      'the chained runRun receives suppressOverlap=true so the advisory is not printed twice'
    );
  });
});

describe('loom approve --run — bare (no id) is a usage error (story-007-004)', () => {
  it('case 2: bare `approve --run` exits non-zero with a one-line usage hint and never dispatches', async () => {
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, errors } = await capture(() =>
      runApprove(undefined, { run: true, runRun: runRunStub })
    );

    assert.equal(exitCode, 1, 'bare `approve --run` exits non-zero');
    assert.equal(calls.length, 0, 'runRun is NEVER called when no explicit id is given');

    // One-line usage hint on stderr.
    assert.equal(errors.length, 1, 'exactly one usage line is printed');
    assert.match(errors[0], /usage/i, 'the line is a usage hint');
    assert.match(errors[0], /loom approve/i, 'it names the command');
    assert.match(errors[0], /--run/, 'it names the flag');
    assert.match(errors[0], /\bid\b/i, 'it explains an explicit id is required');
  });
});

describe('loom approve (no --run) — existing behavior is unchanged (story-007-004)', () => {
  it('case 3: `approve <id>` without --run approves, prints the run-hint, never dispatches', async () => {
    seedPlannedEpic('epic-103', 'Plain approve epic');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, logs, errors } = await capture(() =>
      runApprove('epic-103', { runRun: runRunStub, printOverlapAdvisory: () => {} })
    );

    assert.equal(exitCode, null, 'a plain approve succeeds');
    assert.deepEqual(errors, []);
    assert.equal(epicStatus('epic-103'), 'approved', 'the epic is approved');

    // No dispatch when --run is absent.
    assert.equal(calls.length, 0, 'runRun is NOT called without --run');

    // The story-007-003 run-hint is preserved verbatim.
    assert.ok(
      logs.some((l) => l.includes('Next: run `loom run <epic-id>` to dispatch.')),
      'the run-hint from story-007-003 is printed unchanged'
    );
    assert.ok(
      !logs.some((l) => /dispatching story agents/i.test(l)),
      'no dispatch banner without --run'
    );
  });

  it('bare `approve` (no id, no --run) approves all planned and never dispatches', async () => {
    seedPlannedEpic('epic-104', 'Bulk epic A');
    seedPlannedEpic('epic-105', 'Bulk epic B');
    const { fn: runRunStub, calls } = makeRunRunStub();

    const { exitCode, logs } = await capture(() =>
      runApprove(undefined, { runRun: runRunStub, printOverlapAdvisory: () => {} })
    );

    assert.equal(exitCode, null, 'bulk approve succeeds');
    assert.equal(calls.length, 0, 'bulk approve never dispatches');
    assert.equal(epicStatus('epic-104'), 'approved');
    assert.equal(epicStatus('epic-105'), 'approved');
    assert.ok(
      logs.some((l) => l.includes('Next: run `loom run <epic-id>` to dispatch.')),
      'bulk approve ends with the run-hint'
    );
  });
});

describe('loom approve --run — failure modes (story-007-004)', () => {
  it('a non-existent id with --run exits non-zero and never dispatches', async () => {
    const { fn: runRunStub, calls } = makeRunRunStub();
    const { exitCode } = await capture(() =>
      runApprove('epic-does-not-exist', { run: true, runRun: runRunStub })
    );
    assert.equal(exitCode, 1, 'a missing epic exits non-zero');
    assert.equal(calls.length, 0, 'no dispatch for an epic that was never approved');
  });

  it('an already-approved id with --run exits non-zero and never dispatches', async () => {
    seedPlannedEpic('epic-106', 'Already approved');
    resetDatabaseForTest();
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).updateStatus('epic-106', 'approved');
    resetDatabaseForTest();

    const { fn: runRunStub, calls } = makeRunRunStub();
    const { exitCode } = await capture(() =>
      runApprove('epic-106', { run: true, runRun: runRunStub })
    );
    assert.equal(exitCode, 1, 'a non-planned epic cannot be approved');
    assert.equal(calls.length, 0, 'no dispatch when the approve precondition fails');
  });
});
