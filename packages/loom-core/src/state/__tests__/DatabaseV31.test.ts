/**
 * Integration tests for migration v31 (story-096-001):
 * adds prev_hash, entry_hash, contract_hash to audit_log.
 *
 * All tests use real SQLite via better-sqlite3 — no mocks.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-v31-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

function auditLogColInfo(db: Database.Database): ColInfo[] {
  return db.prepare('PRAGMA table_info(audit_log)').all() as ColInfo[];
}

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }
  ).version;
}

/**
 * Seeds a minimal pre-v31 DB: schema_version=30, audit_log table WITHOUT
 * the three new columns, and one pre-existing audit row.
 */
function seedV30Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
      command TEXT,
      allowed INTEGER,
      policy_rule TEXT,
      detail TEXT,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (30)').run();
  db.prepare(
    `INSERT INTO audit_log (action, command) VALUES (?, ?)`
  ).run('guard_checked', 'git status');
  return db;
}

// ─── SCHEMA_VERSION constant ──────────────────────────────────────────────────

describe('SCHEMA_VERSION constant (v31)', () => {
  it('is at least 31 (v31 features present)', () => {
    assert.ok(SCHEMA_VERSION >= 31, 'SCHEMA_VERSION must be >= 31 for v31 features');
  });
});

// ─── Fresh install ────────────────────────────────────────────────────────────

describe('v31 — fresh install', () => {
  it('creates all three hash columns with notnull=0 and dflt_value=NULL', () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const db = createDatabase(dbPath);

    const cols = auditLogColInfo(db);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    assert.ok(byName['prev_hash'],     'prev_hash column must exist');
    assert.ok(byName['entry_hash'],    'entry_hash column must exist');
    assert.ok(byName['contract_hash'], 'contract_hash column must exist');

    for (const col of ['prev_hash', 'entry_hash', 'contract_hash']) {
      assert.equal(byName[col].notnull,    0,    `${col}: notnull must be 0 (nullable)`);
      assert.equal(byName[col].dflt_value, null, `${col}: dflt_value must be NULL`);
      assert.equal(byName[col].type,       'TEXT', `${col}: type must be TEXT`);
    }

    assert.equal(schemaVersion(db), SCHEMA_VERSION, 'schema_version must equal SCHEMA_VERSION after fresh install');

    db.close();
  });
});

// ─── v30 → v31 upgrade ───────────────────────────────────────────────────────

describe('v30 → v31 upgrade', () => {
  it('adds the three columns to a pre-v31 DB without data loss', () => {
    const dbPath = path.join(tmpDir, 'v30.db');
    const db = seedV30Db(dbPath);

    // Precondition: columns absent before migration.
    const before = auditLogColInfo(db).map((c) => c.name);
    assert.ok(!before.includes('prev_hash'),     'prev_hash absent pre-migration');
    assert.ok(!before.includes('entry_hash'),    'entry_hash absent pre-migration');
    assert.ok(!before.includes('contract_hash'), 'contract_hash absent pre-migration');

    runMigrations(db);

    // (a) All three columns now exist.
    const after = auditLogColInfo(db).map((c) => c.name);
    assert.ok(after.includes('prev_hash'),     'prev_hash added by v31 migration');
    assert.ok(after.includes('entry_hash'),    'entry_hash added by v31 migration');
    assert.ok(after.includes('contract_hash'), 'contract_hash added by v31 migration');

    // (b) Pre-existing row's new columns are NULL — no backfill.
    const row = db.prepare('SELECT * FROM audit_log LIMIT 1').get() as Record<string, unknown>;
    assert.ok(row, 'pre-existing audit_log row must survive migration');
    assert.equal(row.action,         'guard_checked', 'original action intact');
    assert.equal(row.command,        'git status',    'original command intact');
    assert.equal(row.prev_hash,      null,            'prev_hash is NULL on pre-existing row');
    assert.equal(row.entry_hash,     null,            'entry_hash is NULL on pre-existing row');
    assert.equal(row.contract_hash,  null,            'contract_hash is NULL on pre-existing row');

    // (c) No columns were dropped — original columns still present.
    for (const col of ['id', 'agent_id', 'action', 'command', 'allowed', 'policy_rule', 'detail', 'timestamp']) {
      assert.ok(after.includes(col), `original column ${col} still present`);
    }

    // (d) schema_version reads current SCHEMA_VERSION.
    assert.equal(schemaVersion(db), SCHEMA_VERSION, 'schema_version bumped to SCHEMA_VERSION');

    db.close();
  });
});

// ─── Column type assertion ────────────────────────────────────────────────────

describe('v31 column types', () => {
  it('PRAGMA table_info reports type = TEXT for all three new columns', () => {
    const dbPath = path.join(tmpDir, 'col-types.db');
    const db = createDatabase(dbPath);

    const cols = auditLogColInfo(db);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));

    assert.equal(byName['prev_hash'].type,     'TEXT', 'prev_hash type is TEXT');
    assert.equal(byName['entry_hash'].type,    'TEXT', 'entry_hash type is TEXT');
    assert.equal(byName['contract_hash'].type, 'TEXT', 'contract_hash type is TEXT');

    db.close();
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('v31 migration — idempotency', () => {
  it('calling runMigrations twice on the same DB does not throw', () => {
    const dbPath = path.join(tmpDir, 'idempotent-fresh.db');
    const db = createDatabase(dbPath);

    assert.doesNotThrow(
      () => runMigrations(db),
      'second runMigrations() on a fresh DB must not throw'
    );
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // Columns appear exactly once after two runs.
    const cols = auditLogColInfo(db).map((c) => c.name);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('prev_hash'),     1, 'prev_hash appears exactly once');
    assert.equal(count('entry_hash'),    1, 'entry_hash appears exactly once');
    assert.equal(count('contract_hash'), 1, 'contract_hash appears exactly once');

    db.close();
  });

  it('calling runMigrations twice on a seeded v30 DB does not throw', () => {
    const dbPath = path.join(tmpDir, 'idempotent-v30.db');
    const db = seedV30Db(dbPath);

    runMigrations(db);
    assert.doesNotThrow(
      () => runMigrations(db),
      'second runMigrations() on an upgraded v30 DB must not throw'
    );
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    db.close();
  });
});
