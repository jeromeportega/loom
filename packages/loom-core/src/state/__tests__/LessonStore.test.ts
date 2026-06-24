import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { LessonStore } from '../LessonStore.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function indexExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name);
}

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }
  ).version;
}

/**
 * Builds a full v17 DB: all tables that existed before v18, with NO lessons
 * table. Used to verify the additive upgrade path.
 */
function buildV17Db(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
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
      paused_at DATETIME, paused_after_story TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL REFERENCES epics(id),
      story_id TEXT NOT NULL, story_title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      worktree_path TEXT, branch_name TEXT, pr_url TEXT, log_tail TEXT,
      started_at DATETIME, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      worker_pid INTEGER, review_status TEXT, review_summary TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cached INTEGER,
      tokens_cache_creation INTEGER, cost_usd REAL, request_count INTEGER,
      attempt_class TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id),
      action TEXT NOT NULL, command TEXT, allowed INTEGER,
      policy_rule TEXT, detail TEXT,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE skill_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_name TEXT NOT NULL, agent_id TEXT NOT NULL, story_id TEXT NOT NULL,
      outcome TEXT, injected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE loom_control (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL DEFAULT 'running');
    CREATE TABLE loom_lease (
      epic_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL,
      hostname TEXT, acquired_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      heartbeat_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, suite TEXT NOT NULL,
      score REAL NOT NULL, passed INTEGER NOT NULL, total INTEGER NOT NULL,
      ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS audit_log_fts USING fts5(
      command, action, content=audit_log, content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS audit_log_ai AFTER INSERT ON audit_log BEGIN
      INSERT INTO audit_log_fts(rowid, command, action) VALUES (new.id, new.command, new.action);
    END;
    CREATE TABLE decision_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epic_id TEXT,
      story_id TEXT, kind TEXT NOT NULL, subject TEXT, rationale TEXT NOT NULL,
      metadata TEXT, timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_decision_traces_agent ON decision_traces(agent_id);
    CREATE INDEX IF NOT EXISTS idx_decision_traces_story ON decision_traces(story_id);
    CREATE TABLE signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE, source TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, detail TEXT, evidence_url TEXT,
      weight REAL NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'open',
      first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);
    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, rationale TEXT NOT NULL,
      impact REAL NOT NULL, effort REAL NOT NULL, confidence REAL NOT NULL,
      score REAL NOT NULL, rank INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      signal_count INTEGER NOT NULL DEFAULT 0,
      member_keys TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
      scoped_epic_id TEXT REFERENCES epics(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schema_version (version) VALUES (17);
    INSERT INTO epics (id, title) VALUES ('epic-pre-v18', 'Pre-v18 epic');
  `);
  return db;
}

const FIXED_TIME = '2026-06-12T00:00:00.000Z';

// makeLesson builds a valid Lesson-shaped object. applied_as/applied_ref are
// intentionally excluded from overrides — their types have no undefined
// variant, so including them in Partial would produce a type mismatch.
function makeLesson(overrides: Partial<{
  epic_id: string;
  category: string;
  observation: string;
  general_rule: string;
  root_cause: string;
  evidence: string;
  created_at: string;
}> = {}) {
  return {
    epic_id: 'epic-001',
    category: 'schema-migration',
    observation: 'Additive migrations prevented downtime',
    general_rule: 'Use CREATE TABLE IF NOT EXISTS for additive schema changes',
    created_at: FIXED_TIME,
    applied_as: null as 'worker_guidance' | 'policy_suggestion' | null,
    applied_ref: null as string | null,
    ...overrides,
  };
}

// ─── Schema shape ─────────────────────────────────────────────────────────────

describe('LessonStore — schema shape', () => {
  it('lessons table exists with all required FR-6 columns after init', () => {
    const db = createDatabase(':memory:');
    assert.ok(tableExists(db, 'lessons'), 'lessons table must exist');

    const cols = db.prepare('PRAGMA table_info(lessons)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    for (const expected of [
      'epic_id', 'category', 'observation', 'root_cause',
      'general_rule', 'evidence', 'applied_as', 'applied_ref', 'created_at',
    ]) {
      assert.ok(names.has(expected), `missing column: ${expected}`);
    }
  });

  it('idx_lessons_epic and idx_lessons_category indexes exist', () => {
    const db = createDatabase(':memory:');
    assert.ok(indexExists(db, 'idx_lessons_epic'), 'idx_lessons_epic must exist');
    assert.ok(indexExists(db, 'idx_lessons_category'), 'idx_lessons_category must exist');
  });

  it('SCHEMA_VERSION constant equals 27', () => {
    assert.equal(SCHEMA_VERSION, 27);
  });

  it('fresh DB schema_version row is current SCHEMA_VERSION', () => {
    const db = createDatabase(':memory:');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
  });
});

// ─── Idempotent / additive migration ─────────────────────────────────────────

describe('LessonStore — migration idempotency', () => {
  it('running runMigrations twice does not throw and lessons table appears once', () => {
    const db = createDatabase(':memory:');
    assert.doesNotThrow(() => runMigrations(db));
    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='lessons'")
        .get() as { n: number }
    ).n;
    assert.equal(count, 1, 'lessons table must appear exactly once');
    assert.equal(schemaVersion(db), SCHEMA_VERSION, `schema_version stays at ${SCHEMA_VERSION}`);
  });
});

// ─── Pre-v18 upgrade ──────────────────────────────────────────────────────────

describe('LessonStore — pre-v18 upgrade', () => {
  it('opens a v17 DB and auto-creates lessons table transparently', () => {
    const db = buildV17Db();

    assert.ok(!tableExists(db, 'lessons'), 'v17 DB must not have lessons table');
    assert.equal(schemaVersion(db), 17);

    runMigrations(db);

    assert.ok(tableExists(db, 'lessons'), 'lessons table must be created by migration');
    assert.ok(indexExists(db, 'idx_lessons_epic'));
    assert.ok(indexExists(db, 'idx_lessons_category'));
    assert.equal(schemaVersion(db), SCHEMA_VERSION, `version bumped to ${SCHEMA_VERSION}`);

    // Pre-existing data survived intact
    const epic = db
      .prepare("SELECT id, title FROM epics WHERE id = 'epic-pre-v18'")
      .get() as { id: string; title: string } | undefined;
    assert.ok(epic, 'pre-existing epic must survive the migration');
    assert.equal(epic!.title, 'Pre-v18 epic');
  });
});

// ─── Insert → read round-trip ─────────────────────────────────────────────────

describe('LessonStore — insert/read round-trip', () => {
  it('insert returns LessonRow with assigned id; getByEpic returns the same row', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const rows = store.insert([makeLesson()]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].id > 0, 'id must be a positive integer');

    const fetched = store.getByEpic('epic-001');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].id, rows[0].id);
    assert.equal(fetched[0].epic_id, 'epic-001');
    assert.equal(fetched[0].category, 'schema-migration');
    assert.equal(fetched[0].observation, 'Additive migrations prevented downtime');
    assert.equal(
      fetched[0].general_rule,
      'Use CREATE TABLE IF NOT EXISTS for additive schema changes',
    );
    assert.equal(fetched[0].created_at, FIXED_TIME);
    assert.equal(fetched[0].applied_as, null);
    assert.equal(fetched[0].applied_ref, null);
  });

  it('optional fields root_cause and evidence round-trip when provided', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const [row] = store.insert([
      makeLesson({ root_cause: 'Missing guard clause', evidence: 'PR #42' }),
    ]);
    assert.equal(row.root_cause, 'Missing guard clause');
    assert.equal(row.evidence, 'PR #42');

    const [fetched] = store.getByEpic('epic-001');
    assert.equal(fetched.root_cause, 'Missing guard clause');
    assert.equal(fetched.evidence, 'PR #42');
  });

  it('root_cause and evidence are undefined (not null) when absent', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const [row] = store.insert([makeLesson()]);
    assert.equal(row.root_cause, undefined);
    assert.equal(row.evidence, undefined);
  });

  it('empty insert returns empty array', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);
    assert.deepEqual(store.insert([]), []);
  });
});

// ─── Validation on write ─────────────────────────────────────────────────────

describe('LessonStore — validation on write', () => {
  it('throws when general_rule is missing', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);
    assert.throws(() =>
      store.insert([
        {
          epic_id: 'epic-001',
          category: 'test',
          observation: 'obs',
          // general_rule intentionally omitted
          applied_as: null,
          applied_ref: null,
          created_at: FIXED_TIME,
        } as any,
      ]),
    );
  });

  it('throws when epic_id is missing', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);
    assert.throws(() =>
      store.insert([
        {
          category: 'test',
          observation: 'obs',
          general_rule: 'rule',
          applied_as: null,
          applied_ref: null,
          created_at: FIXED_TIME,
        } as any,
      ]),
    );
  });
});

// ─── created_at is caller-supplied ───────────────────────────────────────────

describe('LessonStore — created_at is caller-supplied', () => {
  it('fixed created_at round-trips unchanged', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const fixedTime = '2026-01-15T10:30:00.000Z';
    const [row] = store.insert([makeLesson({ created_at: fixedTime })]);
    assert.equal(row.created_at, fixedTime);

    const [fetched] = store.getByEpic('epic-001');
    assert.equal(fetched.created_at, fixedTime);
  });

  it('LessonStore source contains no Date.now() or new Date() call', () => {
    // The store must never generate timestamps; created_at is always caller-supplied.
    // Read the TypeScript source (always present, no build dependency).
    // __dirname at runtime = dist/state/__tests__; src lives at ../../../src/state/.
    const storeTs = path.resolve(__dirname, '..', '..', '..', 'src', 'state', 'LessonStore.ts');
    const src = fs.readFileSync(storeTs, 'utf-8');
    assert.ok(!src.includes('Date.now()'), 'LessonStore must not call Date.now()');
    assert.ok(!/new Date\(\)/.test(src), 'LessonStore must not call new Date()');
  });
});

// ─── markApplied ─────────────────────────────────────────────────────────────

describe('LessonStore — markApplied', () => {
  it('updates applied_as and applied_ref on the row', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const [row] = store.insert([makeLesson()]);
    assert.equal(row.applied_as, null);

    store.markApplied(row.id, 'worker_guidance', 'story-x');

    const [updated] = store.getByEpic('epic-001');
    assert.equal(updated.applied_as, 'worker_guidance');
    assert.equal(updated.applied_ref, 'story-x');
  });

  it('overwrites applied values on a second markApplied call (ADR-005)', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const [row] = store.insert([makeLesson()]);
    store.markApplied(row.id, 'worker_guidance', 'story-x');
    store.markApplied(row.id, 'policy_suggestion', 'audit-ref-42');

    const [updated] = store.getByEpic('epic-001');
    assert.equal(updated.applied_as, 'policy_suggestion');
    assert.equal(updated.applied_ref, 'audit-ref-42');
  });

  it('list({appliedOnly:true}) includes applied rows and excludes unapplied', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    const [a] = store.insert([makeLesson({ category: 'alpha' })]);
    store.insert([makeLesson({ category: 'beta' })]);

    store.markApplied(a.id, 'worker_guidance', 'story-x');

    const applied = store.list({ appliedOnly: true });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].category, 'alpha');
  });

  it('list({category}) filters by category', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    store.insert([makeLesson({ category: 'testing' })]);
    store.insert([makeLesson({ category: 'deployment' })]);

    const testingRows = store.list({ category: 'testing' });
    assert.equal(testingRows.length, 1);
    assert.equal(testingRows[0].category, 'testing');

    const noneRows = store.list({ category: 'unknown' });
    assert.equal(noneRows.length, 0);
  });

  it('list({limit}) caps the result set', () => {
    const db = createDatabase(':memory:');
    const store = new LessonStore(db);

    store.insert([
      makeLesson({ category: 'a' }),
      makeLesson({ category: 'b' }),
      makeLesson({ category: 'c' }),
    ]);

    const limited = store.list({ limit: 2 });
    assert.equal(limited.length, 2);
  });
});
