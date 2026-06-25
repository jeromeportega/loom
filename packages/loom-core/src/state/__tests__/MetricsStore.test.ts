import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { MetricsStore } from '../MetricsStore.js';
import { RUN_METRICS_SCHEMA_VERSION } from '../../metrics/types.js';
import type { RunMetricsInput } from '../../metrics/types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-metrics-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(name: string): Database.Database {
  return createDatabase(path.join(tmpDir, name));
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function indexExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function schemaVersion(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Seed a minimal epic row so FK references on run_metrics.epic_id succeed. */
function seedEpic(db: Database.Database, epicId: string): void {
  db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES (?, ?, 'planned')").run(
    epicId,
    `Epic ${epicId}`,
  );
}

/**
 * Minimal RunMetricsInput with no FK-referencing fields by default.
 * Tests that need epicId can pass it via overrides + seedEpic().
 */
function makeInput(overrides: Partial<RunMetricsInput> = {}): RunMetricsInput {
  return {
    scope: 'standalone_story',
    retryCount: 0,
    cleanRetryCount: 0,
    autoRecoveryCount: 0,
    outcome: 'done',
    phases: [
      {
        phase: 'analyst',
        model: 'claude-sonnet-4-6',
        tokensInput: 100,
        tokensOutput: 50,
        tokensCached: 20,
        tokensCacheCreation: 10,
        billedTokens: 180,
        costUsd: 0.001,
        requestCount: 1,
        wallMs: 1000,
      },
      {
        phase: 'pm',
        model: 'claude-sonnet-4-6',
        tokensInput: 200,
        tokensOutput: 100,
        tokensCached: 40,
        tokensCacheCreation: 20,
        billedTokens: 360,
        costUsd: 0.002,
        requestCount: 2,
        wallMs: 2000,
      },
    ],
    ...overrides,
  };
}

/** makeInput that also seeds the epic (scope='epic'). */
function makeEpicInput(db: Database.Database, epicId: string, overrides: Partial<RunMetricsInput> = {}): RunMetricsInput {
  seedEpic(db, epicId);
  return makeInput({ scope: 'epic', epicId, ...overrides });
}

// ─── Migration tests ──────────────────────────────────────────────────────────

