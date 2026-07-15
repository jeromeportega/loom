/**
 * Schema migration tests for v31 — agents.provides_output + agents.resplit_count
 * (epic-095 story-095-001).
 *
 * Follows the same pattern as migration-v30.test.ts.
 * Integration against real better-sqlite3 (no mocks).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, SCHEMA_VERSION } from '../state/Database.js';

/**
 * Builds an in-memory database mirroring the v30 schema — agents table without
 * provides_output or resplit_count. FK enforcement is off during setup so rows
 * can be inserted without full table initialisation; runMigrations re-enables
 * via PRAGMA.
 */
function buildV30Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (30);

    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      brief_path TEXT, prd_path TEXT, yaml_path TEXT, reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      planner_tokens_input INTEGER, planner_tokens_output INTEGER,
      planner_tokens_cached INTEGER, planner_ms INTEGER, base_sha TEXT,
      archived_at DATETIME, user_brief TEXT, planning_phase TEXT,
      planner_request_count INTEGER, policy_snapshot TEXT,
      finalize_phase TEXT, epic_pr_url TEXT, error TEXT,
      autonomy_level TEXT NOT NULL DEFAULT 'manual',
      paused_at DATETIME, paused_after_story TEXT, proposed_by TEXT,
      finalize_ref TEXT, publish_note TEXT, planner_model TEXT,
      planning_log_tail TEXT, intake_verdict TEXT, kind TEXT,
      loom_home_status TEXT, loom_home_sha TEXT
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      story_title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      worktree_path TEXT, branch_name TEXT, pr_url TEXT, log_tail TEXT,
      started_at DATETIME,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      worker_pid INTEGER,
      review_status TEXT, review_summary TEXT,
      tokens_input INTEGER, tokens_output INTEGER,
      tokens_cached INTEGER, tokens_cache_creation INTEGER,
      cost_usd REAL, request_count INTEGER, attempt_class TEXT,
      model TEXT, log_bytes INTEGER,
      revise_round INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      action TEXT NOT NULL,
      command TEXT,
      allowed INTEGER,
      policy_rule TEXT,
      detail TEXT,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS audit_log_fts USING fts5(
      command, action, content=audit_log, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN
      INSERT INTO audit_log_fts(rowid, command, action) VALUES (new.id, new.command, new.action);
    END;

    CREATE TABLE IF NOT EXISTS loom_control (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      story_id TEXT NOT NULL,
      outcome TEXT,
      injected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS story_recovery (
      story_id        TEXT PRIMARY KEY,
      recovery_count  INTEGER NOT NULL DEFAULT 0,
      updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe('DatabaseMigrationV31 — agents.provides_output + agents.resplit_count (story-095-001)', () => {
  it('[AC1-happy] fresh DB: provides_output and resplit_count columns exist on agents with correct types and defaults', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, SCHEMA_VERSION, 'schema_version must equal SCHEMA_VERSION constant');
    assert.equal(SCHEMA_VERSION, 31, 'SCHEMA_VERSION constant must be 31');

    const agentCols = db.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const colNames = agentCols.map((c) => c.name);

    // provides_output: nullable TEXT
    assert.ok(colNames.includes('provides_output'), 'agents.provides_output column must exist');
    const providesCol = agentCols.find((c) => c.name === 'provides_output')!;
    assert.equal(providesCol.type, 'TEXT', 'provides_output type must be TEXT');
    assert.equal(providesCol.notnull, 0, 'provides_output must be nullable');

    // resplit_count: NOT NULL INTEGER DEFAULT 0
    assert.ok(colNames.includes('resplit_count'), 'agents.resplit_count column must exist');
    const resplitCol = agentCols.find((c) => c.name === 'resplit_count')!;
    assert.equal(resplitCol.type, 'INTEGER', 'resplit_count type must be INTEGER');
    assert.equal(resplitCol.notnull, 1, 'resplit_count must be NOT NULL');
    assert.equal(resplitCol.dflt_value, '0', 'resplit_count DEFAULT must be 0');
  });

  it('[AC2-backward-compat] pre-existing v30 rows survive migration; resplit_count defaults to 0, provides_output to NULL', () => {
    const db = buildV30Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Existing Epic', 'approved');
      INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
        VALUES ('agent-story-001-001-aaaa', 'epic-001', 'story-001-001', 'My Story', 'done', '2025-01-01T00:00:00.000Z');
      INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
        VALUES ('agent-story-001-002-bbbb', 'epic-001', 'story-001-002', 'Another Story', 'pending', '2025-01-02T00:00:00.000Z');
    `);

    assert.doesNotThrow(() => runMigrations(db), 'runMigrations() must not throw on a v30 DB');

    const agents = db.prepare('SELECT * FROM agents ORDER BY id').all() as {
      id: string;
      story_id: string;
      story_title: string;
      status: string;
      revise_round: number;
      resplit_count: number;
      provides_output: string | null;
    }[];

    assert.equal(agents.length, 2, 'both pre-existing agent rows must survive');
    assert.equal(agents[0].id, 'agent-story-001-001-aaaa');
    assert.equal(agents[0].status, 'done');
    assert.equal(agents[0].resplit_count, 0, 'pre-existing agents must have resplit_count=0 (DEFAULT)');
    assert.equal(agents[0].provides_output, null, 'pre-existing agents must have provides_output=NULL');
    assert.equal(agents[1].resplit_count, 0, 'pre-existing agents must have resplit_count=0 (DEFAULT)');
    assert.equal(agents[1].provides_output, null, 'pre-existing agents must have provides_output=NULL');
  });

  it('[AC3-idempotency] running runMigrations() twice does not throw; schema_version stays 31; no duplicate columns', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, 31, 'schema_version must remain 31 after second run');

    const agentCols = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
    const providesCount = agentCols.filter((c) => c.name === 'provides_output').length;
    const resplitCount = agentCols.filter((c) => c.name === 'resplit_count').length;
    assert.equal(providesCount, 1, 'exactly one provides_output column — no duplicate');
    assert.equal(resplitCount, 1, 'exactly one resplit_count column — no duplicate');
  });

  it('[AC4-alter-guard] running migration on a DB where provides_output and resplit_count already exist does not throw', () => {
    const db = buildV30Database();
    runMigrations(db);

    const colsAfterFirst = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).map((c) => c.name);
    assert.ok(colsAfterFirst.includes('provides_output'), 'provides_output must exist after first run');
    assert.ok(colsAfterFirst.includes('resplit_count'), 'resplit_count must exist after first run');

    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() on already-migrated DB must not throw');
  });

  it('[AC5-insert-new-row] can insert a row with provides_output JSON and explicit resplit_count after migration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    db.exec(`INSERT INTO epics (id, title, status) VALUES ('epic-002', 'Test Epic', 'approved')`);
    assert.doesNotThrow(() => {
      db.exec(`
        INSERT INTO agents
          (id, epic_id, story_id, story_title, status, updated_at, provides_output, resplit_count)
        VALUES
          ('agent-new', 'epic-002', 'story-002-001', 'New Story', 'done',
           '2025-06-01T00:00:00.000Z', '{"jwt_shape":"{ token: string }"}', 1)
      `);
    }, 'inserting a row with provides_output and resplit_count must not throw');

    const row = db.prepare('SELECT provides_output, resplit_count FROM agents WHERE id=?')
      .get('agent-new') as { provides_output: string; resplit_count: number };
    assert.equal(row.provides_output, '{"jwt_shape":"{ token: string }"}');
    assert.equal(row.resplit_count, 1);
  });
});
