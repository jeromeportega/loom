/**
 * Tests for integration-branch lag warning and stale-planning hint in `loom status`
 * (story-075-003).
 *
 * AC1 — lag warning appears in human-readable output when integration branch is >= N commits behind main
 * AC2 — lag warning appears in JSON output as `integration_lag: { commits_behind, threshold, warn }`
 * AC3 — stale-planning hint appears in human-readable and JSON output when epic is idle in 'planning'
 * AC4 — N and stale threshold are configurable via policy; defaults are 10 commits and 30 minutes
 * AC5 — no warning when within threshold
 * AC6 — git subprocess not spawned when integration_branch !== 'rolling'
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, PolicySchema } from '@loom-ai/core';
import { runStatus, type StatusOptions } from '../commands/status.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-status-lag-'));
  fs.mkdirSync(path.join(repo, '.loom'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type JsonEpicShape = {
  id: string;
  status: string;
  integration_lag?: { commits_behind: number; threshold: number; warn: boolean };
  stale_planning?: { idle_minutes: number; threshold_minutes: number; warn: boolean };
  stories: unknown[];
};

type SpawnCall = { cmd: string; args: string[] };

function makeStub(stdout: string, status = 0): { fn: StatusOptions['_spawnSync']; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const fn: StatusOptions['_spawnSync'] = (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout, status };
  };
  return { fn, calls };
}

function captureText(options: StatusOptions): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  try {
    runStatus(options);
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

function captureJson(options: StatusOptions): { epics: JsonEpicShape[] } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')); };
  try {
    runStatus({ ...options, json: true });
  } finally {
    console.log = orig;
  }
  return JSON.parse(lines.join('\n')) as { epics: JsonEpicShape[] };
}

function seedEpicWithAgent(epicId: string, title: string, status = 'planned'): void {
  const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
  if (status === 'planning') {
    new EpicStore(db).beginPlanning(epicId, 'test brief');
  } else {
    new EpicStore(db).create(epicId, title);
    if (status !== 'planned') {
      db.prepare('UPDATE epics SET status = ? WHERE id = ?').run(status, epicId);
    }
  }
  const agents = new AgentStore(db);
  const agent = agents.create(epicId, `${epicId}-001`, title);
  agents.setModel(agent.id, 'claude-sonnet-4-6');
  db.close();
}

function setUpdatedAt(epicId: string, msAgo: number): void {
  const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
  const ts = new Date(Date.now() - msAgo).toISOString();
  db.prepare('UPDATE epics SET updated_at = ? WHERE id = ?').run(ts, epicId);
  db.close();
}

function writePolicyYaml(content: string): void {
  fs.writeFileSync(path.join(repo, '.loom', 'policy.yaml'), content);
}

// ─── Lag warning: JSON output ─────────────────────────────────────────────────

describe('loom status — integration_lag JSON (AC2)', () => {
  it('[AC2] stub returns 12, threshold 10 → warn=true, commits_behind=12', () => {
    seedEpicWithAgent('epic-075', 'Lag epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n  integration_branch_lag_threshold: 10\n');

    const { fn, calls } = makeStub('12\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic, 'epic-075 must appear in JSON');
    assert.ok(epic.integration_lag, 'integration_lag must be present for rolling branch epic');
    assert.equal(epic.integration_lag.commits_behind, 12);
    assert.equal(epic.integration_lag.threshold, 10);
    assert.equal(epic.integration_lag.warn, true);
    assert.equal(calls.length, 1, 'spawnSync called once');
    assert.ok(calls[0].args.includes('main..epic/epic-075'), 'args must reference the epic branch');
  });

  it('[AC5] stub returns 5, threshold 10 → warn=false', () => {
    seedEpicWithAgent('epic-075', 'Lag epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n  integration_branch_lag_threshold: 10\n');

    const { fn } = makeStub('5\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.integration_lag, 'integration_lag present even when below threshold');
    assert.equal(epic.integration_lag.warn, false);
    assert.equal(epic.integration_lag.commits_behind, 5);
  });

  it('[AC5] stub returns 0 → no warning', () => {
    seedEpicWithAgent('epic-075', 'Current branch');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n');

    const { fn } = makeStub('0\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.integration_lag, 'integration_lag present when branch is current');
    assert.equal(epic.integration_lag.warn, false);
    assert.equal(epic.integration_lag.commits_behind, 0);
  });

  it('[AC6] integration_branch !== rolling → no field, no git subprocess call', () => {
    seedEpicWithAgent('epic-075', 'Non-rolling epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: off\n');

    const { fn, calls } = makeStub('99\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic, 'epic-075 must appear in JSON');
    assert.ok(!epic.integration_lag, 'integration_lag must be absent when not rolling');
    assert.equal(calls.length, 0, 'spawnSync must NOT be called when integration_branch is off');
  });

  it('[AC6] no policy → defaults to off → no field, no subprocess call', () => {
    seedEpicWithAgent('epic-075', 'Default-policy epic');
    // policy.yaml has version: 1 only, no agents section → defaults apply

    const { fn, calls } = makeStub('99\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(!epic?.integration_lag, 'integration_lag absent with default (off) policy');
    assert.equal(calls.length, 0, 'no subprocess with default policy');
  });
});

// ─── Lag warning: human-readable output ──────────────────────────────────────

describe('loom status — integration_lag text (AC1)', () => {
  it('[AC1] warn=true → ⚠ line in human-readable output', () => {
    seedEpicWithAgent('epic-075', 'Lag epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n  integration_branch_lag_threshold: 5\n');

    const { fn } = makeStub('8\n');
    const out = captureText({ _spawnSync: fn });
    assert.ok(out.includes('⚠'), `Expected ⚠ in text output:\n${out}`);
    assert.ok(out.includes('8 commits behind main'), `Expected commit count in output:\n${out}`);
  });

  it('[AC5] warn=false → no ⚠ line', () => {
    seedEpicWithAgent('epic-075', 'Lag epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n  integration_branch_lag_threshold: 10\n');

    const { fn } = makeStub('3\n');
    const out = captureText({ _spawnSync: fn });
    // The ⚠ from a STALL warning is possible but not from lag — check no lag warning text
    assert.ok(!out.includes('commits behind main'), `Must NOT include lag warning:\n${out}`);
  });
});

// ─── Stale-planning: JSON output ─────────────────────────────────────────────

describe('loom status — stale_planning JSON (AC3)', () => {
  it('[AC3] planning 45m ago, threshold 30m → warn=true, idle_minutes≈45', () => {
    seedEpicWithAgent('epic-075', 'Stale planning epic', 'planning');
    setUpdatedAt('epic-075', 45 * 60 * 1000);
    writePolicyYaml('version: 1\nagents:\n  stale_planning_minutes: 30\n');

    const { fn } = makeStub('');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic, 'epic-075 must appear');
    assert.ok(epic.stale_planning, 'stale_planning must be present');
    assert.equal(epic.stale_planning.warn, true);
    assert.equal(epic.stale_planning.threshold_minutes, 30);
    assert.ok(
      Math.abs(epic.stale_planning.idle_minutes - 45) <= 2,
      `idle_minutes ≈ 45, got ${epic.stale_planning.idle_minutes}`
    );
  });

  it('[AC5] planning 10m ago, threshold 30m → warn=false', () => {
    seedEpicWithAgent('epic-075', 'Fresh planning epic', 'planning');
    setUpdatedAt('epic-075', 10 * 60 * 1000);
    writePolicyYaml('version: 1\nagents:\n  stale_planning_minutes: 30\n');

    const { fn } = makeStub('');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.stale_planning, 'stale_planning present even when below threshold');
    assert.equal(epic.stale_planning.warn, false);
  });

  it('[AC3] status != planning → no stale_planning field', () => {
    seedEpicWithAgent('epic-075', 'Non-planning epic', 'planned');
    setUpdatedAt('epic-075', 60 * 60 * 1000); // 1 hour ago

    const { fn } = makeStub('');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic, 'epic must appear');
    assert.ok(!epic.stale_planning, 'stale_planning must be absent when not planning');
  });
});

// ─── Stale-planning: human-readable output ────────────────────────────────────

describe('loom status — stale_planning text (AC3)', () => {
  it('[AC3] stale planning → ⚠ hint in human-readable output', () => {
    seedEpicWithAgent('epic-075', 'Stale epic', 'planning');
    setUpdatedAt('epic-075', 45 * 60 * 1000);
    writePolicyYaml('version: 1\nagents:\n  stale_planning_minutes: 30\n');

    const { fn } = makeStub('');
    const out = captureText({ _spawnSync: fn });
    assert.ok(out.includes('⚠'), `Expected ⚠ in text output:\n${out}`);
    assert.ok(out.includes('Planning has been idle'), `Expected idle message in output:\n${out}`);
  });

  it('[AC5] fresh planning → no stale hint', () => {
    seedEpicWithAgent('epic-075', 'Fresh epic', 'planning');
    setUpdatedAt('epic-075', 5 * 60 * 1000);
    writePolicyYaml('version: 1\nagents:\n  stale_planning_minutes: 30\n');

    const { fn } = makeStub('');
    const out = captureText({ _spawnSync: fn });
    assert.ok(!out.includes('Planning has been idle'), `Must NOT show stale hint:\n${out}`);
  });
});

// ─── Policy defaults (AC4) ────────────────────────────────────────────────────

describe('loom status — policy defaults (AC4)', () => {
  it('[AC4] integration_branch_lag_threshold absent → defaults to 10', () => {
    const policy = PolicySchema.parse({ version: 1, agents: { integration_branch: 'rolling' } });
    assert.equal(policy.agents.integration_branch_lag_threshold, 10);
  });

  it('[AC4] stale_planning_minutes absent → defaults to 30', () => {
    const policy = PolicySchema.parse({ version: 1 });
    assert.equal(policy.agents.stale_planning_minutes, 30);
  });

  it('[AC4] lag threshold default (10) used when only integration_branch: rolling set', () => {
    seedEpicWithAgent('epic-075', 'Default threshold epic');
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n');

    const { fn } = makeStub('10\n'); // exactly at threshold
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.integration_lag, 'integration_lag must be present');
    assert.equal(epic.integration_lag.threshold, 10, 'default threshold must be 10');
    assert.equal(epic.integration_lag.warn, true, '10 >= 10 → warn');
  });

  it('[AC4] stale_planning_minutes default (30) used when absent', () => {
    seedEpicWithAgent('epic-075', 'Default stale epic', 'planning');
    setUpdatedAt('epic-075', 35 * 60 * 1000); // 35m ago > 30m default
    writePolicyYaml('version: 1\n'); // no stale_planning_minutes

    const { fn } = makeStub('');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.stale_planning, 'stale_planning must be present');
    assert.equal(epic.stale_planning.threshold_minutes, 30, 'default threshold_minutes must be 30');
    assert.equal(epic.stale_planning.warn, true, '35m > 30m default → warn');
  });

  it('[AC4] Zod schema accepts both knobs as optional', () => {
    assert.doesNotThrow(() => {
      PolicySchema.parse({ version: 1, agents: { integration_branch_lag_threshold: 5, stale_planning_minutes: 15 } });
    });
  });

  it('[AC4] Zod schema enforces minimum 1 for both knobs', () => {
    assert.throws(() => {
      PolicySchema.parse({ version: 1, agents: { integration_branch_lag_threshold: 0 } });
    }, 'lag threshold must be >= 1');
    assert.throws(() => {
      PolicySchema.parse({ version: 1, agents: { stale_planning_minutes: 0 } });
    }, 'stale_planning_minutes must be >= 1');
  });
});

// ─── Lag: both signals together ───────────────────────────────────────────────

describe('loom status — both signals in JSON (AC2 + AC3)', () => {
  it('[AC2+AC3] rolling branch + planning epic → both fields present', () => {
    seedEpicWithAgent('epic-075', 'Combined epic', 'planning');
    setUpdatedAt('epic-075', 40 * 60 * 1000);
    writePolicyYaml('version: 1\nagents:\n  integration_branch: rolling\n  integration_branch_lag_threshold: 8\n  stale_planning_minutes: 20\n');

    const { fn } = makeStub('15\n');
    const payload = captureJson({ _spawnSync: fn });
    const epic = payload.epics.find((e) => e.id === 'epic-075');
    assert.ok(epic?.integration_lag, 'integration_lag must be present');
    assert.equal(epic.integration_lag.warn, true);
    assert.ok(epic.stale_planning, 'stale_planning must be present');
    assert.equal(epic.stale_planning.warn, true);
  });
});
