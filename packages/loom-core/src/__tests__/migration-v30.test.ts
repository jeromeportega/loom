/**
 * Schema migration tests for v30 — agents.revise_round + review_findings table
 * (epic-076 story-076-001).
 *
 * Follows the same pattern as DatabaseMigrationV23.test.ts.
 * Integration against real better-sqlite3 (no mocks).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, SCHEMA_VERSION } from '../state/Database.js';

/**
 * Builds an in-memory database mirroring the v29 schema:
 * - agents table without revise_round
 * - no review_findings table
 * FK enforcement is off during setup so rows can be inserted without
 * full table initialisation; runMigrations re-enables via PRAGMA.
 */
function buildV29Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (29);

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
      model TEXT, log_bytes INTEGER
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

describe('DatabaseMigrationV30 — agents.revise_round + review_findings (story-076-001)', () => {
  it('[AC1-happy] fresh DB: review_findings table exists with all required columns and indexes, agents has revise_round defaulting to 0', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    // Check schema_version
    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, SCHEMA_VERSION, 'schema_version must equal SCHEMA_VERSION constant');
    assert.equal(SCHEMA_VERSION, 30, 'SCHEMA_VERSION constant must be 30');

    // Check review_findings columns
    const rfCols = db.prepare('PRAGMA table_info(review_findings)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }[];
    const rfColNames = rfCols.map((c) => c.name);

    assert.ok(rfColNames.includes('id'), 'review_findings.id must exist');
    assert.ok(rfColNames.includes('agent_id'), 'review_findings.agent_id must exist');
    assert.ok(rfColNames.includes('story_id'), 'review_findings.story_id must exist');
    assert.ok(rfColNames.includes('severity'), 'review_findings.severity must exist');
    assert.ok(rfColNames.includes('file'), 'review_findings.file must exist');
    assert.ok(rfColNames.includes('line'), 'review_findings.line must exist');
    assert.ok(rfColNames.includes('message'), 'review_findings.message must exist');
    assert.ok(rfColNames.includes('suggestion'), 'review_findings.suggestion must exist');
    assert.ok(rfColNames.includes('recorded_at'), 'review_findings.recorded_at must exist');

    // line and suggestion must be nullable
    const lineCol = rfCols.find((c) => c.name === 'line')!;
    assert.equal(lineCol.notnull, 0, 'review_findings.line must be nullable');
    const suggCol = rfCols.find((c) => c.name === 'suggestion')!;
    assert.equal(suggCol.notnull, 0, 'review_findings.suggestion must be nullable');

    // Check indexes exist
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_findings'")
      .all() as { name: string }[];
    const indexNames = indexes.map((i) => i.name);
    assert.ok(
      indexNames.includes('idx_review_findings_agent'),
      'idx_review_findings_agent must exist',
    );
    assert.ok(
      indexNames.includes('idx_review_findings_story'),
      'idx_review_findings_story must exist',
    );

    // Check agents.revise_round column exists and defaults to 0
    const agentCols = db.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const reviseCol = agentCols.find((c) => c.name === 'revise_round');
    assert.ok(reviseCol, 'agents.revise_round column must exist');
    assert.equal(reviseCol.type, 'INTEGER', 'revise_round type must be INTEGER');
    assert.equal(reviseCol.notnull, 1, 'revise_round must be NOT NULL');
    assert.equal(reviseCol.dflt_value, '0', 'revise_round DEFAULT must be 0');
  });

  it('[AC2-preservation] pre-existing rows survive migration with correct values', () => {
    const db = buildV29Database();
    // Seed agents with FK enforcement off
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Existing Epic', 'approved');
      INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
        VALUES ('agent-story-001-001-aaaa', 'epic-001', 'story-001-001', 'My Story', 'done', '2025-01-01T00:00:00.000Z');
      INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
        VALUES ('agent-story-001-002-bbbb', 'epic-001', 'story-001-002', 'Another Story', 'pending', '2025-01-02T00:00:00.000Z');
    `);

    assert.doesNotThrow(() => runMigrations(db), 'runMigrations() must not throw on a v29 DB');

    const agents = db.prepare('SELECT * FROM agents ORDER BY id').all() as {
      id: string;
      story_id: string;
      story_title: string;
      status: string;
      revise_round: number;
    }[];

    assert.equal(agents.length, 2, 'both pre-existing agent rows must survive');
    assert.equal(agents[0].id, 'agent-story-001-001-aaaa');
    assert.equal(agents[0].story_title, 'My Story');
    assert.equal(agents[0].status, 'done');
    assert.equal(agents[0].revise_round, 0, 'pre-existing agents must have revise_round=0 (DEFAULT)');
    assert.equal(agents[1].id, 'agent-story-001-002-bbbb');
    assert.equal(agents[1].story_id, 'story-001-002');
    assert.equal(agents[1].revise_round, 0, 'pre-existing agents must have revise_round=0 (DEFAULT)');

    // Epics also survive
    const epics = db.prepare('SELECT * FROM epics').all() as { id: string; title: string }[];
    assert.equal(epics.length, 1, 'pre-existing epic row must survive');
    assert.equal(epics[0].title, 'Existing Epic');
  });

  it('[AC3-idempotency] running runMigrations() twice does not throw and schema_version stays 30', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, 30, 'schema_version must remain 30 after second run');

    // Exactly one revise_round column — no duplicate
    const revCols = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).filter((c) => c.name === 'revise_round');
    assert.equal(revCols.length, 1, 'exactly one revise_round column — no duplicate');

    // review_findings table exists exactly once
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_findings'")
      .all() as { name: string }[];
    assert.equal(tables.length, 1, 'review_findings table appears exactly once');
  });

  it('[AC4-alter-guard] running migration against a DB where revise_round already exists does not throw', () => {
    const db = buildV29Database();
    // First migration run adds revise_round
    runMigrations(db);
    // Verify it was added
    const colsAfterFirst = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).map((c) => c.name);
    assert.ok(colsAfterFirst.includes('revise_round'), 'revise_round must exist after first run');

    // Second run must not throw (column already exists — guard must catch the duplicate)
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() with existing revise_round must not throw');

    // Still exactly one column
    const colsAfterSecond = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).filter((c) => c.name === 'revise_round');
    assert.equal(colsAfterSecond.length, 1, 'still exactly one revise_round column after second run');
  });

  it('[AC5-sentinel] schema_version is 30 after migration', () => {
    const db = buildV29Database();
    runMigrations(db);

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, 30, 'schema_version must be 30 after migration from v29');
  });
});
