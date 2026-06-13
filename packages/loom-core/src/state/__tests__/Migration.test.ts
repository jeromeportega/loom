import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '../Database.js';
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

    // Version bumped to current (v16 includes both v15 and v16 columns).
    assert.equal(schemaVersion(db), 16);

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
    assert.equal(schemaVersion(db), 16);

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

    assert.equal(schemaVersion(db), 16);
    const cols = epicColumns(db);
    assert.ok(cols.includes('finalize_phase'));
    assert.ok(cols.includes('epic_pr_url'));
    assert.ok(cols.includes('error'));
    assert.ok(cols.includes('autonomy_level'));
    assert.ok(cols.includes('paused_at'));
    assert.ok(cols.includes('paused_after_story'));

    db.close();
  });
});

describe('EpicStatusSchema (DB runtime enum)', () => {
  it('parses the new finalizing and failed statuses', () => {
    assert.equal(EpicStatusSchema.parse('finalizing'), 'finalizing');
    assert.equal(EpicStatusSchema.parse('failed'), 'failed');
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

    assert.equal(schemaVersion(db), 16);
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
    assert.equal(schemaVersion(db), 16);

    const cols = epicColumns(db);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('autonomy_level'), 1);
    assert.equal(count('paused_at'), 1);
    assert.equal(count('paused_after_story'), 1);

    db.close();
  });

  it('initializes a brand-new DB directly at v16 with all three columns present', () => {
    const dbPath = path.join(tmpDir, 'fresh-v16.db');
    const db = createDatabase(dbPath);

    assert.equal(schemaVersion(db), 16);
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
