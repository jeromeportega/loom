/**
 * Tests for `loom cost` — read-only cost and timing breakdown command.
 *
 * Covers:
 * - [AC1] Single-run breakdown: --run <id> renders cost and time by phase
 * - [AC2] Cross-run aggregates: --aggregate computes from raw rows
 * - [AC3] Strictly read-only: DB row counts identical before and after
 * - Empty state: graceful message, exit 0
 * - Median correctness: odd- and even-N row sets per verdict
 * - Time-share sanity: shares sum to ~1.0
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  MetricsStore,
  resetDatabaseForTest,
} from '@loom-ai/core';
import { runCost } from '../commands/cost.js';
import { capture } from './testUtils.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

let repo: string;
let prevCwd: string;

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cost-test-'));
  const loomDir = path.join(repo, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), 'version: 1\n');
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

type RunInput = Parameters<MetricsStore['recordRun']>[0];

function makeRun(overrides: Partial<RunInput> = {}): RunInput {
  return {
    scope: 'epic' as const,
    epicId: 'epic-001',
    retryCount: 0,
    cleanRetryCount: 0,
    autoRecoveryCount: 0,
    outcome: 'done' as const,
    intakeVerdict: 'epic' as const,
    startedAt: '2026-06-24T10:00:00Z',
    endedAt: '2026-06-24T10:05:00Z',
    phases: [
      {
        phase: 'analyst' as const,
        model: 'claude-sonnet-4-6',
        tokensInput: 1000,
        tokensOutput: 500,
        tokensCached: 200,
        tokensCacheCreation: 100,
        billedTokens: 1800,
        costUsd: 0.01,
        requestCount: 1,
        wallMs: 5000,
      },
      {
        phase: 'worker' as const,
        model: 'claude-sonnet-4-6',
        tokensInput: 2000,
        tokensOutput: 1000,
        tokensCached: 400,
        tokensCacheCreation: 200,
        billedTokens: 3600,
        costUsd: 0.02,
        requestCount: 2,
        wallMs: 10000,
      },
    ],
    ...overrides,
  };
}

// ─── empty state ─────────────────────────────────────────────────────────────

describe('loom cost — empty state', () => {
  it('[AC1, AC2] shows graceful message when no metrics exist, exits 0', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.close();

    const result = await capture(() => runCost({}));
    assert.strictEqual(result.exitCode, null, 'should not call process.exit');
    const out = result.logs.join('\n');
    assert.ok(out.includes('No metrics') || out.length === 0, `Expected graceful message, got: ${out}`);
    assert.strictEqual(result.errors.length, 0, 'should not print errors');
  });

  it('[AC2] --aggregate with no data shows graceful messages', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.close();

    const result = await capture(() => runCost({ aggregate: true }));
    assert.strictEqual(result.exitCode, null, 'should not call process.exit on empty aggregate');
    const out = result.logs.join('\n');
    assert.ok(out.length > 0, 'should output something for aggregate command');
    assert.ok(
      out.includes('(no data)') || out.includes('no data'),
      `Expected graceful no-data message for aggregates, got: ${out}`
    );
  });
});

// ─── single-run breakdown [AC1] ──────────────────────────────────────────────

describe('loom cost --run — single-run breakdown [AC1]', () => {
  it('renders cost and time by phase with attribution dimensions', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    const runId = store.recordRun(makeRun());
    db.close();

    const result = await capture(() => runCost({ run: runId }));
    assert.strictEqual(result.exitCode, null);
    const out = result.logs.join('\n');

    // Run header with scope and epic attribution
    assert.ok(out.includes(`Run #${runId}`), `should include run id: ${out}`);
    assert.ok(out.includes('epic'), `should show scope: ${out}`);
    assert.ok(out.includes('epic-001'), `should show epic attribution: ${out}`);

    // Phase breakdown
    assert.ok(out.includes('analyst'), `should show analyst phase: ${out}`);
    assert.ok(out.includes('worker'), `should show worker phase: ${out}`);

    // Cost information
    assert.ok(out.includes('$'), `should show cost in USD: ${out}`);
  });

  it('renders --json output with run and phases', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    const runId = store.recordRun(makeRun());
    db.close();

    const result = await capture(() => runCost({ run: runId, json: true }));
    assert.strictEqual(result.exitCode, null);

    const raw = result.logs.join('\n');
    const payload = JSON.parse(raw) as { run: { id: number; phases: unknown[] } };
    assert.strictEqual(payload.run.id, runId);
    assert.ok(Array.isArray(payload.run.phases), 'phases should be an array');
    assert.strictEqual(payload.run.phases.length, 2, 'should have 2 phases');
  });

  it('exits 1 when run id not found', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.close();

    const result = await capture(() => runCost({ run: 99999 }));
    assert.strictEqual(result.exitCode, 1, 'should exit 1 for missing run');
    assert.ok(result.errors.some((e) => e.includes('99999')), 'should name the missing run id');
  });

  it('lists recent runs when no --run flag', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    store.recordRun(makeRun());
    db.close();

    const result = await capture(() => runCost({}));
    assert.strictEqual(result.exitCode, null);
    const out = result.logs.join('\n');
    assert.ok(out.includes('Run #'), `should list runs: ${out}`);
  });
});

// ─── cross-run aggregates [AC2] ──────────────────────────────────────────────

describe('loom cost --aggregate — cross-run aggregates [AC2]', () => {
  it('shows median planning cost by verdict, time share by phase, retry/recovery cost', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    store.recordRun(makeRun({ intakeVerdict: 'epic', scope: 'epic' }));
    store.recordRun(makeRun({ intakeVerdict: 'story', scope: 'standalone_story', epicId: undefined, storyId: 'story-001' }));
    db.close();

    const result = await capture(() => runCost({ aggregate: true }));
    assert.strictEqual(result.exitCode, null);
    const out = result.logs.join('\n');

    assert.ok(out.includes('Median planning cost'), `should show median cost section: ${out}`);
    assert.ok(out.includes('Time share by phase'), `should show time share section: ${out}`);
    assert.ok(out.includes('Retry'), `should show retry/recovery section: ${out}`);
  });

  it('--aggregate --json emits structured data', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    store.recordRun(makeRun());
    db.close();

    const result = await capture(() => runCost({ aggregate: true, json: true }));
    assert.strictEqual(result.exitCode, null);

    const raw = result.logs.join('\n');
    const payload = JSON.parse(raw) as {
      medianPlanningCostByVerdict: unknown[];
      timeShareByPhase: unknown[];
      retryRecoveryCost: unknown;
    };
    assert.ok(Array.isArray(payload.medianPlanningCostByVerdict));
    assert.ok(Array.isArray(payload.timeShareByPhase));
    assert.ok(typeof payload.retryRecoveryCost === 'object');
  });
});

// ─── median correctness [AC2] ────────────────────────────────────────────────

describe('loom cost --aggregate — median correctness [AC2]', () => {
  it('odd-N set: median is the middle value', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const store = new MetricsStore(db);

    // Seed 3 standalone-story runs with costs 0.01, 0.03, 0.05 → median 0.03
    let i = 0;
    for (const cost of [0.01, 0.03, 0.05]) {
      store.recordRun({
        scope: 'standalone_story' as const,
        storyId: `story-odd-${i++}`,
        intakeVerdict: 'epic' as const,
        retryCount: 0,
        cleanRetryCount: 0,
        autoRecoveryCount: 0,
        outcome: 'done' as const,
        phases: [{ phase: 'analyst' as const, model: 'claude-sonnet-4-6', tokensInput: 100, tokensOutput: 50, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 150, costUsd: cost, requestCount: 1, wallMs: 1000 }],
      });
    }
    db.close();

    const result = await capture(() => runCost({ aggregate: true, json: true }));
    assert.strictEqual(result.exitCode, null);

    const payload = JSON.parse(result.logs.join('\n')) as {
      medianPlanningCostByVerdict: Array<{ verdict: string; medianCostUsd: number; n: number }>;
    };
    const epicEntry = payload.medianPlanningCostByVerdict.find((e) => e.verdict === 'epic');
    assert.ok(epicEntry, 'should have an epic entry');
    assert.strictEqual(epicEntry.n, 3, 'n should be 3');
    assert.ok(
      Math.abs(epicEntry.medianCostUsd - 0.03) < 0.0001,
      `odd-N median should be 0.03, got ${epicEntry.medianCostUsd}`
    );
  });

  it('even-N set: median is average of two middle values', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const store = new MetricsStore(db);

    // Seed 4 story-scoped runs with costs 0.01, 0.02, 0.04, 0.08 → median (0.02+0.04)/2 = 0.03
    for (const cost of [0.01, 0.02, 0.04, 0.08]) {
      store.recordRun({
        scope: 'standalone_story',
        storyId: `story-${cost}`,
        intakeVerdict: 'story',
        retryCount: 0,
        cleanRetryCount: 0,
        autoRecoveryCount: 0,
        outcome: 'done',
        phases: [{ phase: 'analyst', model: 'claude-sonnet-4-6', tokensInput: 100, tokensOutput: 50, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 150, costUsd: cost, requestCount: 1, wallMs: 1000 }],
      });
    }
    db.close();

    const result = await capture(() => runCost({ aggregate: true, json: true }));
    assert.strictEqual(result.exitCode, null);

    const payload = JSON.parse(result.logs.join('\n')) as {
      medianPlanningCostByVerdict: Array<{ verdict: string; medianCostUsd: number; n: number }>;
    };
    const storyEntry = payload.medianPlanningCostByVerdict.find((e) => e.verdict === 'story');
    assert.ok(storyEntry, 'should have a story entry');
    assert.strictEqual(storyEntry.n, 4, 'n should be 4');
    assert.ok(
      Math.abs(storyEntry.medianCostUsd - 0.03) < 0.0001,
      `even-N median should be 0.03, got ${storyEntry.medianCostUsd}`
    );
  });
});

// ─── time-share sanity [AC2] ─────────────────────────────────────────────────

describe('loom cost --aggregate — time-share sanity [AC2]', () => {
  it('per-phase shares sum to ~1.0', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    store.recordRun(makeRun());
    db.close();

    const result = await capture(() => runCost({ aggregate: true, json: true }));
    assert.strictEqual(result.exitCode, null);

    const payload = JSON.parse(result.logs.join('\n')) as {
      timeShareByPhase: Array<{ phase: string; wallMs: number; share: number }>;
    };
    assert.ok(payload.timeShareByPhase.length > 0, 'should have at least one phase');

    const total = payload.timeShareByPhase.reduce((sum, p) => sum + p.share, 0);
    assert.ok(
      Math.abs(total - 1.0) < 0.01,
      `time shares should sum to ~1.0, got ${total}`
    );
  });
});

// ─── strictly read-only [AC3] ────────────────────────────────────────────────

describe('loom cost — strictly read-only [AC3]', () => {
  it('DB row counts are identical before and after the command', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'done')").run();
    const store = new MetricsStore(db);
    store.recordRun(makeRun());
    db.close();

    // Run the command to open the DB at loom-home path (via migration)
    await capture(() => runCost({}));

    // Now open the same DB directly and check row counts
    resetDatabaseForTest();
    // Re-open the loom-home DB: we have to use openProjectDatabase again
    const { openProjectDatabase } = await import('../dbHelper.js');
    const db2 = openProjectDatabase(repo);
    const runsBefore = (db2.prepare('SELECT COUNT(*) as n FROM run_metrics').get() as { n: number }).n;
    const phasesBefore = (db2.prepare('SELECT COUNT(*) as n FROM run_metrics_phase').get() as { n: number }).n;
    const auditBefore = (db2.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    resetDatabaseForTest();

    // Run the command again
    await capture(() => runCost({}));
    await capture(() => runCost({ aggregate: true }));

    // Check row counts again
    resetDatabaseForTest();
    const db3 = openProjectDatabase(repo);
    const runsAfter = (db3.prepare('SELECT COUNT(*) as n FROM run_metrics').get() as { n: number }).n;
    const phasesAfter = (db3.prepare('SELECT COUNT(*) as n FROM run_metrics_phase').get() as { n: number }).n;
    const auditAfter = (db3.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }).n;
    resetDatabaseForTest();

    assert.strictEqual(runsAfter, runsBefore, 'run_metrics row count must not change');
    assert.strictEqual(phasesAfter, phasesBefore, 'run_metrics_phase row count must not change');
    assert.strictEqual(auditAfter, auditBefore, 'audit_log row count must not change');
  });

  it('does not initialize with an error when called with no initialized loom directory', async () => {
    // Remove the policy.yaml to simulate non-initialized state
    fs.unlinkSync(path.join(repo, '.loom', 'policy.yaml'));
    const result = await capture(() => runCost({}));
    assert.strictEqual(result.exitCode, 1, 'should exit 1 when not initialized');
    assert.ok(result.errors.length > 0, 'should show an error message');
  });
});
