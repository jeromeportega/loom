import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { EpicStore } from '../EpicStore.js';
import { AgentStore } from '../AgentStore.js';
import { STANDALONE_KIND, StorySchema } from '../../types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function epicColumns(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info('epics')").all() as { name: string }[]).map(
    (c) => c.name
  );
}

function schemaVersion(db: Database.Database): number {
  return (
    db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
      version: number;
    }
  ).version;
}

/**
 * Seeds a minimal v23 DB: epics + agents with all v23 columns but WITHOUT the
 * v24 `kind` column. One epic row and one agent row pre-exist to verify the
 * migration is loss-free.
 */
function seedV23Db(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      brief_path TEXT,
      prd_path TEXT,
      yaml_path TEXT,
      reason TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      planner_tokens_input INTEGER,
      planner_tokens_output INTEGER,
      planner_tokens_cached INTEGER,
      planner_ms INTEGER,
      base_sha TEXT,
      archived_at DATETIME,
      user_brief TEXT,
      planning_phase TEXT,
      planner_request_count INTEGER,
      policy_snapshot TEXT,
      finalize_phase TEXT,
      epic_pr_url TEXT,
      error TEXT,
      autonomy_level TEXT NOT NULL DEFAULT 'manual',
      paused_at DATETIME,
      paused_after_story TEXT,
      proposed_by TEXT,
      finalize_ref TEXT,
      publish_note TEXT,
      planner_model TEXT,
      planning_log_tail TEXT,
      intake_verdict TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      epic_id TEXT NOT NULL REFERENCES epics(id),
      story_id TEXT NOT NULL,
      story_title TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      worktree_path TEXT,
      branch_name TEXT,
      pr_url TEXT,
      log_tail TEXT,
      started_at DATETIME,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      worker_pid INTEGER
    );
  `);
  db.prepare('INSERT INTO schema_version (version) VALUES (23)').run();
  db.prepare(
    `INSERT INTO epics (id, title, status) VALUES (?, ?, ?)`
  ).run('epic-100', 'Pre-existing v23 epic', 'in_progress');
  db.prepare(
    `INSERT INTO agents (id, epic_id, story_id, story_title, status, updated_at)
     VALUES (?, ?, ?, ?, 'done', CURRENT_TIMESTAMP)`
  ).run('agent-story-100-001-aabbccdd', 'epic-100', 'story-100-001', 'Pre-existing story');
  return db;
}

// ─── [migration v24] ──────────────────────────────────────────────────────────

describe('v23 → v24 migration (standalone story container kind)', () => {
  it('adds kind column additively on a seeded v23 DB (AC2)', () => {
    const dbPath = path.join(tmpDir, 'v23.db');
    const db = seedV23Db(dbPath);

    assert.equal(schemaVersion(db), 23);
    const before = epicColumns(db);
    assert.ok(!before.includes('kind'), 'kind column absent before migration');

    runMigrations(db);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const after = epicColumns(db);
    assert.ok(after.includes('kind'), 'kind column added by v24 migration');

    db.close();
  });

  it('pre-existing epics and agents rows survive with kind=NULL — no backfill (AC2)', () => {
    const dbPath = path.join(tmpDir, 'v23-survival.db');
    const db = seedV23Db(dbPath);

    runMigrations(db);

    const epic = db
      .prepare('SELECT * FROM epics WHERE id = ?')
      .get('epic-100') as Record<string, unknown>;
    assert.ok(epic, 'pre-existing epic row must survive');
    assert.equal(epic.title, 'Pre-existing v23 epic');
    assert.equal(epic.status, 'in_progress');
    assert.equal(epic.kind, null, 'kind is NULL — no backfill (AC2)');

    const agent = db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get('agent-story-100-001-aabbccdd') as Record<string, unknown>;
    assert.ok(agent, 'pre-existing agent row must survive');
    assert.equal(agent.story_id, 'story-100-001');
    assert.equal(agent.epic_id, 'epic-100');

    db.close();
  });

  it('is idempotent — running migrations twice does not throw or double-add kind', () => {
    const dbPath = path.join(tmpDir, 'v23-idempotent.db');
    const db = seedV23Db(dbPath);

    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');
    assert.equal(schemaVersion(db), SCHEMA_VERSION);

    const cols = epicColumns(db);
    const count = (name: string) => cols.filter((c) => c === name).length;
    assert.equal(count('kind'), 1, 'kind appears exactly once');

    db.close();
  });

  it('fresh DB initializes with kind column present', () => {
    const dbPath = path.join(tmpDir, 'v24-fresh.db');
    const db = createDatabase(dbPath);

    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const cols = epicColumns(db);
    assert.ok(cols.includes('kind'), 'kind column in fresh DB');

    db.close();
  });
});

// ─── [createStandalone] ───────────────────────────────────────────────────────

describe('EpicStore.createStandalone / isStandalone', () => {
  it('createStandalone inserts kind=standalone; isStandalone returns true', () => {
    const db = createDatabase(path.join(tmpDir, 'create-standalone.db'));
    const store = new EpicStore(db);

    store.createStandalone('epic-047', 'My standalone epic');

    const rec = store.get('epic-047');
    assert.ok(rec, 'row must exist after createStandalone');
    assert.equal(rec.kind, STANDALONE_KIND, 'kind is standalone');
    assert.ok(store.isStandalone('epic-047'), 'isStandalone returns true');

    db.close();
  });

  it('normal create() yields kind=NULL; isStandalone returns false', () => {
    const db = createDatabase(path.join(tmpDir, 'create-normal.db'));
    const store = new EpicStore(db);

    store.create('epic-048', 'Normal epic');

    const rec = store.get('epic-048');
    assert.ok(rec);
    assert.equal(rec.kind ?? null, null, 'kind is NULL for normal epics');
    assert.ok(!store.isStandalone('epic-048'), 'isStandalone returns false for normal epic');

    db.close();
  });

  it('isStandalone returns false for an unknown epic id', () => {
    const db = createDatabase(path.join(tmpDir, 'isstandalone-unknown.db'));
    const store = new EpicStore(db);

    assert.ok(!store.isStandalone('epic-999'), 'isStandalone false for missing row');

    db.close();
  });
});

// ─── [standalone story round-trip] ───────────────────────────────────────────

describe('standalone story round-trip (AC1, AC3)', () => {
  it('agents row under standalone container round-trips story_id and title', () => {
    const db = createDatabase(path.join(tmpDir, 'standalone-roundtrip.db'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);

    // Create the standalone container.
    epicStore.createStandalone('epic-047', 'Story: add widget');

    // Persist an agents row pointing at the standalone container.
    const agent = agentStore.create('epic-047', 'story-047', 'add widget');

    // Read it back and confirm all identity fields survive.
    const read = agentStore.get(agent.id);
    assert.ok(read, 'agent row must be retrievable');
    assert.equal(read.epic_id, 'epic-047', 'epic_id (container) survives');
    assert.equal(read.story_id, 'story-047', 'flat story_id survives (AC1)');
    assert.equal(read.story_title, 'add widget', 'story_title survives');

    db.close();
  });

  it('StorySchema validates a story with all required standalone fields (AC3)', () => {
    const story = StorySchema.parse({
      id: 'story-047',
      title: 'Add widget',
      description: 'Adds a widget to the dashboard.',
      acceptance_criteria: ['Widget appears on load', 'Widget is dismissible'],
      estimated_complexity: 'small',
      dependencies: [],
      tech_notes: 'Uses existing WidgetBase class.',
    });

    assert.equal(story.id, 'story-047');
    assert.equal(story.title, 'Add widget');
    assert.ok(story.description.length > 0, 'description present (AC3)');
    assert.ok(story.acceptance_criteria.length >= 1, 'acceptance_criteria >= 1 (AC3)');
    assert.ok(story.tech_notes, 'tech_notes present (AC3)');
  });
});

// ─── [list exclusion] ────────────────────────────────────────────────────────

describe('EpicStore.list() standalone exclusion (AC4)', () => {
  it('list() excludes kind=standalone by default', () => {
    const db = createDatabase(path.join(tmpDir, 'list-exclusion.db'));
    const store = new EpicStore(db);

    store.create('epic-001', 'Normal epic');
    store.createStandalone('epic-002', 'Standalone container');

    const normal = store.list();
    assert.equal(normal.length, 1, 'only one epic returned by default');
    assert.equal(normal[0].id, 'epic-001');

    db.close();
  });

  it('list({ includeStandalone: true }) includes kind=standalone rows', () => {
    const db = createDatabase(path.join(tmpDir, 'list-include-standalone.db'));
    const store = new EpicStore(db);

    store.create('epic-001', 'Normal epic');
    store.createStandalone('epic-002', 'Standalone container');

    const all = store.list({ includeStandalone: true });
    assert.equal(all.length, 2, 'both rows included when includeStandalone=true');
    const ids = all.map((r) => r.id).sort();
    assert.deepEqual(ids, ['epic-001', 'epic-002']);

    db.close();
  });

  it('list() with only standalone epics returns empty', () => {
    const db = createDatabase(path.join(tmpDir, 'list-only-standalone.db'));
    const store = new EpicStore(db);

    store.createStandalone('epic-003', 'Standalone only');

    const result = store.list();
    assert.equal(result.length, 0, 'no epics returned when only standalone exists');

    db.close();
  });
});

// ─── [epic-parented unchanged] ───────────────────────────────────────────────

describe('epic-parented story unchanged (AC2)', () => {
  it('story-NNN-MMM id validates and agents row round-trips identically to before', () => {
    const db = createDatabase(path.join(tmpDir, 'parented-roundtrip.db'));
    const epicStore = new EpicStore(db);
    const agentStore = new AgentStore(db);

    epicStore.create('epic-046', 'Existing parented epic');
    const agent = agentStore.create('epic-046', 'story-046-001', 'Parented story');

    const read = agentStore.get(agent.id);
    assert.ok(read);
    assert.equal(read.story_id, 'story-046-001', 'parented story_id unchanged (AC2)');
    assert.equal(read.epic_id, 'epic-046');

    // list() still returns normal (non-standalone) epics.
    const epics = epicStore.list();
    assert.equal(epics.length, 1);
    assert.equal(epics[0].id, 'epic-046');

    db.close();
  });
});

// ─── [StorySchema regex] ─────────────────────────────────────────────────────

describe('StorySchema.id regex — relaxed superset /^story-\\d{3}(-\\d{3})?$/', () => {
  it('accepts standalone flat id story-047', () => {
    assert.doesNotThrow(() => StorySchema.shape.id.parse('story-047'));
    assert.equal(StorySchema.shape.id.parse('story-047'), 'story-047');
  });

  it('accepts parented id story-047-001', () => {
    assert.doesNotThrow(() => StorySchema.shape.id.parse('story-047-001'));
    assert.equal(StorySchema.shape.id.parse('story-047-001'), 'story-047-001');
  });

  it('rejects story-47 (only two digits)', () => {
    assert.throws(() => StorySchema.shape.id.parse('story-47'));
  });

  it('rejects story-1-2 (single digit groups)', () => {
    assert.throws(() => StorySchema.shape.id.parse('story-1-2'));
  });

  it('rejects storyfoo (no dash-NNN suffix)', () => {
    assert.throws(() => StorySchema.shape.id.parse('storyfoo'));
  });

  it('rejects story-047-01 (two-digit story number)', () => {
    assert.throws(() => StorySchema.shape.id.parse('story-047-01'));
  });

  it('rejects story-047-0001 (four-digit story number)', () => {
    assert.throws(() => StorySchema.shape.id.parse('story-047-0001'));
  });
});
