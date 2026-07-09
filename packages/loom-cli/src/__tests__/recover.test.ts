/**
 * story-087-002 — loom recover CLI surface tests.
 *
 * Unit tests: routing logic via DB state and the _resume test seam.
 * Integration tests: CLI registration via buildProgram().
 *
 * Uses the openDatabase singleton trick (same as reconcile.test.ts and
 * finalize.test.ts): seed via openDatabase(loomDir) in beforeEach;
 * runRecover's own openDatabase call returns the same instance.
 * resetDatabaseForTest() clears the singleton between tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest, EpicStore } from '@loom-ai/core';
import type { FinalizeResult, EpicStatus } from '@loom-ai/core';
import { runRecover, spec } from '../commands/recover.js';
import { buildProgram } from '../index.js';
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
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-recover-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-recover-cli-'));
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

function seedEpic(epicId: string, status: EpicStatus): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, status);
}

function mergedResult(epicId = 'epic-001', prUrl = 'https://github.com/org/repo/pull/99'): FinalizeResult {
  return {
    status: 'merged',
    url: prUrl,
    conflicted: [],
    merged: [],
    cleaned: [],
    note: `Epic ${epicId} finalized and PR opened.`,
  };
}

// ─── Init guard ───────────────────────────────────────────────────────────────

describe('runRecover — init guard', () => {
  it('exits 1 when .loom/policy.yaml is absent', async () => {
    fs.rmSync(path.join(loomDir, 'policy.yaml'));
    const { exitCode, errors } = await capture(() => runRecover('epic-001'));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /not initialized/i.test(e)));
  });
});

// ─── Epic not found ────────────────────────────────────────────────────────────

describe('runRecover — epic not found', () => {
  it('exits 1 with a message containing the epic ID when epic is absent', async () => {
    // No epic seeded
    const { exitCode, errors } = await capture(() => runRecover('epic-999'));
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => /epic-999/i.test(e)),
      `expected "epic-999" in error output; got: ${JSON.stringify(errors)}`
    );
  });
});

// ─── Routing: finalizing → resume() ──────────────────────────────────────────

describe('runRecover — routing (finalizing)', () => {
  it('calls _resume for a finalizing epic and does NOT route to reconcile', async () => {
    seedEpic('epic-001', 'finalizing');
    let resumeCalled = false;
    const { exitCode } = await capture(() =>
      runRecover('epic-001', {
        _resume: (epicId) => {
          resumeCalled = true;
          return mergedResult(epicId);
        },
      })
    );
    assert.ok(resumeCalled, '_resume must be called for a finalizing epic');
    assert.equal(exitCode, null, 'exits 0 on successful resume');
  });

  it('passes the epicId correctly to _resume', async () => {
    seedEpic('epic-001', 'finalizing');
    let calledWith: string | undefined;
    await capture(() =>
      runRecover('epic-001', {
        _resume: (epicId) => {
          calledWith = epicId;
          return mergedResult(epicId);
        },
      })
    );
    assert.equal(calledWith, 'epic-001', '_resume must receive the correct epicId');
  });

  it('prints PR URL and note when resume() succeeds for finalizing', async () => {
    seedEpic('epic-001', 'finalizing');
    const prUrl = 'https://github.com/org/repo/pull/42';
    const { logs, exitCode } = await capture(() =>
      runRecover('epic-001', {
        _resume: (epicId) => mergedResult(epicId, prUrl),
      })
    );
    assert.equal(exitCode, null);
    assert.ok(logs.some((l) => l.includes(prUrl)), `expected PR URL in output; got: ${JSON.stringify(logs)}`);
  });

  it('exits 1 when resume() returns a non-merged status', async () => {
    seedEpic('epic-001', 'finalizing');
    const { exitCode, errors } = await capture(() =>
      runRecover('epic-001', {
        _resume: () => ({
          status: 'failed',
          conflicted: [],
          merged: [],
          cleaned: [],
          note: 'push failed: remote rejected',
        }),
      })
    );
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /push failed/.test(e)), 'failure note must be printed');
  });
});

// ─── Routing: publish_pending → resume() ─────────────────────────────────────

describe('runRecover — routing (publish_pending)', () => {
  it('calls _resume for a publish_pending epic and does NOT route to reconcile', async () => {
    seedEpic('epic-001', 'publish_pending');
    let resumeCalled = false;
    const { exitCode } = await capture(() =>
      runRecover('epic-001', {
        _resume: (epicId) => {
          resumeCalled = true;
          return mergedResult(epicId);
        },
      })
    );
    assert.ok(resumeCalled, '_resume must be called for a publish_pending epic');
    assert.equal(exitCode, null, 'exits 0 on successful resume');
  });
});

// ─── Routing: other states → reconcile ────────────────────────────────────────

describe('runRecover — routing (non-finalizing state routes to reconcile)', () => {
  it('does NOT call _resume for a done epic (routes to reconcile noop)', async () => {
    seedEpic('epic-001', 'done');
    let resumeCalled = false;
    const { exitCode } = await capture(() =>
      runRecover('epic-001', {
        _resume: () => {
          resumeCalled = true;
          return mergedResult();
        },
      })
    );
    assert.ok(!resumeCalled, '_resume must NOT be called for a done epic');
    assert.equal(exitCode, null, 'reconcile noop for done epic exits 0');
  });

  it('does NOT call _resume for an in_progress epic (routes to reconcile)', async () => {
    // Seed an in_progress epic; reconcile's noop check won't apply (not done),
    // but we only need to verify routing: _resume must not be invoked.
    seedEpic('epic-001', 'in_progress');
    let resumeCalled = false;
    // reconcile will attempt git ancestry — it may exit 1, which is acceptable
    // here since we only care that _resume was not called.
    await capture(() =>
      runRecover('epic-001', {
        _resume: () => {
          resumeCalled = true;
          return mergedResult();
        },
      })
    );
    assert.ok(!resumeCalled, '_resume must NOT be called for an in_progress epic');
  });
});

// ─── --pr option forwarding ───────────────────────────────────────────────────

describe('runRecover — --pr option', () => {
  it('does not call _resume when pr is set and epic is not finalizing', async () => {
    seedEpic('epic-001', 'done');
    let resumeCalled = false;
    await capture(() =>
      runRecover('epic-001', {
        pr: 'https://github.com/org/repo/pull/99',
        _resume: () => {
          resumeCalled = true;
          return mergedResult();
        },
      })
    );
    assert.ok(!resumeCalled, 'pr option must not trigger resume path for a done epic');
  });

  it('calls _resume with correct epicId when epic is finalizing, regardless of pr option', async () => {
    seedEpic('epic-001', 'finalizing');
    let calledWith: string | undefined;
    await capture(() =>
      runRecover('epic-001', {
        pr: 'https://github.com/org/repo/pull/99',
        _resume: (epicId) => {
          calledWith = epicId;
          return mergedResult(epicId);
        },
      })
    );
    assert.equal(calledWith, 'epic-001', '_resume receives correct epicId on finalizing + pr path');
  });
});

// ─── spec — audience ──────────────────────────────────────────────────────────

describe('spec — audience (visible command)', () => {
  it('spec.audience is not internal — recover is operator-visible', () => {
    assert.ok(
      spec.audience !== 'internal',
      'recover spec must not have audience="internal"; it is a public operator command'
    );
  });

  it('spec.name is "recover"', () => {
    assert.equal(spec.name, 'recover');
  });
});

// ─── Integration: CLI registration ────────────────────────────────────────────

describe('recover — CLI registration', () => {
  it('recover is registered as a visible command in buildProgram()', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'recover');
    assert.ok(cmd, 'recover command must be registered in buildProgram()');
    // Visible commands are NOT hidden — verify via help text presence (same
    // semantic check as cmd.hidden === false, without relying on the private property).
    const helpText = program.helpInformation();
    assert.ok(helpText.includes('recover'), 'recover must appear in loom --help (not hidden)');
  });

  it('loom --help includes recover', () => {
    const program = buildProgram();
    const helpText = program.helpInformation();
    assert.ok(
      helpText.includes('recover'),
      `loom --help must mention recover; help text: ${helpText.slice(0, 400)}`
    );
  });

  it('loom recover --help includes --pr option', () => {
    const program = buildProgram();
    const recoverCmd = program.commands.find((c) => c.name() === 'recover');
    assert.ok(recoverCmd, 'recover command must exist');
    const helpText = recoverCmd.helpInformation();
    assert.ok(
      helpText.includes('--pr'),
      `loom recover --help must document --pr option; got: ${helpText}`
    );
  });
});
