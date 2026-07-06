import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EpicStore, resetDatabaseForTest } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;

function loom(cmdSuffix: string, env?: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number;
} {
  try {
    const stdout = execSync(`node "${LOOM_CLI}" ${cmdSuffix}`, {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gate-test-'));
  execSync('git init -q', { cwd: tmpDir });
  loom('init');

  // Seed epics directly into the DB (planning needs an API key).
  resetDatabaseForTest();
  const db = openProjectDatabase(tmpDir);
  const store = new EpicStore(db);
  store.create('epic-001', 'First seeded epic');
  store.create('epic-002', 'Second seeded epic');
  // epic-003: planning status (no yaml_path — matches real loom epic in-flight)
  store.beginPlanning('epic-003', 'Planning epic brief');
  // epic-004: in_progress status
  store.create('epic-004', 'In-progress epic');
  store.updateStatus('epic-004', 'in_progress');
  resetDatabaseForTest();
});

after(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function epicStatus(id: string): string | undefined {
  resetDatabaseForTest();
  const db = openProjectDatabase(tmpDir);
  const status = new EpicStore(db).get(id)?.status;
  resetDatabaseForTest();
  return status;
}

describe('loom approve / reject', () => {
  it('rejects a planned epic with a reason', () => {
    const result = loom('reject epic-002 --reason "scope too large"');
    assert.equal(result.status, 0);
    assert.equal(epicStatus('epic-002'), 'rejected');
  });

  it('approves a single planned epic by id', () => {
    const result = loom('approve epic-001');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('approved'));
    assert.equal(epicStatus('epic-001'), 'approved');
  });

  it('persists policy_snapshot at approve time (CLI/MCP parity, v0.5.0)', () => {
    // Reads the row directly — the helper hides the fresh-DB-conn dance the
    // CLI tests use, and we need the snapshot column specifically (not just
    // the status). The snapshot is the EpicFinalizer's rebind input; without
    // it CLI-approved epics couldn't diff against live policy at finalize.
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    const row = new EpicStore(db).get('epic-001');
    resetDatabaseForTest();
    assert.ok(row, 'epic row exists');
    assert.ok(
      row!.policy_snapshot,
      'policy_snapshot is non-null after `loom approve`'
    );
    const parsed = JSON.parse(row!.policy_snapshot!);
    // Sanity: it's the parsed YAML, not a stale empty placeholder.
    assert.ok(parsed.agents, 'snapshot is a structured Policy object');
    assert.equal(typeof parsed.agents.shared_contract, 'string');
  });

  it('errors when approving an unknown epic', () => {
    const result = loom('approve epic-999');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('not found'));
  });

  it('errors when approving an already-approved epic', () => {
    const result = loom('approve epic-001');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('not "planned"'));
  });

  it('errors when rejecting a non-planned epic', () => {
    const result = loom('reject epic-002');
    assert.equal(result.status, 1);
  });

  // story-075-004: reject from planning status
  it('rejects a planning-status epic (exits 0, DB becomes rejected)', () => {
    const result = loom('reject epic-003');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('rejected'));
    assert.equal(epicStatus('epic-003'), 'rejected');
  });

  it('listByStatus(rejected) handles null yaml_path from a planning-era row', () => {
    // epic-003 was created via beginPlanning (yaml_path=NULL) and rejected above
    resetDatabaseForTest();
    const db = openProjectDatabase(tmpDir);
    const rows = new EpicStore(db).listByStatus('rejected');
    resetDatabaseForTest();
    const planningRow = rows.find(r => r.id === 'epic-003');
    assert.ok(planningRow, 'rejected planning epic is returned by listByStatus');
    assert.equal(planningRow!.yaml_path, null, 'yaml_path is null — handled without throwing');
  });

  it('errors when rejecting an already-rejected epic (terminal status — unchanged)', () => {
    // epic-002 was already rejected in the first test
    const result = loom('reject epic-002');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('cannot reject'));
  });

  it('errors when rejecting an approved epic (unchanged error path)', () => {
    // epic-001 was approved in an earlier test
    const result = loom('reject epic-001');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('cannot reject'));
  });

  it('errors when rejecting an in_progress epic (unchanged)', () => {
    const result = loom('reject epic-004');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('cannot reject'));
  });

  it('errors when rejecting a non-existent epic', () => {
    const result = loom('reject epic-777');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('not found'));
  });
});

describe('loom epic', () => {
  it('rejects a too-short brief before any LLM call', () => {
    const result = loom('epic "tiny"');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('at least a sentence'));
  });

  it('rejects an unsupported llm_backend value', () => {
    // Confirm the policy schema refuses the removed anthropic-api backend
    // before any LLM client is constructed.
    const policyPath = path.join(tmpDir, '.loom', 'policy.yaml');
    const original = fs.readFileSync(policyPath, 'utf8');
    const policy = original.replace('llm_backend: "claude-cli"', 'llm_backend: "anthropic-api"');
    fs.writeFileSync(policyPath, policy);

    try {
      const result = loom('epic "Build a small demo feature for the policy validation test."');
      assert.equal(result.status, 1);
    } finally {
      fs.writeFileSync(policyPath, original);
    }
  });
});

describe('loom doctor', () => {
  it('reports prerequisite checks and the init state', () => {
    const result = loom('doctor');
    // Node and git are present in the test environment → exit 0.
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('loom doctor'));
    assert.ok(result.stdout.includes('Node.js'));
    assert.ok(result.stdout.includes('git'));
  });
});

describe('loom stop', () => {
  it('sets the stop signal', () => {
    const result = loom('stop');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('Stop signal sent'));
  });
});
