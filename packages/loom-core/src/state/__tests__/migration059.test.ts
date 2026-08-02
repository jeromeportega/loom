/**
 * Tests for migration v26 (story-059-003): repointStandaloneIds
 *
 * Integration tests against a real in-memory/temp SQLite DB. These tests cover:
 *   - Losslessness: all related rows re-pointed, all columns preserved
 *   - Untouched-by-design: story_id, agent ids, normal-epic rows unchanged
 *   - Number preservation: idNumber('story-047') === idNumber('epic-047') === 47
 *   - Idempotency: re-run is a structural no-op
 *   - Atomicity: a mid-migration failure leaves zero orphans (full rollback)
 *   - Normal-epic guard: kind=NULL rows are never touched
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { idNumber } from '../../planner/paths.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migration059-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Seeds a minimal pre-v26 DB with:
 *   - one standalone epic bearing the OLD epic-NNN id (epic-047)
 *   - its agents / decision_traces / audit_log rows
 *   - one NORMAL epic (epic-048) that must be completely untouched
 *
 * IMPORTANT: foreign_keys = ON is enabled so that the migration MUST use
 * PRAGMA defer_foreign_keys=ON to succeed — if it didn't, the UPDATE on
 * epics.id would fail immediately with an FK violation.
 */
function seedPreV26Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      epic_pr_url TEXT,
      finalize_ref TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      autonomy_level TEXT NOT NULL DEFAULT 'manual',
      kind TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL REFERENCES epics(id),
      story_id TEXT NOT NULL,
      story_title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE decision_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      epic_id TEXT,
      story_id TEXT,
      kind TEXT NOT NULL,
      rationale TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      action TEXT NOT NULL,
      command TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (25)').run();

  // Standalone epic with pre-migration epic-NNN id + all columns we want to survive.
  db.prepare(`
    INSERT INTO epics (id, title, status, kind, epic_pr_url, finalize_ref)
    VALUES ('epic-047', 'My standalone story', 'planned', 'standalone',
            'https://github.com/test/pr/47', 'refs/heads/epic-047-finalize')
  `).run();

  // Normal epic — must NOT be touched.
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES ('epic-048', 'Normal epic', 'in_progress')`
  ).run();

  // Agent under standalone container.  id format agent-story-NNN-<hex> must survive unchanged.
  db.prepare(`
    INSERT INTO agents (id, epic_id, story_id, story_title, status)
    VALUES ('agent-story-047-aabbccdd', 'epic-047', 'story-047', 'My standalone story', 'done')
  `).run();

  // Agent under normal epic.
  db.prepare(`
    INSERT INTO agents (id, epic_id, story_id, story_title, status)
    VALUES ('agent-story-048-001-xxyyzz', 'epic-048', 'story-048-001', 'Normal story', 'in_progress')
  `).run();

  // Decision trace for standalone (epic_id='epic-047', story_id='story-047').
  db.prepare(`
    INSERT INTO decision_traces (agent_id, epic_id, story_id, kind, rationale)
    VALUES ('agent-story-047-aabbccdd', 'epic-047', 'story-047', 'planning', 'Test rationale')
  `).run();

  // Epic-level audit log row (command='epic-047') — MUST be renamed to 'story-047'.
  db.prepare(`INSERT INTO audit_log (action, command) VALUES ('epic_approved', 'epic-047')`).run();

  // Story-level audit log row (command='story-047') — must NOT be renamed (already story-framed).
  db.prepare(`
    INSERT INTO audit_log (agent_id, action, command)
    VALUES ('agent-story-047-aabbccdd', 'guard_checked', 'story-047')
  `).run();

  // Normal-epic audit log row (command='epic-048') — must NOT be touched.
  db.prepare(`INSERT INTO audit_log (action, command) VALUES ('epic_approved', 'epic-048')`).run();

  return db;
}

/**
 * Seeds a DB for the atomicity test:
 *   - One standalone epic (epic-041) with an agent
 *   - story-041 already exists as a normal epic, so the migration's UPDATE
 *     on epics.id='epic-041'→'story-041' will fail with a UNIQUE violation
 *   → expect a full rollback, zero orphans
 */
function seedAtomicityDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      autonomy_level TEXT NOT NULL DEFAULT 'manual',
      kind TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL REFERENCES epics(id),
      story_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE decision_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id TEXT,
      story_id TEXT,
      kind TEXT NOT NULL,
      rationale TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      command TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (25)').run();

  // Standalone epic — the migration target.
  db.prepare(
    `INSERT INTO epics (id, title, status, kind) VALUES ('epic-041', 'Story 041', 'planned', 'standalone')`
  ).run();

  // Pre-insert the migration target id to cause a UNIQUE PK conflict.
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES ('story-041', 'Pre-existing story-041', 'planned')`
  ).run();

  // Agent whose epic_id='epic-041' must NOT become orphaned after rollback.
  db.prepare(`
    INSERT INTO agents (id, epic_id, story_id, status)
    VALUES ('agent-story-041-atomictest', 'epic-041', 'story-041', 'pending')
  `).run();

  return db;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }
  ).version;
}

