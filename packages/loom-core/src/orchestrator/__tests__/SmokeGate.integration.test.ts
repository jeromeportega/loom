import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicFinalizer } from '../EpicFinalizer.js';
import type { EpicFinalizerOptions } from '../EpicFinalizer.js';
import { IntegrationGate } from '../IntegrationGate.js';
import type { CommandRunner } from '../IntegrationGate.js';
import type { Story } from '../../types.js';

// ─── story-079-004 — Smoke gate integration tests ────────────────────────────
// Tests inject a fake CommandRunner (no real process spawning) and drive the
// EpicFinalizer directly (no Supervisor). Each test verifies smoke gate
// behavior: off/null-resolver/block-pass/block-fail/timeout/warn/sequencing.

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function storyObj(id: string): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Do the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
  };
}

function seedEpic(db: ReturnType<typeof openDatabase>, epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

/** Creates a story branch with one commit and marks the agent done. */
function commitStory(db: ReturnType<typeof openDatabase>, epicId: string, storyId: string): void {
  gitc(['checkout', '-b', `story/${storyId}`]);
  fs.writeFileSync(path.join(repo, `${storyId}.txt`), `work for ${storyId}\n`);
  gitc(['add', `${storyId}.txt`]); // add only the story file — avoid staging .loom/ files
  gitc(['commit', '-q', '-m', `${storyId}: work`]);
  gitc(['checkout', '-']);
  const agentStore = new AgentStore(db);
  const agent = agentStore.create(epicId, storyId, storyId);
  agentStore.updateStatus(agent.id, 'done');
}

function greenGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'noop',
    runner: () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 1 }),
  });
}

function baseOpts(
  db: ReturnType<typeof openDatabase>,
  over: Partial<EpicFinalizerOptions> = {}
): EpicFinalizerOptions {
  return {
    projectRoot:    repo,
    db,
    allowedRemotes: [],
    prStrategy:     'per-epic',
    gate:           greenGate(),
    integrationGate: 'block',
    pushBranch:     () => ({ ok: true, output: 'pushed' }),
    openPr:         () => 'https://example.com/pull/42',
    ...over,
  };
}

function smokeAuditEntries(db: ReturnType<typeof openDatabase>) {
  return new AuditLog(db).recent(100).filter((e) => e.action === 'smoke_gate');
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-smokegate-'));
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

// ── Off mode ──────────────────────────────────────────────────────────────────

describe('smoke gate — off mode', () => {
  it('gateMode=off: smoke runner not called; no audit entry; finalize exits cleanly', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    let runnerCalled = false;
    const smokeRunner: CommandRunner = () => {
      runnerCalled = true;
      return { exitCode: 0, output: '', timedOut: false, durationMs: 1 };
    };

    const result = await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'off', smokeCommand: 'fake-smoke', smokeRunner })
    ).finalize(epicId);

    assert.equal(runnerCalled, false, 'smokeRunner must not be called when gateMode=off');
    assert.equal(smokeAuditEntries(db).length, 0, 'no smoke_gate audit entry in off mode');
    assert.ok(
      result.status === 'merged' || result.status === 'partial',
      'finalize exits cleanly in off mode'
    );
  });
});

// ── Null resolver ─────────────────────────────────────────────────────────────

describe('smoke gate — null resolver', () => {
  it('gateMode=block, resolver returns null: executor not called; no audit entry; finalize succeeds', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);
    // No smokeCommand, no package.json with smoke/verify scripts → resolver returns null

    let runnerCalled = false;
    const smokeRunner: CommandRunner = () => {
      runnerCalled = true;
      return { exitCode: 0, output: '', timedOut: false, durationMs: 1 };
    };

    const result = await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'block', smokeRunner })
    ).finalize(epicId);

    assert.equal(runnerCalled, false, 'smokeRunner must not be called when resolver returns null');
    assert.equal(smokeAuditEntries(db).length, 0, 'no smoke_gate audit entry when resolver returns null');
    assert.notEqual(result.status, 'gated', 'null resolver should not gate finalize');
  });
});

// ── Block + pass ──────────────────────────────────────────────────────────────

describe('smoke gate — block mode, pass', () => {
  it('exit 0: audit entry with allowed=1; finalize proceeds; epic NOT set to in_progress', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const smokeRunner: CommandRunner = () => ({
      exitCode: 0,
      output:   'smoke passed',
      timedOut: false,
      durationMs: 150,
    });

    const result = await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'block', smokeCommand: 'fake-smoke', smokeRunner })
    ).finalize(epicId);

    const entries = smokeAuditEntries(db);
    assert.equal(entries.length, 1, 'exactly one smoke_gate audit entry');
    assert.equal(entries[0].allowed as unknown, 1, 'allowed must be 1 (exit 0)');
    assert.equal(entries[0].command, 'fake-smoke', 'audit command = smoke command');

    const detail = JSON.parse(entries[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.exit_code, 0, 'audit detail.exit_code = 0');
    assert.equal(detail.timeout_killed, false, 'audit detail.timeout_killed = false');

    // Finalize proceeds past a passing smoke gate.
    assert.ok(result.status === 'merged' || result.status === 'partial', 'finalize proceeds past smoke');

    // Epic must not be set to in_progress
    const epic = new EpicStore(db).get(epicId);
    assert.notEqual(epic?.status, 'in_progress', 'epic must not be in_progress after pass');
  });
});

