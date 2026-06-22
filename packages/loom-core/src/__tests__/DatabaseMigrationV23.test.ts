/**
 * Schema migration tests for v23 — epics.intake_verdict (story-020-003).
 *
 * Follows the same pattern as DatabaseMigrationV22.test.ts.
 * Integration against real better-sqlite3 (no mocks).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, SCHEMA_VERSION } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { INTAKE_AUDIT_ACTION, type IntakeVerdict } from '../intake/IntakeClassifier.js';

/**
 * Builds an in-memory database mirroring the v22 schema (without intake_verdict).
 * FK enforcement is off during setup so rows can be inserted without full
 * table initialisation; runMigrations re-enables via PRAGMA.
 */
function buildV22Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (22);

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
  `);
  return db;
}

const VALID_VERDICT: IntakeVerdict = {
  type: 'feature',
  size: 'story',
  confidence: 'high',
  rationale: 'A clear new capability request with well-defined acceptance criteria.',
};

describe('DatabaseMigrationV23 — epics.intake_verdict (story-020-003)', () => {
  it('[AC1] fresh db ends at schema_version 23 with epics.intake_verdict TEXT column', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, SCHEMA_VERSION, 'matches exported SCHEMA_VERSION constant');
    assert.equal(ver.version, 24, 'schema_version must be 24');

    const cols = db.prepare('PRAGMA table_info(epics)').all() as {
      name: string;
      type: string;
    }[];
    const col = cols.find((c) => c.name === 'intake_verdict');
    assert.ok(col, 'epics.intake_verdict column must exist after migration');
    assert.equal(col.type, 'TEXT', 'epics.intake_verdict type must be TEXT');
  });

  it('[AC2] migrates a v22 DB with seeded epic rows — no error, version = 23', () => {
    const db = buildV22Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Old Epic', 'approved');
      INSERT INTO epics (id, title, status) VALUES ('epic-002', 'Another Epic', 'done');
    `);

    const preCols = (db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    assert.ok(!preCols.includes('intake_verdict'), 'intake_verdict must NOT exist before migration');

    assert.doesNotThrow(() => runMigrations(db), 'runMigrations() must not throw on a v22 DB');

    const ver = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    };
    assert.equal(ver.version, 24, 'schema_version must be bumped to 24');
  });

  it('[AC3] pre-existing epic rows survive migration with intake_verdict = NULL — never fabricated', () => {
    const db = buildV22Database();
    db.exec(`
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Old Epic', 'approved');
      INSERT INTO epics (id, title, status, user_brief) VALUES ('epic-002', 'Bug Fix Epic', 'done', 'fix the login bug');
    `);

    runMigrations(db);

    const rows = db
      .prepare('SELECT id, title, status, intake_verdict FROM epics ORDER BY id')
      .all() as { id: string; title: string; status: string; intake_verdict: string | null }[];

    assert.equal(rows.length, 2, 'pre-existing rows must be preserved');
    for (const row of rows) {
      assert.equal(
        row.intake_verdict,
        null,
        `epic ${row.id}: intake_verdict must be NULL — never backfilled`,
      );
    }
    assert.equal(rows[0].title, 'Old Epic', 'existing title must be unchanged');
    assert.equal(rows[1].status, 'done', 'existing status must be unchanged');
  });

  it('[AC4] migration is additive-only — Database.ts source contains no DROP or TRUNCATE', () => {
    // __dirname is dist/__tests__/ at runtime; source is two levels up under src/
    const dbSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/state/Database.ts'),
      'utf8',
    );
    // Scan only the v23 block (lines after "v23:" comment), strip comment lines first
    const v23BlockStart = dbSrc.indexOf('// v23:');
    assert.ok(v23BlockStart !== -1, 'v23 migration comment must exist in Database.ts');
    const v23Block = dbSrc.slice(v23BlockStart, v23BlockStart + 400);
    // Strip single-line comments so we only check executable SQL strings
    const v23NoComments = v23Block.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\bDROP\b/i.test(v23NoComments), 'v23 SQL must not contain DROP');
    assert.ok(!/\bTRUNCATE\b/i.test(v23NoComments), 'v23 SQL must not contain TRUNCATE');
  });

  it('[AC5] runMigrations() is idempotent — no error or duplicate column on second call', () => {
    const db = buildV22Database();
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');

    const verdictCols = (db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]).filter(
      (c) => c.name === 'intake_verdict',
    );
    assert.equal(verdictCols.length, 1, 'exactly one intake_verdict column — no duplicate');
  });

  it('[store] recordIntakeVerdict + getIntakeVerdict round-trip returns equal verdict', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const store = new EpicStore(db);
    store.create('epic-rt', 'Round-trip epic');

    assert.equal(
      store.getIntakeVerdict('epic-rt'),
      null,
      'getIntakeVerdict returns null before any verdict is recorded',
    );

    store.recordIntakeVerdict('epic-rt', VALID_VERDICT);
    const retrieved = store.getIntakeVerdict('epic-rt');
    assert.deepEqual(retrieved, VALID_VERDICT, 'round-trip: retrieved verdict must equal the stored one');
  });

  it('[store] getIntakeVerdict returns null for NULL column (no verdict recorded)', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const store = new EpicStore(db);
    store.create('epic-null', 'No verdict epic');

    assert.equal(store.getIntakeVerdict('epic-null'), null);
  });

  it('[store] getIntakeVerdict returns null for corrupt/garbage JSON — no default class', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const store = new EpicStore(db);
    store.create('epic-corrupt', 'Corrupt verdict epic');

    // Directly inject garbage JSON bypassing EpicStore methods
    db.prepare('UPDATE epics SET intake_verdict = ? WHERE id = ?').run(
      '{not valid json !!!',
      'epic-corrupt',
    );
    assert.equal(
      store.getIntakeVerdict('epic-corrupt'),
      null,
      'corrupt JSON must degrade to null, never a default class',
    );

    // Valid JSON but wrong shape
    db.prepare('UPDATE epics SET intake_verdict = ? WHERE id = ?').run(
      JSON.stringify({ type: 'UNKNOWN', size: 'galaxy', confidence: 'maybe', rationale: 'x' }),
      'epic-corrupt',
    );
    assert.equal(
      store.getIntakeVerdict('epic-corrupt'),
      null,
      'invalid-shape JSON must also degrade to null',
    );
  });

  it('[audit] intake_classified success row carries ok:true + verdict; failure row carries ok:false + reason', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const audit = new AuditLog(db);

    // Success row
    audit.record({
      action: INTAKE_AUDIT_ACTION,
      detail: {
        epic_id: 'epic-audit',
        ok: true,
        verdict: VALID_VERDICT,
        model: 'claude-haiku-4-5-20251001',
      },
    });

    // Failure row
    audit.record({
      action: INTAKE_AUDIT_ACTION,
      detail: {
        epic_id: 'epic-audit',
        ok: false,
        reason: 'timeout',
        detail: 'triage call exceeded 20000ms',
      },
    });

    const rows = db
      .prepare(
        `SELECT detail FROM audit_log WHERE action = ? ORDER BY id ASC`,
      )
      .all(INTAKE_AUDIT_ACTION) as { detail: string }[];

    assert.equal(rows.length, 2, 'both audit rows must be present');

    const successDetail = JSON.parse(rows[0].detail) as Record<string, unknown>;
    const failureDetail = JSON.parse(rows[1].detail) as Record<string, unknown>;

    assert.equal(successDetail.ok, true, 'success row must have ok:true');
    assert.ok(successDetail.verdict, 'success row must carry the verdict object');
    assert.deepEqual(
      successDetail.verdict,
      VALID_VERDICT,
      'success row verdict must match what was recorded',
    );

    assert.equal(failureDetail.ok, false, 'failure row must have ok:false');
    assert.equal(failureDetail.reason, 'timeout', 'failure row must carry a reason');
    assert.ok(!('verdict' in failureDetail), 'failure row must NOT carry a verdict');

    // Rows are queryably distinct by ok field
    const successRows = rows.filter((r) => (JSON.parse(r.detail) as { ok: boolean }).ok === true);
    const failureRows = rows.filter((r) => (JSON.parse(r.detail) as { ok: boolean }).ok === false);
    assert.equal(successRows.length, 1, 'exactly one success row');
    assert.equal(failureRows.length, 1, 'exactly one failure row');
  });

  it('[audit] INTAKE_AUDIT_ACTION constant value is "intake_classified"', () => {
    assert.equal(INTAKE_AUDIT_ACTION, 'intake_classified');
  });
});
