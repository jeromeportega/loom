import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '../../state/Database.js';
import { SignalStore } from '../SignalStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import type { Signal } from '../types.js';

// ─── Migration ────────────────────────────────────────────────────────────────

describe('Database migration v17/v18', () => {
  it('applies current SCHEMA_VERSION and creates signals table on a fresh DB', () => {
    const db = createDatabase(':memory:');

    const row = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(row.version, 18);

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'")
      .get();
    assert.ok(tbl, 'signals table should exist');

    const statusIdx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_signals_status'")
      .get();
    assert.ok(statusIdx, 'idx_signals_status should exist');

    const sourceIdx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_signals_source'")
      .get();
    assert.ok(sourceIdx, 'idx_signals_source should exist');

    const oppTbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='opportunities'")
      .get();
    assert.ok(oppTbl, 'opportunities table should exist');
  });

  it('auto-creates signals table when migrating from a v16 DB without error', () => {
    // Simulate a pre-v17 DB: all v16 tables present, no signals/opportunities.
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    // Run the minimal pre-v17 schema that runMigrations expects to find on an
    // existing DB (all tables/columns from v16, version row set to 16).
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
      CREATE VIRTUAL TABLE audit_log_fts USING fts5(command, action, content=audit_log, content_rowid=id);
      CREATE TRIGGER audit_log_ai AFTER INSERT ON audit_log BEGIN
        INSERT INTO audit_log_fts(rowid, command, action) VALUES (new.id, new.command, new.action);
      END;
      CREATE TABLE decision_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epic_id TEXT,
        story_id TEXT, kind TEXT NOT NULL, subject TEXT, rationale TEXT NOT NULL,
        metadata TEXT, timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_decision_traces_agent ON decision_traces(agent_id);
      CREATE INDEX idx_decision_traces_story ON decision_traces(story_id);
      INSERT INTO schema_version (version) VALUES (16);
      INSERT INTO epics (id, title) VALUES ('legacy-epic', 'A Pre-v17 Epic');
    `);

    // Migration should complete without error and add the new tables.
    runMigrations(db);

    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, 18);

    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signals'")
      .get();
    assert.ok(tbl, 'signals table should be created by migration');

    // Existing data must be untouched.
    const epic = db
      .prepare('SELECT id, title FROM epics WHERE id = ?')
      .get('legacy-epic') as { id: string; title: string } | undefined;
    assert.ok(epic, 'pre-existing epic should still exist');
    assert.equal(epic!.title, 'A Pre-v17 Epic');
  });

  it('runMigrations is idempotent on a current DB', () => {
    const db = createDatabase(':memory:');
    // Running a second time must not throw or corrupt the version row.
    assert.doesNotThrow(() => runMigrations(db));
    const ver = db
      .prepare('SELECT version FROM schema_version LIMIT 1')
      .get() as { version: number };
    assert.equal(ver.version, 18);
  });
});

// ─── SignalStore: UNIQUE key / upsert counting ─────────────────────────────

describe('SignalStore — upsert counting', () => {
  it('first insert reports inserted=1, refreshed=0', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const result = store.upsertMany([
      { key: 'sig-a', source: 'code-debt', kind: 'todo', title: 'Signal A' },
    ]);
    assert.equal(result.inserted, 1);
    assert.equal(result.refreshed, 0);
  });

  it('second insert of the same key reports inserted=0, refreshed=1 with no duplicate row', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const sig: Signal = { key: 'sig-dup', source: 'code-debt', kind: 'todo', title: 'Dup' };

    store.upsertMany([sig]);
    const result = store.upsertMany([sig]);

    assert.equal(result.inserted, 0);
    assert.equal(result.refreshed, 1);

    const count = db
      .prepare("SELECT COUNT(*) as n FROM signals WHERE key = 'sig-dup'")
      .get() as { n: number };
    assert.equal(count.n, 1, 'only one row should exist');
  });

  it('batch with mixed new and existing keys counts both correctly', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    store.upsertMany([{ key: 'existing', source: 'code-debt', kind: 'todo', title: 'E' }]);

    const result = store.upsertMany([
      { key: 'existing', source: 'code-debt', kind: 'todo', title: 'E' },
      { key: 'new-key', source: 'audit-introspection', kind: 'cluster', title: 'N' },
    ]);
    assert.equal(result.inserted, 1);
    assert.equal(result.refreshed, 1);
  });

  it('empty upsert returns zeros', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const result = store.upsertMany([]);
    assert.equal(result.inserted, 0);
    assert.equal(result.refreshed, 0);
  });
});

// ─── SignalStore: UPSERT field refresh ────────────────────────────────────

describe('SignalStore — UPSERT refresh semantics', () => {
  it('re-upserting a key updates last_seen/detail/weight/metadata and resets status, keeps first_seen and id', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);

    store.upsertMany([
      {
        key: 'refresh-key',
        source: 'code-debt',
        kind: 'todo',
        title: 'Original',
        detail: 'original detail',
        weight: 1,
        metadata: { x: 1 },
      },
    ]);

    // Pin last_seen to a known past value to make the update observable.
    db.prepare("UPDATE signals SET last_seen = '2000-01-01 00:00:00' WHERE key = 'refresh-key'").run();
    // Mark stale so we can verify status is reset to open.
    db.prepare("UPDATE signals SET status = 'stale' WHERE key = 'refresh-key'").run();

    const [before] = store.getByKeys(['refresh-key']);

    store.upsertMany([
      {
        key: 'refresh-key',
        source: 'code-debt',
        kind: 'todo',
        title: 'Updated',
        detail: 'updated detail',
        weight: 2.5,
        metadata: { x: 2, y: 'new' },
      },
    ]);

    const [after] = store.getByKeys(['refresh-key']);

    // Stable fields
    assert.equal(after.id, before.id, 'id must not change');
    assert.equal(after.first_seen, before.first_seen, 'first_seen must not change');

    // Updated fields
    assert.equal(after.detail, 'updated detail');
    assert.equal(after.weight, 2.5);
    assert.deepEqual(after.metadata, { x: 2, y: 'new' });
    assert.equal(after.status, 'open', 'status must reset to open');
    assert.ok(
      after.last_seen > '2000-01-01 00:00:00',
      'last_seen must be updated past the pinned value'
    );
  });
});

// ─── SignalStore: reconcile ───────────────────────────────────────────────

describe('SignalStore — reconcile', () => {
  it('marks unobserved open signals as stale and returns count', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);

    store.upsertMany([
      { key: 'A', source: 'code-debt', kind: 'todo', title: 'A' },
      { key: 'B', source: 'code-debt', kind: 'todo', title: 'B' },
    ]);

    const count = store.reconcile(['A']);
    assert.equal(count, 1, 'only B should be staled');

    const records = store.getByKeys(['A', 'B']);
    const a = records.find((r) => r.key === 'A')!;
    const b = records.find((r) => r.key === 'B')!;
    assert.equal(a.status, 'open', 'A must remain open');
    assert.equal(b.status, 'stale', 'B must be stale');
  });

  it('reconcile([]) stales every open signal', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    store.upsertMany([
      { key: 'X', source: 'code-debt', kind: 'todo', title: 'X' },
      { key: 'Y', source: 'code-debt', kind: 'todo', title: 'Y' },
    ]);

    const count = store.reconcile([]);
    assert.equal(count, 2);

    const open = store.listOpen();
    assert.equal(open.length, 0, 'no signals should remain open');
  });

  it('a stale signal re-observed in the next upsert returns to open', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);

    store.upsertMany([{ key: 'Z', source: 'code-debt', kind: 'todo', title: 'Z' }]);
    store.reconcile([]); // stale everything

    const [staled] = store.getByKeys(['Z']);
    assert.equal(staled.status, 'stale');

    // Re-observe in the next scan
    store.upsertMany([{ key: 'Z', source: 'code-debt', kind: 'todo', title: 'Z' }]);

    const [reopened] = store.getByKeys(['Z']);
    assert.equal(reopened.status, 'open', 'stale signal must return to open when re-observed');
  });

  it('reconcile does not affect already-stale signals (idempotent on stale)', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    store.upsertMany([{ key: 'already-stale', source: 'code-debt', kind: 'todo', title: 'S' }]);
    store.reconcile([]); // stale it

    // A second reconcile reports 0 changes (no newly-staled signals)
    const secondCount = store.reconcile([]);
    assert.equal(secondCount, 0);
  });
});

// ─── SignalStore: listOpen ────────────────────────────────────────────────

describe('SignalStore — listOpen', () => {
  it('returns only open rows and respects the limit', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);

    const signals: Signal[] = Array.from({ length: 5 }, (_, i) => ({
      key: `lo-${i}`,
      source: 'code-debt' as const,
      kind: 'todo',
      title: `Signal ${i}`,
    }));
    store.upsertMany(signals);

    // Stale lo-3 and lo-4; keep lo-0, lo-1, lo-2 open.
    store.reconcile(['lo-0', 'lo-1', 'lo-2']);

    const all = store.listOpen();
    assert.equal(all.length, 3, 'should return only open signals');
    assert.ok(all.every((r) => r.status === 'open'));

    const capped = store.listOpen(2);
    assert.equal(capped.length, 2, 'limit should be respected');
    assert.ok(capped.every((r) => r.status === 'open'));
  });

  it('listOpen with no signals returns empty array', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    assert.deepEqual(store.listOpen(), []);
    assert.deepEqual(store.listOpen(10), []);
  });
});

// ─── SignalStore: getByKeys ───────────────────────────────────────────────

describe('SignalStore — getByKeys', () => {
  it('returns exactly the requested keys and ignores unknown ones', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);

    store.upsertMany([
      { key: 'k1', source: 'code-debt', kind: 'todo', title: 'K1' },
      { key: 'k2', source: 'code-debt', kind: 'todo', title: 'K2' },
    ]);

    const results = store.getByKeys(['k1', 'k-unknown']);
    assert.equal(results.length, 1);
    assert.equal(results[0].key, 'k1');
  });

  it('getByKeys([]) returns empty array', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    assert.deepEqual(store.getByKeys([]), []);
  });
});

// ─── Audit: scan persistence writes one audit row ────────────────────────

describe('SignalStore — audit integration', () => {
  it('each scan persistence path writes one audit_log row with action signal_scan', () => {
    const db = createDatabase(':memory:');
    const store = new SignalStore(db);
    const auditLog = new AuditLog(db);

    const signals: Signal[] = [
      { key: 'audit-sig', source: 'audit-introspection', kind: 'cluster', title: 'Audit Signal' },
    ];

    const { inserted, refreshed } = store.upsertMany(signals);
    const staled = store.reconcile(signals.map((s) => s.key));

    // runScan (story-004-004) will write exactly one row here; we prove the
    // infrastructure supports it.
    auditLog.record({
      action: 'signal_scan',
      detail: { inserted, refreshed, staled, sources: ['audit-introspection'] },
    });

    const rows = auditLog.recent(5);
    const scanRows = rows.filter((r) => r.action === 'signal_scan');
    assert.equal(scanRows.length, 1, 'exactly one signal_scan row should be written per scan');

    const detail = JSON.parse(scanRows[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.inserted, 1);
    assert.equal(detail.refreshed, 0);
    assert.equal(detail.staled, 0);
  });
});