// ── Block + fail ──────────────────────────────────────────────────────────────

describe('smoke gate — block mode, fail', () => {
  it('exit 1: returns status=gated; epic set to in_progress; audit allowed=0; PR not created', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    let openPrCalled = false;
    const smokeRunner: CommandRunner = () => ({
      exitCode:   1,
      output:     'FAILED',
      timedOut:   false,
      durationMs: 200,
    });

    // The smoke gate RETURNS gated (like the integration + correctness gates),
    // it does NOT throw — so the Supervisor's finalize-error handler can't
    // overwrite the in_progress status with 'failed'.
    const result = await new EpicFinalizer(
      baseOpts(db, {
        integrationGate: 'block',
        smokeCommand:    'fake-smoke',
        smokeRunner,
        openPr: () => {
          openPrCalled = true;
          return 'https://example.com/pull/42';
        },
      })
    ).finalize(epicId);

    assert.equal(result.status, 'gated', 'must return status=gated in block+fail');
    assert.match(result.note, /Smoke gate BLOCKED/, 'note must name the smoke gate block');

    assert.equal(openPrCalled, false, 'PR must not be created when smoke gate blocks');

    const epic = new EpicStore(db).get(epicId);
    assert.equal(epic?.status, 'in_progress', 'epic status must be set to in_progress');
    assert.equal(epic?.epic_pr_url, null, 'epic_pr_url must remain null');

    const entries = smokeAuditEntries(db);
    assert.equal(entries.length, 1, 'one smoke_gate audit entry');
    assert.equal(entries[0].allowed as unknown, 0, 'allowed must be 0 (exit 1)');

    const detail = JSON.parse(entries[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.exit_code, 1);
    assert.equal(detail.timeout_killed, false);
    assert.equal(detail.gate_mode, 'block');
  });
});

// ── Block + timeout kill ──────────────────────────────────────────────────────

describe('smoke gate — block mode, timeout', () => {
  it('timeout kill: timeout_killed=true in audit; epic set to in_progress; error message mentions timeout', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const smokeRunner: CommandRunner = () => ({
      exitCode:   null,
      output:     '',
      timedOut:   true,
      durationMs: 900_000,
    });

    const result = await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'block', smokeCommand: 'fake-smoke', smokeRunner })
    ).finalize(epicId);

    assert.equal(result.status, 'gated', 'must return status=gated on timeout');
    assert.match(result.note, /timed out/, 'note must mention timeout');

    const epic = new EpicStore(db).get(epicId);
    assert.equal(epic?.status, 'in_progress', 'epic must be set to in_progress on timeout');

    const entries = smokeAuditEntries(db);
    assert.equal(entries.length, 1, 'one smoke_gate audit entry');
    const detail = JSON.parse(entries[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.timeout_killed, true, 'audit detail.timeout_killed must be true');
    assert.equal(entries[0].allowed as unknown, 0, 'allowed=0 (non-zero exit)');
  });
});

// ── Warn + fail ───────────────────────────────────────────────────────────────

describe('smoke gate — warn mode, fail', () => {
  it('warn + exit 1: finalize proceeds; audit written; output contains "smoke"; epic status not in_progress', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const captured: string[] = [];
    const origLog  = console.log;
    const origWarn = console.warn;
    console.log  = (...args: unknown[]) => { captured.push(args.join(' ')); };
    console.warn = (...args: unknown[]) => { captured.push(args.join(' ')); };

    try {
      const smokeRunner: CommandRunner = () => ({
        exitCode:   2,
        output:     'smoke failed',
        timedOut:   false,
        durationMs: 100,
      });

      // Must not throw
      const result = await new EpicFinalizer(
        baseOpts(db, { integrationGate: 'warn', smokeCommand: 'fake-smoke', smokeRunner })
      ).finalize(epicId);

      assert.ok(result !== undefined, 'finalize must return a result (not throw) in warn mode');

      const entries = smokeAuditEntries(db);
      assert.equal(entries.length, 1, 'one smoke_gate audit entry in warn mode');
      assert.equal(entries[0].allowed as unknown, 0, 'allowed=0 for non-zero exit');

      const detail = JSON.parse(entries[0].detail ?? '{}') as Record<string, unknown>;
      assert.equal(detail.gate_mode, 'warn', 'gate_mode recorded as warn');

      // Output contains 'smoke' as a named step
      const allOutput = captured.join('\n');
      assert.ok(allOutput.includes('smoke'), 'output stream must contain "smoke" step label');

      // Epic status not set to in_progress
      const epic = new EpicStore(db).get(epicId);
      assert.notEqual(epic?.status, 'in_progress', 'epic must not be in_progress in warn mode');
    } finally {
      console.log  = origLog;
      console.warn = origWarn;
    }
  });
});