describe('v28 → v29 migration (run_metrics tables)', () => {
  it('brand-new DB has both tables with schema_version column and 3 indexes', () => {
    const db = makeDb('fresh-v29.db');

    assert.ok(tableExists(db, 'run_metrics'), 'run_metrics table exists');
    assert.ok(tableExists(db, 'run_metrics_phase'), 'run_metrics_phase table exists');

    // schema_version column on run_metrics
    const runCols = columns(db, 'run_metrics');
    assert.ok(runCols.includes('schema_version'), 'run_metrics.schema_version column exists');

    // Three required indexes
    assert.ok(indexExists(db, 'idx_run_metrics_epic'),      'idx_run_metrics_epic exists');
    assert.ok(indexExists(db, 'idx_run_metrics_scope'),     'idx_run_metrics_scope exists');
    assert.ok(indexExists(db, 'idx_run_metrics_phase_run'), 'idx_run_metrics_phase_run exists');

    // SCHEMA_VERSION bumped to 29
    assert.equal(schemaVersion(db), 29);
    assert.equal(SCHEMA_VERSION, 29, 'SCHEMA_VERSION constant is 29');

    db.close();
  });

  it('runMigrations twice is idempotent — no error, no duplicate tables', () => {
    const db = makeDb('idempotent-v29.db');

    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    assert.ok(tableExists(db, 'run_metrics'));
    assert.ok(tableExists(db, 'run_metrics_phase'));

    db.close();
  });

  it('seeded v28 DB gains both tables after migration (additive, no data loss)', () => {
    const dbPath = path.join(tmpDir, 'v28-to-v29.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Minimal v28 schema: story_recovery present but run_metrics absent
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      CREATE TABLE epics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        action TEXT NOT NULL,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE story_recovery (
        story_id TEXT PRIMARY KEY,
        recovery_count INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare('INSERT INTO schema_version (version) VALUES (28)').run();
    db.prepare("INSERT INTO epics (id, title, status) VALUES ('epic-pre', 'Pre-existing', 'done')").run();

    assert.ok(!tableExists(db, 'run_metrics'), 'run_metrics absent before migration');

    runMigrations(db);

    assert.equal(schemaVersion(db), 29);
    assert.ok(tableExists(db, 'run_metrics'));
    assert.ok(tableExists(db, 'run_metrics_phase'));

    // Pre-existing data intact
    const epic = db.prepare('SELECT status FROM epics WHERE id = ?').get('epic-pre') as { status: string };
    assert.equal(epic.status, 'done');

    db.close();
  });
});

// ─── recordRun happy path ─────────────────────────────────────────────────────

describe('MetricsStore.recordRun — happy path', () => {
  it('returns an integer id and writes parent + N phase rows', () => {
    const db = makeDb('record-run-happy.db');
    const store = new MetricsStore(db);

    const id = store.recordRun(makeInput());

    assert.equal(typeof id, 'number');
    assert.ok(id > 0);

    const parentCount = (db.prepare('SELECT COUNT(*) as n FROM run_metrics WHERE id = ?').get(id) as { n: number }).n;
    assert.equal(parentCount, 1, 'one parent row');

    const phaseCount = (db.prepare('SELECT COUNT(*) as n FROM run_metrics_phase WHERE run_id = ?').get(id) as { n: number }).n;
    assert.equal(phaseCount, 2, 'two phase rows for two-phase input');

    db.close();
  });

  it('stamps schema_version = RUN_METRICS_SCHEMA_VERSION (1) on every parent row', () => {
    const db = makeDb('schema-version-stamp.db');
    const store = new MetricsStore(db);

    const id = store.recordRun(makeInput());

    const parent = db.prepare('SELECT schema_version FROM run_metrics WHERE id = ?').get(id) as { schema_version: number };
    assert.equal(parent.schema_version, RUN_METRICS_SCHEMA_VERSION);
    assert.equal(RUN_METRICS_SCHEMA_VERSION, 1, 'RUN_METRICS_SCHEMA_VERSION constant is 1');

    db.close();
  });

  it('multiple recordRun calls produce monotonically increasing ids', () => {
    const db = makeDb('multi-insert.db');
    const store = new MetricsStore(db);

    const id1 = store.recordRun(makeInput());
    const id2 = store.recordRun(makeInput());
    const id3 = store.recordRun(makeInput());

    assert.ok(id2 > id1 && id3 > id2, 'ids are monotonically increasing');

    db.close();
  });
});

// ─── Round-trip: getRun / getPhases ──────────────────────────────────────────

describe('MetricsStore.getRun — round-trip', () => {
  it('returns all attribution columns intact', () => {
    const db = makeDb('getrun-round-trip.db');
    const store = new MetricsStore(db);
    seedEpic(db, 'epic-rt');
    const input = makeInput({
      scope: 'epic',
      epicId: 'epic-rt',
      storyId: 'story-rt-001',
      intakeVerdict: 'epic',
      intakeKind: 'brief',
      storyCount: 3,
      retryCount: 1,
      cleanRetryCount: 0,
      autoRecoveryCount: 2,
      outcome: 'done',
      dispatchLatencyMs: 500,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
    });

    const id = store.recordRun(input);
    const rec = store.getRun(id);

    assert.ok(rec, 'getRun returns a record');
    assert.equal(rec.id, id);
    assert.equal(rec.scope, 'epic');
    assert.equal(rec.epicId, 'epic-rt');
    assert.equal(rec.storyId, 'story-rt-001');
    assert.equal(rec.intakeVerdict, 'epic');
    assert.equal(rec.intakeKind, 'brief');
    assert.equal(rec.storyCount, 3);
    assert.equal(rec.retryCount, 1);
    assert.equal(rec.cleanRetryCount, 0);
    assert.equal(rec.autoRecoveryCount, 2);
    assert.equal(rec.outcome, 'done');
    assert.equal(rec.dispatchLatencyMs, 500);
    assert.equal(rec.startedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(rec.endedAt, '2026-01-01T00:01:00.000Z');
    assert.ok(typeof rec.createdAt === 'string' && rec.createdAt.length > 0);

    db.close();
  });

  it('returns undefined for a non-existent id', () => {
    const db = makeDb('getrun-missing.db');
    const store = new MetricsStore(db);
    assert.equal(store.getRun(9999), undefined);
    db.close();
  });

  it('totalWallMs equals the sum of phase wallMs values', () => {
    const db = makeDb('getrun-totals.db');
    const store = new MetricsStore(db);
    const input = makeInput();
    const expectedWall = input.phases.reduce((s, p) => s + p.wallMs, 0);

    const id = store.recordRun(input);
    const rec = store.getRun(id)!;

    assert.equal(rec.totalWallMs, expectedWall, 'totalWallMs = sum of phase wallMs');

    db.close();
  });
});

describe('MetricsStore.getPhases — round-trip', () => {
  it('returns every phase with all token and cost fields', () => {
    const db = makeDb('getphases-round-trip.db');
    const store = new MetricsStore(db);
    const input = makeInput();

    const id = store.recordRun(input);
    const phases = store.getPhases(id);

    assert.equal(phases.length, 2);
    const [analyst, pm] = phases;

    assert.equal(analyst.runId, id);
    assert.equal(analyst.phase, 'analyst');
    assert.equal(analyst.model, 'claude-sonnet-4-6');
    assert.equal(analyst.tokensInput, 100);
    assert.equal(analyst.tokensOutput, 50);
    assert.equal(analyst.tokensCached, 20);
    assert.equal(analyst.tokensCacheCreation, 10);
    assert.equal(analyst.billedTokens, 180);
    assert.equal(analyst.costUsd, 0.001);
    assert.equal(analyst.requestCount, 1);
    assert.equal(analyst.wallMs, 1000);

    assert.equal(pm.phase, 'pm');
    assert.equal(pm.billedTokens, 360);
    assert.equal(pm.requestCount, 2);
    assert.equal(pm.wallMs, 2000);

    db.close();
  });

  it('returns empty array for a run with no phases', () => {
    const db = makeDb('getphases-empty.db');
    const store = new MetricsStore(db);
    const input = makeInput({ phases: [] });

    const id = store.recordRun(input);
    const phases = store.getPhases(id);

    assert.equal(phases.length, 0);

    db.close();
  });

  it('phases for different runs are isolated', () => {
    const db = makeDb('getphases-isolation.db');
    const store = new MetricsStore(db);

    const id1 = store.recordRun(makeInput({ phases: [{ phase: 'analyst', tokensInput: 10, tokensOutput: 5, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 15, requestCount: 1, wallMs: 100 }] }));
    const id2 = store.recordRun(makeInput({ phases: [
      { phase: 'pm',       tokensInput: 20, tokensOutput: 10, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 30, requestCount: 1, wallMs: 200 },
      { phase: 'architect', tokensInput: 30, tokensOutput: 15, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 45, requestCount: 1, wallMs: 300 },
    ] }));

    assert.equal(store.getPhases(id1).length, 1);
    assert.equal(store.getPhases(id2).length, 2);
    assert.equal(store.getPhases(id1)[0].phase, 'analyst');

    db.close();
  });
});

// ─── listRuns filters ─────────────────────────────────────────────────────────

describe('MetricsStore.listRuns — filters', () => {
  it('no filter returns all rows up to default limit', () => {
    const db = makeDb('listRuns-all.db');
    const store = new MetricsStore(db);
    seedEpic(db, 'epic-A');
    seedEpic(db, 'epic-B');

    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-A' }));
    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-B' }));
    store.recordRun(makeInput({ scope: 'standalone_story' }));

    const all = store.listRuns();
    assert.equal(all.length, 3);

    db.close();
  });

  it('epicId filter returns only runs for that epic', () => {
    const db = makeDb('listRuns-epicId.db');
    const store = new MetricsStore(db);
    seedEpic(db, 'epic-X');
    seedEpic(db, 'epic-Y');

    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-X' }));
    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-X' }));
    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-Y' }));

    const filtered = store.listRuns({ epicId: 'epic-X' });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every((r) => r.epicId === 'epic-X'));

    db.close();
  });

  it('scope filter returns only runs matching that scope', () => {
    const db = makeDb('listRuns-scope.db');
    const store = new MetricsStore(db);
    seedEpic(db, 'epic-scope-test');

    store.recordRun(makeInput({ scope: 'epic', epicId: 'epic-scope-test' }));
    store.recordRun(makeInput({ scope: 'standalone_story' }));
    store.recordRun(makeInput({ scope: 'epic_story', epicId: 'epic-scope-test' }));

    const epicRuns = store.listRuns({ scope: 'epic' });
    assert.equal(epicRuns.length, 1);
    assert.equal(epicRuns[0].scope, 'epic');

    const standaloneRuns = store.listRuns({ scope: 'standalone_story' });
    assert.equal(standaloneRuns.length, 1);

    db.close();
  });

  it('limit filter caps the number of returned rows', () => {
    const db = makeDb('listRuns-limit.db');
    const store = new MetricsStore(db);

    for (let i = 0; i < 5; i++) {
      store.recordRun(makeInput());
    }

    const limited = store.listRuns({ limit: 2 });
    assert.equal(limited.length, 2);

    db.close();
  });

  it('combined epicId + scope filter intersects both dimensions', () => {
    const db = makeDb('listRuns-combined.db');
    const store = new MetricsStore(db);
    seedEpic(db, 'epic-Z');
    seedEpic(db, 'epic-W');

    store.recordRun(makeInput({ scope: 'epic',       epicId: 'epic-Z' }));
    store.recordRun(makeInput({ scope: 'epic_story', epicId: 'epic-Z' }));
    store.recordRun(makeInput({ scope: 'epic',       epicId: 'epic-W' }));

    const result = store.listRuns({ epicId: 'epic-Z', scope: 'epic' });
    assert.equal(result.length, 1);
    assert.equal(result[0].scope, 'epic');
    assert.equal(result[0].epicId, 'epic-Z');

    db.close();
  });
});

// ─── Transaction atomicity ────────────────────────────────────────────────────

describe('MetricsStore.recordRun — transaction atomicity', () => {
  it('phase-insert failure rolls back the parent row (no orphan)', () => {
    const db = makeDb('atomicity.db');

    // Install a trigger that aborts any phase insert → forces transaction rollback.
    db.exec(`
      CREATE TRIGGER force_phase_fail BEFORE INSERT ON run_metrics_phase
      BEGIN SELECT RAISE(ABORT, 'forced-failure-for-test'); END;
    `);

    const store = new MetricsStore(db);
    const input = makeInput();

    assert.throws(
      () => store.recordRun(input),
      /forced-failure-for-test/,
      'recordRun must throw when phase insert fails'
    );

    // Parent row must not exist — the transaction was rolled back.
    const parentCount = (db.prepare('SELECT COUNT(*) as n FROM run_metrics').get() as { n: number }).n;
    assert.equal(parentCount, 0, 'parent row rolled back — no orphan in run_metrics');

    db.close();
  });
});

// ─── Totals reconciliation ───────────────────────────────────────────────────

describe('MetricsStore — totals reconcile', () => {
  it('parent billed_tokens_total equals SUM of phase billed_tokens', () => {
    const db = makeDb('totals-reconcile.db');
    const store = new MetricsStore(db);
    const input = makeInput();

    const id = store.recordRun(input);

    const rec = store.getRun(id)!;
    const phases = store.getPhases(id);

    const sumBilled = phases.reduce((s, p) => s + p.billedTokens, 0);
    assert.equal(rec.billedTokensTotal, sumBilled, 'parent billedTokensTotal === SUM of phase billedTokens');

    db.close();
  });

  it('parent total_wall_ms equals SUM of phase wall_ms', () => {
    const db = makeDb('wall-ms-reconcile.db');
    const store = new MetricsStore(db);
    const input = makeInput();

    const id = store.recordRun(input);

    const rec = store.getRun(id)!;
    const phases = store.getPhases(id);

    const sumWall = phases.reduce((s, p) => s + p.wallMs, 0);
    assert.equal(rec.totalWallMs, sumWall, 'parent totalWallMs === SUM of phase wallMs');

    db.close();
  });
});

// ─── CHECK constraint enforcement ────────────────────────────────────────────

describe('MetricsStore — CHECK constraints', () => {
  it('rejects scope outside the allowed enum', () => {
    const db = makeDb('check-scope.db');
    const store = new MetricsStore(db);

    // Cast to bypass TypeScript's type check — tests runtime enforcement.
    const badInput = makeInput({ scope: 'invalid_scope' as never });

    assert.throws(
      () => store.recordRun(badInput),
      /CHECK constraint failed/i,
      'invalid scope must be rejected by CHECK constraint'
    );

    db.close();
  });

  it('rejects outcome outside the allowed enum when non-null', () => {
    const db = makeDb('check-outcome.db');
    const store = new MetricsStore(db);

    const badInput = makeInput({ outcome: 'invalid_outcome' as never });

    assert.throws(
      () => store.recordRun(badInput),
      /CHECK constraint failed/i,
      'invalid outcome must be rejected by CHECK constraint'
    );

    db.close();
  });

  it('accepts NULL outcome (optional field)', () => {
    const db = makeDb('check-outcome-null.db');
    const store = new MetricsStore(db);

    const input = makeInput({ outcome: undefined });
    assert.doesNotThrow(() => store.recordRun(input), 'undefined (NULL) outcome is allowed');

    db.close();
  });
});

// ─── No-secrets schema check ─────────────────────────────────────────────────

describe('MetricsStore — schema has no free-text/secret columns', () => {
  it('run_metrics has no detail/text/prompt/blob/message/content columns', () => {
    const db = makeDb('no-secrets-run.db');
    const cols = columns(db, 'run_metrics');

    const forbidden = ['detail', 'prompt', 'message', 'content', 'blob', 'text', 'rationale', 'log'];
    for (const name of forbidden) {
      assert.ok(!cols.includes(name), `run_metrics must not have a '${name}' column`);
    }

    db.close();
  });

  it('run_metrics_phase has no detail/text/prompt/blob/message/content columns', () => {
    const db = makeDb('no-secrets-phase.db');
    const cols = columns(db, 'run_metrics_phase');

    const forbidden = ['detail', 'prompt', 'message', 'content', 'blob', 'text', 'rationale', 'log'];
    for (const name of forbidden) {
      assert.ok(!cols.includes(name), `run_metrics_phase must not have a '${name}' column`);
    }

    db.close();
  });
});

// ─── Aggregate methods ────────────────────────────────────────────────────────

describe('MetricsStore.medianPlanningCostByVerdict', () => {
  it('returns median cost grouped by intake_verdict', () => {
    const db = makeDb('median-cost.db');
    const store = new MetricsStore(db);

    // Three 'epic' verdict runs: costs 0.01, 0.02, 0.03 → median = 0.02
    const mkPhase = (costUsd: number) => [{
      phase: 'analyst' as const,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCached: 0,
      tokensCacheCreation: 0,
      billedTokens: 0,
      costUsd,
      requestCount: 1,
      wallMs: 1,
    }];
    store.recordRun(makeInput({ intakeVerdict: 'epic', phases: mkPhase(0.01) }));
    store.recordRun(makeInput({ intakeVerdict: 'epic', phases: mkPhase(0.02) }));
    store.recordRun(makeInput({ intakeVerdict: 'epic', phases: mkPhase(0.03) }));

    const results = store.medianPlanningCostByVerdict();
    const epicResult = results.find((r) => r.verdict === 'epic');
    assert.ok(epicResult, 'epic verdict result exists');
    assert.equal(epicResult.n, 3);
    assert.ok(Math.abs(epicResult.medianCostUsd - 0.02) < 1e-9, 'median of [0.01, 0.02, 0.03] is 0.02');

    db.close();
  });

  it('returns empty array when no runs with cost exist', () => {
    const db = makeDb('median-empty.db');
    const store = new MetricsStore(db);

    const results = store.medianPlanningCostByVerdict();
    assert.equal(results.length, 0);

    db.close();
  });
});

describe('MetricsStore.timeShareByPhase', () => {
  it('shares sum to 1.0 and phase values match wall_ms totals', () => {
    const db = makeDb('timeshare.db');
    const store = new MetricsStore(db);

    store.recordRun(makeInput({
      phases: [
        { phase: 'analyst', tokensInput: 0, tokensOutput: 0, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 0, requestCount: 1, wallMs: 1000 },
        { phase: 'pm',      tokensInput: 0, tokensOutput: 0, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 0, requestCount: 1, wallMs: 3000 },
      ],
    }));

    const result = store.timeShareByPhase();
    const totalShare = result.reduce((s, r) => s + r.share, 0);
    assert.ok(Math.abs(totalShare - 1.0) < 1e-9, 'shares sum to 1.0');

    const analystRow = result.find((r) => r.phase === 'analyst')!;
    const pmRow = result.find((r) => r.phase === 'pm')!;
    assert.equal(analystRow.wallMs, 1000);
    assert.equal(pmRow.wallMs, 3000);
    assert.ok(Math.abs(analystRow.share - 0.25) < 1e-9, 'analyst share is 0.25');
    assert.ok(Math.abs(pmRow.share - 0.75) < 1e-9, 'pm share is 0.75');

    db.close();
  });
});

describe('MetricsStore.retryRecoveryCost', () => {
  it('returns zero counts when no runs with retries exist', () => {
    const db = makeDb('retry-empty.db');
    const store = new MetricsStore(db);

    const result = store.retryRecoveryCost();
    assert.equal(result.retryTokens, 0);
    assert.equal(result.autoRecoveryTokens, 0);
    assert.equal(result.costUsd, 0);

    db.close();
  });

  it('counts tokens from runs with retry_count > 0', () => {
    const db = makeDb('retry-counts.db');
    const store = new MetricsStore(db);

    // A run with retries: billedTokens = 150
    store.recordRun(makeInput({
      retryCount: 2,
      phases: [
        { phase: 'worker', tokensInput: 100, tokensOutput: 50, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 150, requestCount: 1, wallMs: 1 },
      ],
    }));
    // A clean run (no retries) — should not be counted
    store.recordRun(makeInput({
      retryCount: 0,
      phases: [
        { phase: 'worker', tokensInput: 999, tokensOutput: 999, tokensCached: 0, tokensCacheCreation: 0, billedTokens: 1998, requestCount: 1, wallMs: 1 },
      ],
    }));

    const result = store.retryRecoveryCost();
    assert.equal(result.retryTokens, 150, 'only tokens from retry runs counted');

    db.close();
  });
});