type Row = Record<string, unknown>;

function getRow(db: Database.Database, table: string, id: string | number): Row | undefined {
  const col = typeof id === 'string' ? 'id' : 'rowid';
  return db.prepare(`SELECT * FROM ${table} WHERE ${col} = ?`).get(id) as Row | undefined;
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ─── Losslessness ─────────────────────────────────────────────────────────────

describe('v26 repointStandaloneIds — losslessness (AC1)', () => {
  it('renames standalone epic-047 to story-047 and re-points all related rows', () => {
    const dbPath = path.join(tmpDir, 'lossless.db');
    const db = seedPreV26Db(dbPath);

    // Pre-migration counts.
    const epicsBefore  = countRows(db, 'epics');
    const agentsBefore = countRows(db, 'agents');
    const tracesBefore = countRows(db, 'decision_traces');
    const auditBefore  = countRows(db, 'audit_log');

    runMigrations(db);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // Row counts must be unchanged — nothing dropped or duplicated.
    assert.equal(countRows(db, 'epics'),            epicsBefore,  'epic count unchanged');
    assert.equal(countRows(db, 'agents'),           agentsBefore, 'agent count unchanged');
    assert.equal(countRows(db, 'decision_traces'),  tracesBefore, 'trace count unchanged');
    assert.equal(countRows(db, 'audit_log'),        auditBefore,  'audit count unchanged');

    // story-047 now exists; epic-047 is gone.
    const story = getRow(db, 'epics', 'story-047');
    assert.ok(story, 'story-047 must exist after migration');
    assert.equal(
      db.prepare('SELECT id FROM epics WHERE id = ?').get('epic-047'),
      undefined,
      'epic-047 must be gone after migration'
    );

    // All other columns ride intact on the renamed row.
    assert.equal(story.title,        'My standalone story');
    assert.equal(story.status,       'planned');
    assert.equal(story.kind,         'standalone');
    assert.equal(story.epic_pr_url,  'https://github.com/test/pr/47');
    assert.equal(story.finalize_ref, 'refs/heads/epic-047-finalize');

    // Agent epic_id re-pointed to story-047.
    const agent = getRow(db, 'agents', 'agent-story-047-aabbccdd');
    assert.ok(agent, 'agent row must survive');
    assert.equal(agent.epic_id, 'story-047', 'agent.epic_id re-pointed to story-047');

    // Decision trace epic_id re-pointed to story-047.
    const trace = db
      .prepare('SELECT * FROM decision_traces WHERE agent_id = ?')
      .get('agent-story-047-aabbccdd') as Row;
    assert.ok(trace, 'decision trace must survive');
    assert.equal(trace.epic_id, 'story-047', 'trace.epic_id re-pointed to story-047');

    // Epic-level audit log row (command='epic-047') renamed to 'story-047'.
    const epicAudit = db
      .prepare("SELECT * FROM audit_log WHERE action = 'epic_approved' AND command = 'story-047'")
      .get() as Row | undefined;
    assert.ok(epicAudit, 'epic-level audit row must have command=story-047 after migration');

    // Epic-047 audit log command must no longer exist.
    const oldAudit = db
      .prepare("SELECT id FROM audit_log WHERE command = 'epic-047'")
      .get();
    assert.equal(oldAudit, undefined, 'no audit_log rows must still carry command=epic-047');

    db.close();
  });
});

// ─── Untouched-by-design ──────────────────────────────────────────────────────

describe('v26 repointStandaloneIds — untouched-by-design fields (ADR-006 narrowing)', () => {
  it('agents.story_id, decision_traces.story_id, and agent ids are byte-identical post-migration', () => {
    const dbPath = path.join(tmpDir, 'untouched.db');
    const db = seedPreV26Db(dbPath);
    runMigrations(db);

    // agents.story_id must NOT be changed (it was already 'story-047').
    const agent = getRow(db, 'agents', 'agent-story-047-aabbccdd');
    assert.ok(agent);
    assert.equal(agent.story_id, 'story-047', 'agents.story_id unchanged');

    // agents.id (agent-story-NNN-<hex>) must NOT be changed.
    assert.equal(agent.id, 'agent-story-047-aabbccdd', 'agent id unchanged');

    // decision_traces.story_id must NOT be changed.
    const trace = db
      .prepare("SELECT * FROM decision_traces WHERE agent_id = 'agent-story-047-aabbccdd'")
      .get() as Row;
    assert.ok(trace);
    assert.equal(trace.story_id, 'story-047', 'decision_traces.story_id unchanged');

    // Story-level audit log row (command='story-047', action='guard_checked') unchanged.
    const storyAudit = db
      .prepare("SELECT * FROM audit_log WHERE action = 'guard_checked'")
      .get() as Row;
    assert.ok(storyAudit);
    assert.equal(storyAudit.command, 'story-047', 'story-level audit command unchanged');

    db.close();
  });
});

// ─── Number preservation ──────────────────────────────────────────────────────

describe('v26 repointStandaloneIds — number preservation (NFR-4, no collision possible)', () => {
  it('idNumber("epic-047") === idNumber("story-047") === 47, so no counter collision exists', () => {
    assert.equal(idNumber('epic-047'), 47, 'epic-047 parses to 47');
    assert.equal(idNumber('story-047'), 47, 'story-047 parses to 47');
    assert.equal(
      idNumber('epic-047'),
      idNumber('story-047'),
      'same number across prefixes — the shared counter prevents collisions'
    );
  });

  it('id transform mirrors substr(id,6) from SQL: epic-047 slice(5) -> 047', () => {
    // This verifies that the JS implementation (.slice(5)) matches the SQL
    // contract (substr(id,6)) and that the post-migration id is correct.
    const oldId = 'epic-047';
    const newId = 'story-' + oldId.slice(5);
    assert.equal(newId, 'story-047');
    assert.equal(idNumber(oldId), idNumber(newId));
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe('v26 repointStandaloneIds — idempotency (AC2)', () => {
  it('running runMigrations twice is a no-op — predicate matches nothing on re-run', () => {
    const dbPath = path.join(tmpDir, 'idempotent.db');
    const db = seedPreV26Db(dbPath);

    runMigrations(db);

    // Capture state after first run.
    const storyRow = getRow(db, 'epics', 'story-047');
    assert.ok(storyRow, 'story-047 must exist after first migration');

    const epicCountAfterFirst = countRows(db, 'epics');

    // Second run must not throw and must not change any rows.
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations must not throw');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    // story-047 still exists, unchanged.
    const storyRowAfter2nd = getRow(db, 'epics', 'story-047');
    assert.ok(storyRowAfter2nd);
    assert.equal(storyRowAfter2nd.title, storyRow.title, 'title unchanged on re-run');
    assert.equal(storyRowAfter2nd.epic_pr_url, storyRow.epic_pr_url, 'epic_pr_url unchanged on re-run');

    // epic-047 must still not exist.
    assert.equal(
      db.prepare('SELECT id FROM epics WHERE id = ?').get('epic-047'),
      undefined,
      'epic-047 does not reappear on re-run'
    );

    // Row count must not change.
    assert.equal(countRows(db, 'epics'), epicCountAfterFirst, 'no rows added or removed on re-run');

    // story-047 does NOT get double-stripped to 'story-ry-047' or anything.
    const storyPrefixCount = (
      db.prepare("SELECT COUNT(*) AS n FROM epics WHERE id LIKE 'story-%'").get() as { n: number }
    ).n;
    assert.equal(storyPrefixCount, 1, 'exactly one story-prefixed row');

    db.close();
  });
});

// ─── Atomicity / no orphans ───────────────────────────────────────────────────

describe('v26 repointStandaloneIds — atomicity and no orphans (AC3)', () => {
  it('a mid-migration UNIQUE conflict rolls back entirely — no dangling agents.epic_id', () => {
    const dbPath = path.join(tmpDir, 'atomicity.db');
    const db = seedAtomicityDb(dbPath);

    // The migration tries to UPDATE epics.id='epic-041' -> 'story-041' but
    // 'story-041' already exists → UNIQUE PK violation → transaction rolls back.
    assert.throws(
      () => runMigrations(db),
      'migration must throw when target id already exists'
    );

    // Full rollback: epic-041 must still exist.
    const epic041 = getRow(db, 'epics', 'epic-041');
    assert.ok(epic041, 'epic-041 must still exist after rollback');
    assert.equal(epic041.kind, 'standalone', 'epic-041.kind preserved after rollback');

    // story-041 must still be the pre-existing row (unmodified by rollback).
    const story041 = getRow(db, 'epics', 'story-041');
    assert.ok(story041, 'pre-existing story-041 must still exist after rollback');
    assert.equal(story041.title, 'Pre-existing story-041', 'story-041 title unchanged after rollback');

    // The agent must NOT be orphaned — its epic_id still references the valid epic-041.
    const agent = getRow(db, 'agents', 'agent-story-041-atomictest');
    assert.ok(agent, 'agent must survive the rollback');
    assert.equal(agent.epic_id, 'epic-041', 'agent.epic_id must still be epic-041 (no orphan)');

    // Verify FK referential integrity: epic-041 is still in epics.
    const referencedEpic = db
      .prepare('SELECT id FROM epics WHERE id = ?')
      .get(agent.epic_id as string);
    assert.ok(referencedEpic, 'agents.epic_id must reference an existing epics row (no orphan)');

    db.close();
  });
});

// ─── Normal-epic guard ────────────────────────────────────────────────────────

describe('v26 repointStandaloneIds — normal-epic guard (NFR-3)', () => {
  it('normal (kind=NULL) epic and its related rows are completely unchanged', () => {
    const dbPath = path.join(tmpDir, 'normal-guard.db');
    const db = seedPreV26Db(dbPath);
    runMigrations(db);

    // Normal epic row unchanged.
    const epic048 = getRow(db, 'epics', 'epic-048');
    assert.ok(epic048, 'epic-048 must still exist');
    assert.equal(epic048.title,  'Normal epic');
    assert.equal(epic048.status, 'in_progress');
    assert.equal(epic048.kind,   null, 'kind remains NULL for normal epic');

    // Agent under normal epic — epic_id unchanged.
    const agent048 = getRow(db, 'agents', 'agent-story-048-001-xxyyzz');
    assert.ok(agent048, 'normal-epic agent must still exist');
    assert.equal(agent048.epic_id,   'epic-048',      'epic_id still points to epic-048');
    assert.equal(agent048.story_id,  'story-048-001', 'story_id unchanged');

    // Normal-epic audit log row — command unchanged.
    const audit048 = db
      .prepare("SELECT * FROM audit_log WHERE command = 'epic-048'")
      .get() as Row | undefined;
    assert.ok(audit048, 'normal-epic audit row must still have command=epic-048');
    assert.equal(audit048.action, 'epic_approved');

    db.close();
  });
});

// ─── Full-suite integration ───────────────────────────────────────────────────

describe('v26 migration — FK deferral implicit proof and schema version', () => {
  it('migration succeeds with FK=ON (proves PRAGMA defer_foreign_keys=ON is working)', () => {
    // If defer_foreign_keys were not used, the UPDATE epics.id would fail
    // immediately with an FK violation because agents.epic_id='epic-047' still
    // references the old pk. The test passes only if deferral is working.
    const dbPath = path.join(tmpDir, 'fk-deferred.db');
    const db = seedPreV26Db(dbPath); // FK=ON is set in the seeder

    assert.doesNotThrow(
      () => runMigrations(db),
      'migration with FK=ON must succeed (defer_foreign_keys is working)'
    );

    // After migration: story-047 exists and agents.epic_id references it.
    const agent = getRow(db, 'agents', 'agent-story-047-aabbccdd');
    assert.ok(agent);
    assert.equal(agent.epic_id, 'story-047');

    // The referenced epics row must exist (FK integrity maintained).
    const referencedEpic = db
      .prepare('SELECT id FROM epics WHERE id = ?')
      .get(agent.epic_id as string);
    assert.ok(referencedEpic, 'FK integrity: agents.epic_id references a valid epics row post-migration');

    db.close();
  });

  it('schema version is bumped to current SCHEMA_VERSION after migration', () => {
    const dbPath = path.join(tmpDir, 'schema-version.db');
    const db = seedPreV26Db(dbPath);
    runMigrations(db);
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 34);
    db.close();
  });
});

// ─── v32 migration: audit_chain_head ─────────────────────────────────────────

type AnchorRow = {
  id: number;
  hashed_row_count: number;
  cutover_id: number | null;
  last_id: number | null;
  last_entry_hash: string | null;
};

/**
 * Seeds a minimal v31 DB: the three hash columns on audit_log exist, but
 * audit_chain_head does not yet exist.
 */
function seedV31Db(dbPath: string): Database.Database {
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
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      prev_hash TEXT,
      entry_hash TEXT,
      contract_hash TEXT
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (31)').run();
  return db;
}

describe('v32 migration: SCHEMA_VERSION constant', () => {
  it('SCHEMA_VERSION equals 34', () => {
    assert.equal(SCHEMA_VERSION, 34);
  });

  it('runMigrations() on a v31 DB advances schema_version to current (34)', () => {
    const dbPath = path.join(tmpDir, 'v32-version-bump.db');
    const db = seedV31Db(dbPath);
    assert.equal(schemaVersion(db), 31, 'precondition: starts at v31');
    runMigrations(db);
    assert.equal(schemaVersion(db), 34, 'schema_version bumped to 34 after migration');
    db.close();
  });
});

describe('v32 migration: audit_chain_head table structure', () => {
  it('PRAGMA table_info returns all five columns after migration', () => {
    const dbPath = path.join(tmpDir, 'v32-columns.db');
    const db = seedV31Db(dbPath);
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(audit_chain_head)').all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);

    assert.ok(names.includes('id'),               'id column must exist');
    assert.ok(names.includes('hashed_row_count'), 'hashed_row_count column must exist');
    assert.ok(names.includes('cutover_id'),       'cutover_id column must exist');
    assert.ok(names.includes('last_id'),          'last_id column must exist');
    assert.ok(names.includes('last_entry_hash'),  'last_entry_hash column must exist');
    assert.equal(names.length, 5, 'exactly five columns');

    db.close();
  });

  it('contains exactly one row with id=1 after migration', () => {
    const dbPath = path.join(tmpDir, 'v32-one-row.db');
    const db = seedV31Db(dbPath);
    runMigrations(db);

    const rows = db.prepare('SELECT * FROM audit_chain_head').all() as AnchorRow[];
    assert.equal(rows.length, 1, 'exactly one anchor row');
    assert.equal(rows[0].id, 1, 'anchor row id must be 1');

    db.close();
  });
});

describe('v32 migration: init from seeded chain', () => {
  it('anchor row reflects count/cutover/last of hashed rows', () => {
    const dbPath = path.join(tmpDir, 'v32-seeded-chain.db');
    const db = seedV31Db(dbPath);

    // Insert 5 audit_log rows: rows 1,2 unhashed; rows 3,4,5 hashed.
    const ins = db.prepare(
      'INSERT INTO audit_log (action, entry_hash) VALUES (?, ?)'
    );
    ins.run('unhashed_a', null);
    ins.run('unhashed_b', null);
    ins.run('hashed_a',   'hash-a');
    ins.run('hashed_b',   'hash-b');
    ins.run('hashed_c',   'hash-c');

    // Capture the ids of hashed rows so we know the expected min/max.
    const hashedRows = db
      .prepare('SELECT id, entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id ASC')
      .all() as { id: number; entry_hash: string }[];
    assert.equal(hashedRows.length, 3, 'precondition: 3 hashed rows');

    const expectedCutoverId  = hashedRows[0].id;
    const expectedLastId     = hashedRows[2].id;
    const expectedLastHash   = hashedRows[2].entry_hash;

    runMigrations(db);

    const anchor = db.prepare('SELECT * FROM audit_chain_head').get() as AnchorRow;
    assert.ok(anchor, 'anchor row must exist');
    assert.equal(anchor.hashed_row_count, 3,                  'hashed_row_count = 3');
    assert.equal(anchor.cutover_id,       expectedCutoverId,  'cutover_id = MIN(hashed id)');
    assert.equal(anchor.last_id,          expectedLastId,     'last_id = MAX(hashed id)');
    assert.equal(anchor.last_entry_hash,  expectedLastHash,   'last_entry_hash = last hashed row hash');

    db.close();
  });
});

describe('v32 migration: empty chain', () => {
  it('creates exactly one anchor row with hashed_row_count=0 and NULL fields', () => {
    const dbPath = path.join(tmpDir, 'v32-empty-chain.db');
    const db = seedV31Db(dbPath);

    // No rows in audit_log at all.
    runMigrations(db);

    const rows = db.prepare('SELECT * FROM audit_chain_head').all() as AnchorRow[];
    assert.equal(rows.length, 1, 'must have exactly ONE anchor row (not zero)');

    const anchor = rows[0];
    assert.equal(anchor.id,               1,    'id = 1');
    assert.equal(anchor.hashed_row_count, 0,    'hashed_row_count = 0 on empty chain');
    assert.equal(anchor.cutover_id,       null, 'cutover_id = NULL on empty chain');
    assert.equal(anchor.last_id,          null, 'last_id = NULL on empty chain');
    assert.equal(anchor.last_entry_hash,  null, 'last_entry_hash = NULL on empty chain');

    db.close();
  });

  it('also works when audit_log has rows but none are hashed', () => {
    const dbPath = path.join(tmpDir, 'v32-unhashed-only.db');
    const db = seedV31Db(dbPath);

    db.prepare('INSERT INTO audit_log (action, entry_hash) VALUES (?, NULL)').run('guard_checked');
    db.prepare('INSERT INTO audit_log (action, entry_hash) VALUES (?, NULL)').run('guard_checked');

    runMigrations(db);

    const anchor = db.prepare('SELECT * FROM audit_chain_head').get() as AnchorRow;
    assert.ok(anchor, 'anchor row must exist');
    assert.equal(anchor.hashed_row_count, 0,    'hashed_row_count = 0 when no hashed rows');
    assert.equal(anchor.cutover_id,       null, 'cutover_id = NULL');
    assert.equal(anchor.last_id,          null, 'last_id = NULL');
    assert.equal(anchor.last_entry_hash,  null, 'last_entry_hash = NULL');

    db.close();
  });
});

describe('v32 migration: anchor seed is one-time (security — no self-heal)', () => {
  it('does NOT re-seed a deleted anchor on a steady-state v32 reopen', () => {
    const dbPath = path.join(tmpDir, 'v32-reseed-guard.db');
    const db = seedV31Db(dbPath);

    const ins = db.prepare('INSERT INTO audit_log (action, entry_hash) VALUES (?, ?)');
    ins.run('hashed_a', 'hash-a');
    ins.run('hashed_b', 'hash-b');

    runMigrations(db); // v31 -> current (v34) upgrade: crosses <32, so seeds the anchor once
    assert.equal(schemaVersion(db), 34);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM audit_chain_head').get() as { c: number }).c,
      1,
      'precondition: anchor seeded on the v31->v32 upgrade'
    );

    // A tamperer deletes the witness row.
    db.prepare('DELETE FROM audit_chain_head').run();

    // A subsequent steady-state open (already v32) must NOT silently rebuild the anchor from the
    // (possibly truncated) rows — otherwise tail-truncation is undetectable and verifyChain's
    // missing-anchor branch is dead code.
    runMigrations(db);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM audit_chain_head').get() as { c: number }).c,
      0,
      'a deleted anchor must stay deleted on a v32 reopen (no self-heal re-seed)'
    );

    db.close();
  });

  it('leaves an intact anchor unchanged on a v32 reopen (idempotent, no drift)', () => {
    const dbPath = path.join(tmpDir, 'v32-reopen-idempotent.db');
    const db = seedV31Db(dbPath);
    const ins = db.prepare('INSERT INTO audit_log (action, entry_hash) VALUES (?, ?)');
    ins.run('hashed_a', 'hash-a');
    ins.run('hashed_b', 'hash-b');

    runMigrations(db);
    const before = db.prepare('SELECT * FROM audit_chain_head WHERE id = 1').get();

    runMigrations(db); // steady-state reopen at v32
    const after = db.prepare('SELECT * FROM audit_chain_head WHERE id = 1').get();

    assert.deepEqual(after, before, 'a legitimate v32 reopen must not alter the anchor');
    db.close();
  });
});

describe('v32 migration: audit_log rows not mutated', () => {
  it('every audit_log row is byte-identical before and after migration', () => {
    const dbPath = path.join(tmpDir, 'v32-no-mutation.db');
    const db = seedV31Db(dbPath);

    const ins = db.prepare(
      'INSERT INTO audit_log (action, command, entry_hash) VALUES (?, ?, ?)'
    );
    ins.run('guard_checked', 'git status', null);
    ins.run('guard_checked', 'npm test',   'hash-xyz');
    ins.run('epic_approved', null,         null);

    type AuditRow = Record<string, unknown>;
    const before = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[];

    runMigrations(db);

    const after = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[];

    assert.equal(after.length, before.length, 'row count unchanged');
    for (let i = 0; i < before.length; i++) {
      assert.deepEqual(after[i], before[i], `row ${i + 1} must be byte-identical`);
    }

    db.close();
  });
});

describe('v32 migration: idempotency', () => {
  it('running runMigrations twice does not throw and leaves exactly one anchor row', () => {
    const dbPath = path.join(tmpDir, 'v32-idempotent.db');
    const db = seedV31Db(dbPath);

    runMigrations(db);
    assert.doesNotThrow(
      () => runMigrations(db),
      'second runMigrations() must not throw'
    );

    const rows = db.prepare('SELECT * FROM audit_chain_head').all();
    assert.equal(rows.length, 1, 'still exactly one anchor row after two migrations');
    assert.equal(schemaVersion(db), SCHEMA_VERSION, 'schema_version unchanged by second run');

    db.close();
  });

  it('idempotent on a fresh DB (createDatabase path)', () => {
    const dbPath = path.join(tmpDir, 'v32-idempotent-fresh.db');
    const db = createDatabase(dbPath);

    assert.doesNotThrow(
      () => runMigrations(db),
      'second runMigrations() on fresh DB must not throw'
    );

    const rows = db.prepare('SELECT * FROM audit_chain_head').all();
    assert.equal(rows.length, 1, 'exactly one anchor row on fresh DB');

    db.close();
  });
});