// ── Audit fields ──────────────────────────────────────────────────────────────

describe('smoke gate — audit fields', () => {
  it('audit entry includes command, exit_code, duration_seconds, timeout_killed fields', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const smokeRunner: CommandRunner = () => ({
      exitCode:   0,
      output:     'ok',
      timedOut:   false,
      durationMs: 500,
    });

    await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'block', smokeCommand: 'my-smoke-cmd', smokeRunner })
    ).finalize(epicId);

    const entries = smokeAuditEntries(db);
    assert.equal(entries.length, 1, 'one smoke_gate audit entry');
    const entry = entries[0];

    assert.equal(entry.command, 'my-smoke-cmd', 'command field = resolved smoke command');

    const detail = JSON.parse(entry.detail ?? '{}') as Record<string, unknown>;
    assert.equal(typeof detail.exit_code,        'number',  'detail.exit_code must be number');
    assert.equal(typeof detail.duration_seconds, 'number',  'detail.duration_seconds must be number');
    assert.equal(typeof detail.timeout_killed,   'boolean', 'detail.timeout_killed must be boolean');
    assert.ok((detail.duration_seconds as number) >= 0, 'duration_seconds must be non-negative');
    assert.ok('gate_mode' in detail, 'detail must include gate_mode');
  });
});

// ── Step labelling ────────────────────────────────────────────────────────────

describe('smoke gate — step labelling', () => {
  it('output stream contains "smoke" as a named step when smoke runs', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logLines.push(args.join(' ')); };

    try {
      const smokeRunner: CommandRunner = () => ({
        exitCode: 0, output: 'ok', timedOut: false, durationMs: 10,
      });

      await new EpicFinalizer(
        baseOpts(db, { integrationGate: 'block', smokeCommand: 'fake-smoke', smokeRunner })
      ).finalize(epicId);

      assert.ok(
        logLines.some((l) => l.includes('smoke')),
        'at least one console.log line must contain "smoke" as a named step'
      );
    } finally {
      console.log = origLog;
    }
  });
});

// ── Sequencing ────────────────────────────────────────────────────────────────

describe('smoke gate — sequencing', () => {
  it('smoke runs AFTER finalize-gates (audit order); smoke runs BEFORE review phase update', async () => {
    const epicId = 'epic-001';
    const storyId = 'story-001-001';
    const db = openDatabase(path.join(repo, '.loom'));
    seedEpic(db, epicId, [storyObj(storyId)]);
    new EpicStore(db).updateBaseSha(epicId, gitc(['rev-parse', 'HEAD']));
    commitStory(db, epicId, storyId);

    const smokeRunner: CommandRunner = () => ({
      exitCode: 1, output: 'FAILED', timedOut: false, durationMs: 10,
    });

    // Block+fail now returns gated (no throw); the assertions below inspect the
    // audit order and finalize phase regardless of the returned status.
    await new EpicFinalizer(
      baseOpts(db, { integrationGate: 'block', smokeCommand: 'fake-smoke', smokeRunner })
    ).finalize(epicId);

    // Verify audit order: finalize-gates entries come BEFORE smoke_gate.
    // Sort by id (AUTOINCREMENT) — same-second entries share a timestamp,
    // so id is the only stable proxy for insertion order.
    // Use epic_finalize_regression as the anchor — it is written unconditionally
    // at the end of the finalize-gates block, regardless of whether any regressions
    // were found (i.e. it is always present when gateMode !== 'off').
    const allEntries = new AuditLog(db).recent(50).sort((a, b) => a.id - b.id); // ASC by insertion order
    const gateIdx  = allEntries.findIndex((e) => e.action === 'epic_finalize_regression');
    const smokeIdx = allEntries.findIndex((e) => e.action === 'smoke_gate');

    assert.ok(gateIdx >= 0, 'epic_finalize_regression audit entry must exist (written unconditionally after runFinalizeGates)');
    assert.ok(smokeIdx >= 0, 'smoke_gate audit entry must exist');
    assert.ok(gateIdx < smokeIdx, 'smoke_gate must appear after finalize-gates entries in audit log');

    // Smoke runs BEFORE the review phase update: if smoke blocked, review phase must not be set
    const epic = new EpicStore(db).get(epicId);
    assert.notEqual(
      epic?.finalize_phase,
      'review',
      'review phase must not be reached when smoke blocks before it'
    );
  });
});
