/**
 * Schema migration tests for v22 — agents.log_bytes (story-019-001).
 *
 * Follows the same pattern as DatabaseMigrationV20.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, SCHEMA_VERSION } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';
import type { AgentRecord } from '../types.js';

/**
 * Builds an in-memory database mirroring the v21 schema (without log_bytes).
 * FK enforcement is left off during setup so we can insert rows without
 * all the referenced tables being fully initialised; runMigrations re-enables.
 */
function buildV21Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (21);

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
      planning_log_tail TEXT
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
      model TEXT
    );
  `);
  return db;
}

describe('DatabaseMigrationV22 — agents.log_bytes (story-019-001)', () => {
  it('[AC1] agents table has a log_bytes INTEGER column after migration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
      type: string;
    }[];
    const col = cols.find((c) => c.name === 'log_bytes');
    assert.ok(col, 'agents.log_bytes column must exist after migration');
    assert.equal(col.type, 'INTEGER', 'agents.log_bytes type must be INTEGER');
  });

  it('[AC2] SCHEMA_VERSION is current after migration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const row = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(row.version, SCHEMA_VERSION);
  });

  it('[AC3] migrates a v21 DB with seeded agent rows — no error, version = 22', () => {
    const db = buildV21Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved');
      INSERT INTO agents (id, epic_id, story_id, status, log_tail)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'done', 'some tail');
    `);

    const preCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name
    );
    assert.ok(!preCols.includes('log_bytes'), 'log_bytes must NOT exist before migration');

    assert.doesNotThrow(() => runMigrations(db), 'runMigrations() must not throw on a v21 DB');

    const ver = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    };
    assert.equal(ver.version, SCHEMA_VERSION, `schema_version must be bumped to ${SCHEMA_VERSION}`);
  });

  it('[AC4] pre-existing agent rows read back log_bytes = NULL with no error', () => {
    const db = buildV21Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved');
      INSERT INTO agents (id, epic_id, story_id, status)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'done');
      INSERT INTO agents (id, epic_id, story_id, status)
      VALUES ('agent-002', 'epic-001', 'story-001-002', 'failed');
    `);

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, log_bytes FROM agents')
      .all() as { id: string; log_bytes: number | null }[];
    assert.equal(rows.length, 2, 'pre-existing rows must be preserved');
    for (const row of rows) {
      assert.equal(
        row.log_bytes,
        null,
        `agent ${row.id}: log_bytes must be NULL — never backfilled`
      );
    }
  });

  it('[AC5] runMigrations() is idempotent — no duplicate columns on second call', () => {
    const db = buildV21Database();
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');

    const logBytesCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).filter(
      (c) => c.name === 'log_bytes'
    );
    assert.equal(logBytesCols.length, 1, 'exactly one log_bytes column — no duplicate');
  });

  it('[AC6] pre-existing non-log columns are unchanged after migration', () => {
    const db = buildV21Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved');
      INSERT INTO agents (id, epic_id, story_id, story_title, status, log_tail,
                          tokens_input, cost_usd, model)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'Story 1', 'done', 'tail text',
              1000, 0.05, 'claude-sonnet-4-6');
    `);

    const before = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-001') as Record<
      string,
      unknown
    >;
    runMigrations(db);
    const after = db.prepare('SELECT * FROM agents WHERE id = ?').get('agent-001') as Record<
      string,
      unknown
    >;

    for (const key of Object.keys(before)) {
      assert.equal(after[key], before[key], `column '${key}' must be unchanged`);
    }
    assert.equal(after['log_bytes'], null, 'new log_bytes column is NULL for old rows');
  });

  it('[type] AgentRecord declares log_bytes: number | null (compile-time contract)', () => {
    const record: AgentRecord = {
      id: 'agent-x',
      epic_id: 'epic-001',
      story_id: 'story-001-001',
      story_title: null,
      status: 'done',
      worktree_path: null,
      branch_name: null,
      pr_url: null,
      log_tail: null,
      started_at: null,
      updated_at: '2026-01-01T00:00:00Z',
      worker_pid: null,
      review_status: null,
      review_summary: null,
      tokens_input: null,
      tokens_output: null,
      tokens_cached: null,
      tokens_cache_creation: null,
      cost_usd: null,
      request_count: null,
      attempt_class: null,
      model: null,
      log_bytes: null,
      revise_round: 0,
    };
    assert.equal(record.log_bytes, null);

    const withBytes: AgentRecord = { ...record, log_bytes: 12345 };
    assert.equal(withBytes.log_bytes, 12345);
  });

  it('[store] AgentStore.updateLogTail persists logBytes to agents.log_bytes', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    new EpicStore(db).create('epic-001', 'Test Epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-001', 'story-001-001', 'Test Story');

    assert.equal(agentStore.get(agent.id)?.log_bytes, null, 'initially null');

    agentStore.updateLogTail(agent.id, 'some tail text', 1024);
    const updated = agentStore.get(agent.id)!;
    assert.equal(updated.log_tail, 'some tail text');
    assert.equal(updated.log_bytes, 1024);

    agentStore.updateLogTail(agent.id, 'longer tail', 2048);
    const updated2 = agentStore.get(agent.id)!;
    assert.equal(updated2.log_bytes, 2048, 'log_bytes is updated on each flush');
  });
});
