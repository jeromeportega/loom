import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations, SCHEMA_VERSION } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';
import type { AgentRecord } from '../types.js';

/**
 * Builds an in-memory database that mirrors the v19 schema — all columns that
 * existed before story-013-001, but without agents.model or epics.planner_model.
 *
 * runMigrations() will be called on this DB in tests to exercise the upgrade path.
 * FK enforcement is left OFF during setup so we can insert agents without a
 * matching epic row in tables not yet present; runMigrations re-enables FK via DDL.
 */
function buildV19Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (19);

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
      finalize_ref TEXT, publish_note TEXT
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
      cost_usd REAL, request_count INTEGER, attempt_class TEXT
    );
  `);
  return db;
}

describe('DatabaseMigrationV20 — agents.model + epics.planner_model (story-013-001)', () => {
  it('[AC1] agents table has a model TEXT column after migration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const cols = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string; type: string }[]
    );
    const modelCol = cols.find((c) => c.name === 'model');
    assert.ok(modelCol, 'agents.model column must exist after migration');
    assert.equal(modelCol.type, 'TEXT', 'agents.model type must be TEXT');
  });

  it('[AC1] epics table has a planner_model TEXT column after migration', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const cols = (
      db.prepare('PRAGMA table_info(epics)').all() as { name: string; type: string }[]
    );
    const plannerModelCol = cols.find((c) => c.name === 'planner_model');
    assert.ok(plannerModelCol, 'epics.planner_model column must exist after migration');
    assert.equal(plannerModelCol.type, 'TEXT', 'epics.planner_model type must be TEXT');
  });

  it('[AC2] migrates a v19 DB with seeded agent rows — no error, schema_version = 20', () => {
    const db = buildV19Database();
    db.exec(`
      INSERT INTO epics (id, title, status)
      VALUES ('epic-001', 'Test Epic', 'approved');

      INSERT INTO agents (id, epic_id, story_id, story_title, status,
                          tokens_input, tokens_output, tokens_cached, tokens_cache_creation, cost_usd)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'Story 1', 'done',
              1000, 500, 200, 100, 0.05);

      INSERT INTO agents (id, epic_id, story_id, story_title, status,
                          tokens_input, tokens_output, tokens_cached, tokens_cache_creation, cost_usd)
      VALUES ('agent-002', 'epic-001', 'story-001-002', 'Story 2', 'done',
              800, 400, 150, 50, 0.03);
    `);

    const preCols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(
      (c) => c.name
    );
    assert.ok(!preCols.includes('model'), 'model must NOT exist before migration');

    assert.doesNotThrow(() => runMigrations(db), 'runMigrations() must not throw on a v19 DB');

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, SCHEMA_VERSION, `schema_version must be bumped to ${SCHEMA_VERSION}`);
  });

  it('[AC2 idempotency] running runMigrations() twice produces no error and no duplicate columns', () => {
    const db = buildV19Database();
    db.exec(`INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved')`);

    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() call must not throw');

    const modelCols = (
      db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]
    ).filter((c) => c.name === 'model');
    assert.equal(modelCols.length, 1, 'exactly one agents.model column — no duplicate');

    const plannerModelCols = (
      db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]
    ).filter((c) => c.name === 'planner_model');
    assert.equal(plannerModelCols.length, 1, 'exactly one epics.planner_model column — no duplicate');
  });

  it('[AC3] every pre-existing agent row has model = NULL after migration — never backfilled', () => {
    const db = buildV19Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved');

      INSERT INTO agents (id, epic_id, story_id, status, tokens_input, cost_usd)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'done', 1000, 0.05);

      INSERT INTO agents (id, epic_id, story_id, status, tokens_input, cost_usd)
      VALUES ('agent-002', 'epic-001', 'story-001-002', 'done', 800, 0.03);

      INSERT INTO agents (id, epic_id, story_id, status)
      VALUES ('agent-003', 'epic-001', 'story-001-003', 'failed');
    `);

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, model FROM agents')
      .all() as { id: string; model: string | null }[];
    assert.equal(rows.length, 3, 'all three pre-existing rows must be preserved');
    for (const row of rows) {
      assert.equal(
        row.model,
        null,
        `agent ${row.id}: model must be NULL — pre-migration rows must never be backfilled`
      );
    }
  });

  it('[AC4] all pre-existing agent columns (especially cost_usd) are unchanged by migration', () => {
    const db = buildV19Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Test Epic', 'approved');

      INSERT INTO agents (id, epic_id, story_id, story_title, status,
                          tokens_input, tokens_output, tokens_cached, tokens_cache_creation,
                          cost_usd, request_count)
      VALUES ('agent-001', 'epic-001', 'story-001-001', 'My Story', 'done',
              1234, 567, 89, 10, 0.0987, 3);
    `);

    const before = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('agent-001') as Record<string, unknown>;
    const rowCountBefore = (
      db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    ).c;

    runMigrations(db);

    const after = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('agent-001') as Record<string, unknown>;
    const rowCountAfter = (
      db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    ).c;

    assert.equal(rowCountAfter, rowCountBefore, 'row count must not change after migration');

    for (const key of Object.keys(before)) {
      assert.equal(
        after[key],
        before[key],
        `column '${key}' must be byte-for-byte unchanged after migration`
      );
    }

    assert.equal(after['model'], null, 'new model column is present and NULL for old rows');
  });

  it('[type] AgentRecord declares model: string | null (compile-time contract)', () => {
    // If AgentRecord omits model, tsc will reject this object literal.
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
      provides_output: null,
      resplit_count: 0,
    };
    assert.equal(record.model, null);

    const withModel: AgentRecord = { ...record, model: 'claude-sonnet-4-6' };
    assert.equal(withModel.model, 'claude-sonnet-4-6');
  });

  it('[store] AgentStore.setModel persists the executed model id', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    new EpicStore(db).create('epic-001', 'Test Epic');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('epic-001', 'story-001-001', 'Test Story');
    assert.equal(agent.model, null, 'freshly created agent starts with null model');

    agentStore.setModel(agent.id, 'claude-sonnet-4-6');
    const updated = agentStore.get(agent.id)!;
    assert.equal(updated.model, 'claude-sonnet-4-6');

    // Overwrite with the executed model (the two-phase write per Supervisor protocol)
    agentStore.setModel(agent.id, 'claude-opus-4-8');
    const overwritten = agentStore.get(agent.id)!;
    assert.equal(overwritten.model, 'claude-opus-4-8', 'setModel overwrites the previous value');
  });

  it('[store] EpicStore.setPlannerModel persists the planning model string', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test Epic');

    const before = epicStore.get('epic-001')!;
    assert.equal(before.planner_model, null, 'freshly created epic starts with null planner_model');

    epicStore.setPlannerModel('epic-001', 'claude-opus-4-7');
    const after = epicStore.get('epic-001')!;
    assert.equal(after.planner_model, 'claude-opus-4-7');
  });
});
