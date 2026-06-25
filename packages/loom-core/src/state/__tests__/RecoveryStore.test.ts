import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { RecoveryStore } from '../RecoveryStore.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-recovery-store-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('RecoveryStore — read and increment', () => {
  it('getRecoveryCount returns 0 for an absent story (no row)', () => {
    const db = createDatabase(path.join(tmpDir, 'get-absent.db'));
    const store = new RecoveryStore(db);
    assert.equal(store.getRecoveryCount('story-x'), 0);
    db.close();
  });

  it('incrementRecoveryCount creates the row and returns 1 on first call', () => {
    const db = createDatabase(path.join(tmpDir, 'inc-first.db'));
    const store = new RecoveryStore(db);
    assert.equal(store.incrementRecoveryCount('story-x'), 1);
    db.close();
  });

  it('incrementRecoveryCount returns 2 then 3 on subsequent calls (atomic UPSERT)', () => {
    const db = createDatabase(path.join(tmpDir, 'inc-multi.db'));
    const store = new RecoveryStore(db);
    assert.equal(store.incrementRecoveryCount('story-x'), 1);
    assert.equal(store.incrementRecoveryCount('story-x'), 2);
    assert.equal(store.incrementRecoveryCount('story-x'), 3);
    db.close();
  });

  it('getRecoveryCount reflects the persisted value after increments', () => {
    const db = createDatabase(path.join(tmpDir, 'get-after-inc.db'));
    const store = new RecoveryStore(db);
    store.incrementRecoveryCount('story-x');
    store.incrementRecoveryCount('story-x');
    assert.equal(store.getRecoveryCount('story-x'), 2);
    db.close();
  });

  it('per-story isolation: incrementing story-a leaves story-b at 0', () => {
    const db = createDatabase(path.join(tmpDir, 'isolation.db'));
    const store = new RecoveryStore(db);
    store.incrementRecoveryCount('story-a');
    store.incrementRecoveryCount('story-a');
    assert.equal(store.getRecoveryCount('story-b'), 0);
    assert.equal(store.getRecoveryCount('story-a'), 2);
    db.close();
  });
});

describe('RecoveryStore — survive restart (critical AC)', () => {
  it('count persists across DB close + reopen of the same file', () => {
    const dbPath = path.join(tmpDir, 'survive-restart.db');

    // First session: increment twice and close.
    const db1 = createDatabase(dbPath);
    const store1 = new RecoveryStore(db1);
    store1.incrementRecoveryCount('story-restart');
    store1.incrementRecoveryCount('story-restart');
    assert.equal(store1.getRecoveryCount('story-restart'), 2);
    db1.close();

    // Second session: reopen the same file — must see the persisted count.
    const db2 = new Database(dbPath);
    const store2 = new RecoveryStore(db2);
    assert.equal(
      store2.getRecoveryCount('story-restart'),
      2,
      'persisted count must survive DB close + reopen'
    );
    db2.close();
  });
});

// ─── v27 → v28 migration ──────────────────────────────────────────────────────

/**
 * Seeds a minimal v27 DB with pre-existing epics, agents, and audit_log rows
 * but without the story_recovery table. Exercises the additive CREATE TABLE IF
 * NOT EXISTS path that adds story_recovery on first startup after the upgrade.
 */
function seedV27Db(dbPath: string): Database.Database {
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
  db.prepare('INSERT INTO schema_version (version) VALUES (27)').run();
  db.prepare('INSERT INTO epics (id, title, status) VALUES (?, ?, ?)').run(
    'epic-v27', 'Pre-existing v27 epic', 'in_progress'
  );
  db.prepare(
    'INSERT INTO agents (id, epic_id, story_id, status) VALUES (?, ?, ?, ?)'
  ).run('agent-v27', 'epic-v27', 'story-v27-001', 'done');
  db.prepare(
    'INSERT INTO audit_log (agent_id, action, command) VALUES (?, ?, ?)'
  ).run('agent-v27', 'worker_done', 'story-v27-001');
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    }
  ).version;
}

describe('v27 → v28 migration (story_recovery table)', () => {
  it('applies additively and loss-free on a seeded v27 DB', () => {
    const dbPath = path.join(tmpDir, 'v27.db');
    const db = seedV27Db(dbPath);

    // Precondition: story_recovery absent at v27.
    assert.equal(schemaVersion(db), 27);
    assert.ok(!tableExists(db, 'story_recovery'), 'story_recovery absent before migration');

    runMigrations(db);

    // Schema bumped to current SCHEMA_VERSION (29 after epic-063 story-063-001).
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 29, 'SCHEMA_VERSION constant is 29');

    // story_recovery table now exists.
    assert.ok(tableExists(db, 'story_recovery'), 'story_recovery created by migration');

    // Pre-existing agents row survived.
    const agent = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('agent-v27') as Record<string, unknown> | undefined;
    assert.ok(agent, 'pre-existing agents row must survive');
    assert.equal(agent.story_id, 'story-v27-001');
    assert.equal(agent.status, 'done');

    // Pre-existing audit_log row survived.
    const audit = db
      .prepare('SELECT * FROM audit_log WHERE agent_id = ?')
      .get('agent-v27') as Record<string, unknown> | undefined;
    assert.ok(audit, 'pre-existing audit_log row must survive');
    assert.equal(audit.action, 'worker_done');

    db.close();
  });

  it('is idempotent — running migrations twice does not error or wipe recovery rows', () => {
    const dbPath = path.join(tmpDir, 'v27-idempotent.db');
    const db = seedV27Db(dbPath);

    runMigrations(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // Seed a recovery row before the second run.
    const store = new RecoveryStore(db);
    store.incrementRecoveryCount('story-idempotent');
    assert.equal(store.getRecoveryCount('story-idempotent'), 1);

    // Second runMigrations must not throw and must not wipe the row.
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(
      store.getRecoveryCount('story-idempotent'),
      1,
      'recovery row must survive a second migration run'
    );

    db.close();
  });

  it('initializes a brand-new DB directly at current SCHEMA_VERSION with story_recovery present', () => {
    const dbPath = path.join(tmpDir, 'fresh-v28.db');
    const db = createDatabase(dbPath);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.ok(tableExists(db, 'story_recovery'), 'story_recovery present on fresh DB');

    // RecoveryStore works immediately on the fresh DB.
    const store = new RecoveryStore(db);
    assert.equal(store.getRecoveryCount('story-new'), 0);
    assert.equal(store.incrementRecoveryCount('story-new'), 1);

    db.close();
  });
});
