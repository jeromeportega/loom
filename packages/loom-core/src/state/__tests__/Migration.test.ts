import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { EpicStore } from '../EpicStore.js';
import {
  AutonomyLevelSchema,
  EpicStatusSchema,
  EpicYamlSchema,
  type FinalizePhase,
  type EpicRecord,
} from '../../types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migration-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Seeds a minimal pre-v15 (v14) DB by hand: just enough of the `epics` table
 * and a schema_version row marked 14, with one populated epic row. Deliberately
 * omits the v15 columns so runMigrations() exercises the additive ALTER path.
 */
function seedV14Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      planning_phase TEXT,
      archived_at DATETIME
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (14)').run();
  db.prepare(
    `INSERT INTO epics (id, title, status, reason, planning_phase)
     VALUES (?, ?, ?, ?, ?)`
  ).run('epic-100', 'Pre-existing v14 epic', 'in_progress', 'kept reason', null);
  return db;
}

function epicColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info('epics')").all() as { name: string }[]).map(
    (c) => c.name
  );
}

function schemaVersion(db: Database.Database): number {
  return (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
    version: number;
  }).version;
}

describe('v14 → v15 migration', () => {
  it('applies additively and loss-free on a seeded v14 DB', () => {
    const dbPath = path.join(tmpDir, 'v14.db');
    const db = seedV14Db(dbPath);

    // Precondition: at v14, the new columns do not yet exist.
    assert.equal(schemaVersion(db), 14);
    const before = epicColumns(db);
    assert.ok(!before.includes('finalize_phase'));
    assert.ok(!before.includes('epic_pr_url'));
    assert.ok(!before.includes('error'));

    runMigrations(db);

    // Version bumped to current schema version.
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // The three v15 columns now exist.
    const after = epicColumns(db);
    assert.ok(after.includes('finalize_phase'));
    assert.ok(after.includes('epic_pr_url'));
    assert.ok(after.includes('error'));
    // The three v16 columns also added in the same run.
    assert.ok(after.includes('autonomy_level'));
    assert.ok(after.includes('paused_at'));
    assert.ok(after.includes('paused_after_story'));

    // Pre-existing row survived intact, with the new columns defaulting sensibly.
    const row = db
      .prepare('SELECT * FROM epics WHERE id = ?')
      .get('epic-100') as Record<string, unknown>;
    assert.ok(row, 'pre-existing v14 row must survive the migration');
    assert.equal(row.title, 'Pre-existing v14 epic');
    assert.equal(row.status, 'in_progress');
    assert.equal(row.reason, 'kept reason');
    assert.equal(row.finalize_phase, null);
    assert.equal(row.epic_pr_url, null);
    assert.equal(row.error, null);
    assert.equal(row.autonomy_level, 'manual', 'v16 default: manual');
    assert.equal(row.paused_at, null);
    assert.equal(row.paused_after_story, null);

    db.close();
  });

  it('is idempotent — running migrations twice does not throw or double-add', () => {
    const dbPath = path.join(tmpDir, 'idempotent.db');
    const db = seedV14Db(dbPath);

    runMigrations(db);
    // Second run against the current schema must be a no-op, not an error.
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // The guarded blocks must not have added duplicate columns.
    const cols = epicColumns(db);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('finalize_phase'), 1);
    assert.equal(count('epic_pr_url'), 1);
    assert.equal(count('error'), 1);
    assert.equal(count('autonomy_level'), 1);
    assert.equal(count('paused_at'), 1);
    assert.equal(count('paused_after_story'), 1);

    db.close();
  });

  it('initializes a brand-new DB directly at the current version with all columns present', () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const db = createDatabase(dbPath);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const cols = epicColumns(db);
    assert.ok(cols.includes('finalize_phase'));
    assert.ok(cols.includes('epic_pr_url'));
    assert.ok(cols.includes('error'));
    assert.ok(cols.includes('autonomy_level'));
    assert.ok(cols.includes('paused_at'));
    assert.ok(cols.includes('paused_after_story'));
    assert.ok(cols.includes('proposed_by'));
    assert.ok(cols.includes('finalize_ref'));
    assert.ok(cols.includes('publish_note'));

    db.close();
  });
});

describe('EpicStatusSchema (DB runtime enum)', () => {
  it('parses the new finalizing and failed statuses', () => {
    assert.equal(EpicStatusSchema.parse('finalizing'), 'finalizing');
    assert.equal(EpicStatusSchema.parse('failed'), 'failed');
  });

  it('parses publish_pending as a valid DB-only status (AC1)', () => {
    assert.equal(EpicStatusSchema.parse('publish_pending'), 'publish_pending');
  });

  it('publish_pending is distinct from failed and rejected (AC1)', () => {
    const pp = EpicStatusSchema.parse('publish_pending');
    assert.notEqual(pp, 'failed');
    assert.notEqual(pp, 'rejected');
  });

  it('still accepts the existing statuses', () => {
    for (const s of [
      'planning',
      'planned',
      'approved',
      'rejected',
      'in_progress',
      'done',
    ]) {
      assert.equal(EpicStatusSchema.parse(s), s);
    }
  });

  it('rejects a bogus status', () => {
    assert.throws(() => EpicStatusSchema.parse('bogus'));
  });
});

describe('EpicYamlSchema.status (plan-time enum, ADR-4: failed is DB-only)', () => {
  it("THROWS on 'failed' — it must never be a plan-time status", () => {
    assert.throws(() => EpicYamlSchema.shape.status.parse('failed'));
  });

  it("rejects 'finalizing' too — also DB-only", () => {
    assert.throws(() => EpicYamlSchema.shape.status.parse('finalizing'));
  });

  it("rejects 'publish_pending' — DB-only, never a plan-time status (AC1, AC4)", () => {
    assert.throws(() => EpicYamlSchema.shape.status.parse('publish_pending'));
  });

  it('still accepts only the plan-time statuses', () => {
    for (const s of ['planned', 'approved', 'in_progress', 'done', 'rejected']) {
      assert.equal(EpicYamlSchema.shape.status.parse(s), s);
    }
  });
});

describe('FinalizePhase + EpicRecord type shape', () => {
  it('FinalizePhase accepts each defined phase', () => {
    const phases: FinalizePhase[] = [
      'merging',
      'gate',
      'review',
      'pushing',
      'opening_pr',
    ];
    // Round-trip through a string[] proves the union members are all valid.
    assert.deepEqual(phases, [
      'merging',
      'gate',
      'review',
      'pushing',
      'opening_pr',
    ]);
  });

  it('an EpicStore round-trips an EpicRecord carrying the three new nullable fields', () => {
    const db = createDatabase(path.join(tmpDir, 'record-shape.db'));
    const store = new EpicStore(db);

    store.create('epic-200', 'Finalize lifecycle epic');

    // Fresh epic: the three new fields default to null on read.
    let rec = store.get('epic-200');
    assert.ok(rec);
    assert.equal(rec.finalize_phase, null);
    assert.equal(rec.epic_pr_url, null);
    assert.equal(rec.error, null);

    // Drive the finalize overlay and assert the fields round-trip through reads.
    store.beginFinalizing('epic-200', 'merging');
    rec = store.get('epic-200');
    assert.equal(rec?.status, 'finalizing');
    assert.equal(rec?.finalize_phase, 'merging');

    store.updateFinalizePhase('epic-200', 'opening_pr');
    assert.equal(store.get('epic-200')?.finalize_phase, 'opening_pr');

    store.recordPrUrl('epic-200', 'https://example.com/pull/7');
    assert.equal(store.get('epic-200')?.epic_pr_url, 'https://example.com/pull/7');

    store.fail('epic-200', 'remote rejected the push');
    rec = store.get('epic-200');
    assert.equal(rec?.status, 'failed');
    assert.equal(rec?.error, 'remote rejected the push');
    // fail() clears the live phase — the run is no longer in flight.
    assert.equal(rec?.finalize_phase, null);
    // The PR URL of record survives the failure transition.
    assert.equal(rec?.epic_pr_url, 'https://example.com/pull/7');

    // Static check: the record satisfies the EpicRecord shape for the new fields.
    const _typecheck: Pick<EpicRecord, 'finalize_phase' | 'epic_pr_url' | 'error'> = {
      finalize_phase: rec!.finalize_phase,
      epic_pr_url: rec!.epic_pr_url,
      error: rec!.error,
    };
    assert.ok(_typecheck);

    db.close();
  });
});

// ─── v15 → v16 migration (autonomy + checkpoint-pause) ───────────────────────

/**
 * Seeds a minimal v15 DB: epics table without the three v16 autonomy columns,
 * one pre-existing epic row, schema_version=15.
 */
function seedV15Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      planning_phase TEXT,
      archived_at DATETIME,
      finalize_phase TEXT,
      epic_pr_url TEXT,
      error TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (15)').run();
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`
  ).run('epic-100', 'Pre-existing v15 epic', 'in_progress');
  return db;
}

describe('v15 → v16 migration (autonomy / checkpoint-pause)', () => {
  it('applies additively and loss-free on a seeded v15 DB', () => {
    const dbPath = path.join(tmpDir, 'v15.db');
    const db = seedV15Db(dbPath);

    assert.equal(schemaVersion(db), 15);
    const before = epicColumns(db);
    assert.ok(!before.includes('autonomy_level'));
    assert.ok(!before.includes('paused_at'));
    assert.ok(!before.includes('paused_after_story'));

    runMigrations(db);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const after = epicColumns(db);
    assert.ok(after.includes('autonomy_level'));
    assert.ok(after.includes('paused_at'));
    assert.ok(after.includes('paused_after_story'));

    // Pre-existing row reads as 'manual' with no backfill error (backward-compat AC).
    const row = db
      .prepare('SELECT * FROM epics WHERE id = ?')
      .get('epic-100') as Record<string, unknown>;
    assert.ok(row, 'pre-existing v15 row must survive the migration');
    assert.equal(row.title, 'Pre-existing v15 epic');
    assert.equal(row.autonomy_level, 'manual', 'defaults to manual — no backfill needed');
    assert.equal(row.paused_at, null);
    assert.equal(row.paused_after_story, null);

    db.close();
  });

  it('is idempotent — running migrations twice does not throw or duplicate columns', () => {
    const dbPath = path.join(tmpDir, 'v15-idempotent.db');
    const db = seedV15Db(dbPath);

    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    const cols = epicColumns(db);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('autonomy_level'), 1);
    assert.equal(count('paused_at'), 1);
    assert.equal(count('paused_after_story'), 1);

    db.close();
  });

  it('initializes a brand-new DB at the current version with autonomy columns present', () => {
    const dbPath = path.join(tmpDir, 'fresh-v16.db');
    const db = createDatabase(dbPath);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const cols = epicColumns(db);
    assert.ok(cols.includes('autonomy_level'));
    assert.ok(cols.includes('paused_at'));
    assert.ok(cols.includes('paused_after_story'));

    db.close();
  });

  it('pre-existing epic read via EpicStore returns autonomy_level === manual (backward-compat)', () => {
    const dbPath = path.join(tmpDir, 'v15-compat.db');
    const db = seedV15Db(dbPath);
    runMigrations(db);

    const store = new EpicStore(db);
    assert.equal(store.getAutonomy('epic-100'), 'manual');

    db.close();
  });
});

describe('AutonomyLevelSchema', () => {
  it('accepts each valid level', () => {
    assert.equal(AutonomyLevelSchema.parse('manual'), 'manual');
    assert.equal(AutonomyLevelSchema.parse('checkpoint'), 'checkpoint');
    assert.equal(AutonomyLevelSchema.parse('full-auto'), 'full-auto');
  });

  it('rejects invalid values', () => {
    assert.throws(() => AutonomyLevelSchema.parse('auto'));
    assert.throws(() => AutonomyLevelSchema.parse(''));
    assert.throws(() => AutonomyLevelSchema.parse('MANUAL'));
  });
});

// ─── v18 → v19 migration (publish_pending lifecycle support) ─────────────────

/**
 * Seeds a minimal v18 DB: epics table with all columns present at v18 but
 * WITHOUT finalize_ref / publish_note, four pre-existing rows in distinct
 * statuses (failed, rejected, finalizing, in_progress), schema_version=18.
 */
function seedV18Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      brief_path TEXT,
      prd_path TEXT,
      yaml_path TEXT,
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      planner_tokens_input INTEGER,
      planner_tokens_output INTEGER,
      planner_tokens_cached INTEGER,
      planner_ms INTEGER,
      base_sha TEXT,
      archived_at DATETIME,
      user_brief TEXT,
      planning_phase TEXT,
      planner_request_count INTEGER,
      policy_snapshot TEXT,
      finalize_phase TEXT,
      epic_pr_url TEXT,
      error TEXT,
      autonomy_level TEXT NOT NULL DEFAULT 'manual',
      paused_at DATETIME,
      paused_after_story TEXT,
      proposed_by TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (18)').run();
  // Four rows in the statuses the test plan specifies.
  const rows: Array<[string, string, string]> = [
    ['epic-v18-failed',      'Failed run',     'failed'],
    ['epic-v18-rejected',    'Rejected plan',  'rejected'],
    ['epic-v18-finalizing',  'Finalizing now', 'finalizing'],
    ['epic-v18-in-progress', 'Active epic',    'in_progress'],
  ];
  const insert = db.prepare(
    `INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`
  );
  for (const [id, title, status] of rows) {
    insert.run(id, title, status);
  }
  return db;
}

describe('v18 → v19 migration (publish_pending lifecycle, AC2, AC3, AC4)', () => {
  it('applies additively — new columns exist and pre-existing rows are untouched (AC3)', () => {
    const dbPath = path.join(tmpDir, 'v18.db');
    const db = seedV18Db(dbPath);

    // Precondition: v18 DB lacks the new columns.
    assert.equal(schemaVersion(db), 18);
    const before = epicColumns(db);
    assert.ok(!before.includes('finalize_ref'), 'finalize_ref absent at v18');
    assert.ok(!before.includes('publish_note'), 'publish_note absent at v18');

    runMigrations(db);

    // Schema bumped to current SCHEMA_VERSION.
    assert.equal(schemaVersion(db), SCHEMA_VERSION, `SCHEMA_VERSION should be ${SCHEMA_VERSION} after migration (AC2)`);

    // Both new columns now exist.
    const after = epicColumns(db);
    assert.ok(after.includes('finalize_ref'), 'finalize_ref added by v19 migration');
    assert.ok(after.includes('publish_note'), 'publish_note added by v19 migration');

    // Every pre-existing row has NULL for the new columns — no UPDATE/backfill ran.
    const all = db.prepare('SELECT id, status, finalize_ref, publish_note FROM epics').all() as
      Array<{ id: string; status: string; finalize_ref: string | null; publish_note: string | null }>;
    assert.equal(all.length, 4, 'all four seed rows survived');
    for (const row of all) {
      assert.equal(row.finalize_ref, null, `finalize_ref NULL on ${row.id}`);
      assert.equal(row.publish_note, null, `publish_note NULL on ${row.id}`);
    }

    db.close();
  });

  it('failed and rejected rows keep their status byte-for-byte — semantics preserved (AC4)', () => {
    const dbPath = path.join(tmpDir, 'v18-semantics.db');
    const db = seedV18Db(dbPath);
    runMigrations(db);

    const get = (id: string) =>
      db.prepare('SELECT status FROM epics WHERE id = ?').get(id) as { status: string };

    assert.equal(get('epic-v18-failed').status,      'failed',      'failed row unchanged');
    assert.equal(get('epic-v18-rejected').status,    'rejected',    'rejected row unchanged');
    assert.equal(get('epic-v18-finalizing').status,  'finalizing',  'finalizing row unchanged');
    assert.equal(get('epic-v18-in-progress').status, 'in_progress', 'in_progress row unchanged');

    db.close();
  });

  it('is idempotent — running runMigrations again on a v19 DB is a no-op (AC2)', () => {
    const dbPath = path.join(tmpDir, 'v18-idempotent.db');
    const db = seedV18Db(dbPath);

    runMigrations(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // Second run must not throw, must not double-add columns, and version stays 19.
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    const cols = epicColumns(db);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('finalize_ref'), 1, 'finalize_ref appears exactly once');
    assert.equal(count('publish_note'), 1, 'publish_note appears exactly once');

    db.close();
  });

  it('EpicStore.publishPending writes status, finalize_ref, publish_note atomically', () => {
    const dbPath = path.join(tmpDir, 'v18-publishPending.db');
    const db = createDatabase(dbPath);
    const store = new EpicStore(db);

    store.create('epic-pp-001', 'Publish-pending test epic');
    store.beginFinalizing('epic-pp-001', 'pushing');

    const ref = 'loom/finalize/epic-pp-001-1a2b3c4';
    const note = 'remote rejected push: not a fast-forward';
    store.publishPending('epic-pp-001', ref, note);

    const rec = store.get('epic-pp-001')!;
    assert.equal(rec.status, 'publish_pending');
    assert.equal(rec.finalize_ref, ref);
    assert.equal(rec.publish_note, note);
    // finalize_phase is cleared — the run is no longer in flight.
    assert.equal(rec.finalize_phase, null);

    db.close();
  });

  it('EpicStore.recordFinalizeRef writes only finalize_ref without changing status', () => {
    const dbPath = path.join(tmpDir, 'v18-recordRef.db');
    const db = createDatabase(dbPath);
    const store = new EpicStore(db);

    store.create('epic-pp-002', 'Record finalize ref test');
    store.beginFinalizing('epic-pp-002', 'pushing');

    const ref = 'loom/finalize/epic-pp-002-deadbeef';
    store.recordFinalizeRef('epic-pp-002', ref);

    const rec = store.get('epic-pp-002')!;
    // Status stays finalizing — only the ref was recorded.
    assert.equal(rec.status, 'finalizing');
    assert.equal(rec.finalize_ref, ref);
    assert.equal(rec.publish_note, null);

    db.close();
  });
});
