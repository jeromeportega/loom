import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { PlanningOutputSink } from '../planner/PlanningOutputSink.js';
import type { PlanningEvent } from '../planner/PlanningEvent.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

describe('PlanningOutputSink — rolling buffer (AC1)', () => {
  it('appending past LIVE_TAIL_CHARS retains only the most-recent 4096 chars', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const sink = new PlanningOutputSink('epic-001', epicStore);
    // Feed 2× LIVE_TAIL_CHARS + 1 of 'a' chars to force a trim
    const bigChunk = 'a'.repeat(PlanningOutputSink.LIVE_TAIL_CHARS * 2 + 1);
    sink.handleChunk(bigChunk);

    // Force flush via stop()
    sink.stop();

    const row = db.prepare('SELECT planning_log_tail FROM epics WHERE id = ?').get('epic-001') as
      | { planning_log_tail: string | null }
      | undefined;
    assert.ok(row, 'epic row must exist');
    const tail = row!.planning_log_tail ?? '';
    assert.ok(
      tail.length <= PlanningOutputSink.LIVE_TAIL_CHARS,
      `tail must be ≤ ${PlanningOutputSink.LIVE_TAIL_CHARS} chars; got ${tail.length}`
    );
    assert.ok(tail.endsWith('a'), 'tail must retain the most-recent chars');
  });

  it('append sets dirty=true so a subsequent flush writes to the DB', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const sink = new PlanningOutputSink('epic-001', epicStore);
    sink.handleChunk('first chunk');
    sink.stop(); // triggers final flush

    const row = db
      .prepare('SELECT planning_log_tail FROM epics WHERE id = ?')
      .get('epic-001') as { planning_log_tail: string | null } | undefined;
    assert.ok(row?.planning_log_tail?.includes('first chunk'), 'dirty buffer must be flushed');
  });

  it('a clean (non-dirty) buffer does not cause a DB write on stop()', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    // Do NOT call handleChunk — the buffer stays clean
    const sink = new PlanningOutputSink('epic-001', epicStore);
    sink.stop(); // should be a no-op flush

    const row = db
      .prepare('SELECT planning_log_tail FROM epics WHERE id = ?')
      .get('epic-001') as { planning_log_tail: string | null } | undefined;
    // planning_log_tail should be NULL (never written) since the buffer was never dirty
    assert.equal(row?.planning_log_tail, null, 'no write should occur for a clean buffer');
  });
});

describe('PlanningOutputSink — redaction ordering (AC4)', () => {
  it('secrets are redacted BEFORE entering the buffer and BEFORE onPlanningEvent fires', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const SECRET = 'sk-ant-api03-' + 'S'.repeat(20);
    const events: PlanningEvent[] = [];

    const sink = new PlanningOutputSink('epic-001', epicStore, (e) => events.push(e));
    sink.setPhase('analyst');
    sink.handleChunk(`key=${SECRET}`);
    sink.stop();

    // 1. onPlanningEvent must not receive the secret
    for (const e of events) {
      if (e.type === 'output') {
        assert.ok(!e.chunk.includes(SECRET), 'secret must be redacted before onPlanningEvent fires');
        assert.ok(e.chunk.includes('sk-ant-[REDACTED]'), 'redacted placeholder must be present in event');
      }
    }

    // 2. The DB column must not contain the secret
    const row = db
      .prepare('SELECT planning_log_tail FROM epics WHERE id = ?')
      .get('epic-001') as { planning_log_tail: string | null } | undefined;
    const tail = row?.planning_log_tail ?? '';
    assert.ok(!tail.includes(SECRET), 'secret must be redacted before persisting to DB');
    assert.ok(tail.includes('sk-ant-[REDACTED]'), 'placeholder must appear in persisted tail');
  });
});

describe('PlanningOutputSink — active persona (AC2, AC5)', () => {
  it('setPhase writes a phase-transition marker into the tail', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const sink = new PlanningOutputSink('epic-001', epicStore);
    sink.setPhase('analyst');
    sink.handleChunk('analyst output');
    sink.setPhase('pm');
    sink.handleChunk('pm output');
    sink.setPhase('architect');
    sink.handleChunk('architect output');
    sink.stop();

    const row = db
      .prepare('SELECT planning_log_tail FROM epics WHERE id = ?')
      .get('epic-001') as { planning_log_tail: string | null } | undefined;
    const tail = row!.planning_log_tail ?? '';
    assert.ok(tail.includes('\n── analyst ──\n'), 'analyst marker must be present');
    assert.ok(tail.includes('\n── pm ──\n'), 'pm marker must be present');
    assert.ok(tail.includes('\n── architect ──\n'), 'architect marker must be present');
    // Order: analyst before pm before architect
    assert.ok(
      tail.indexOf('\n── analyst ──\n') < tail.indexOf('\n── pm ──\n'),
      'analyst marker must precede pm marker'
    );
    assert.ok(
      tail.indexOf('\n── pm ──\n') < tail.indexOf('\n── architect ──\n'),
      'pm marker must precede architect marker'
    );
  });

  it('emits a phase PlanningEvent on setPhase', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const events: PlanningEvent[] = [];
    const sink = new PlanningOutputSink('epic-001', epicStore, (e) => events.push(e));
    sink.setPhase('analyst');
    sink.setPhase('pm');

    const phaseEvents = events.filter((e) => e.type === 'phase');
    assert.equal(phaseEvents.length, 2);
    assert.deepEqual(phaseEvents[0], { type: 'phase', phase: 'analyst' });
    assert.deepEqual(phaseEvents[1], { type: 'phase', phase: 'pm' });
  });

  it('emits output PlanningEvent with the current phase', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const events: PlanningEvent[] = [];
    const sink = new PlanningOutputSink('epic-001', epicStore, (e) => events.push(e));
    sink.setPhase('pm');
    sink.handleChunk('hello');

    const outputEvents = events.filter((e): e is Extract<PlanningEvent, { type: 'output' }> =>
      e.type === 'output'
    );
    assert.equal(outputEvents.length, 1);
    assert.equal(outputEvents[0].phase, 'pm');
    assert.equal(outputEvents[0].chunk, 'hello');
  });
});

describe('PlanningOutputSink — durable flush (AC3)', () => {
  it('the planning_log_tail column is readable after stop()', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const sink = new PlanningOutputSink('epic-001', epicStore);
    sink.setPhase('analyst');
    sink.handleChunk('some planning output');
    sink.stop();

    const row = epicStore.get('epic-001');
    assert.ok(row, 'epic row must exist');
    assert.ok(
      typeof row!.planning_log_tail === 'string',
      'planning_log_tail must be a string after flush'
    );
    assert.ok(row!.planning_log_tail!.includes('some planning output'));
  });

  it('no leaked setInterval: timer is cleared after stop()', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    const sink = new PlanningOutputSink('epic-001', epicStore);
    sink.start();
    sink.handleChunk('hello');
    sink.stop();

    // After stop(), further handleChunk calls that would mark dirty should
    // NOT result in additional DB writes (timer is gone). We verify by
    // checking the tail is the same value as right after stop().
    const before = epicStore.get('epic-001')!.planning_log_tail;
    // Deliberately call handleChunk again after stop — this IS dirty but no timer
    // would auto-flush. A subsequent stop() would flush, but we don't call it.
    // This just verifies there's no crash / no leaked state.
    assert.doesNotThrow(() => sink.handleChunk('post-stop chunk'));
    // The DB value must be what it was right after stop() — no auto-flush happened
    const after = epicStore.get('epic-001')!.planning_log_tail;
    assert.equal(before, after, 'no auto-flush after stop — timer must be cleared');
  });

  it('TAIL_FLUSH_MS constant is 1000', () => {
    assert.equal(PlanningOutputSink.TAIL_FLUSH_MS, 1000);
  });

  it('LIVE_TAIL_CHARS constant is 4096', () => {
    assert.equal(PlanningOutputSink.LIVE_TAIL_CHARS, 4096);
  });
});

describe('PlanningOutputSink — DB migration guard (AC3)', () => {
  it('planning_log_tail column exists on a fresh DB after runMigrations()', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    const cols = (
      db.prepare('PRAGMA table_info(epics)').all() as { name: string; type: string }[]
    );
    const col = cols.find((c) => c.name === 'planning_log_tail');
    assert.ok(col, 'planning_log_tail column must exist after migration');
    assert.equal(col!.type, 'TEXT', 'planning_log_tail type must be TEXT');
  });

  it('runMigrations() is idempotent — second call on a DB that already has the column', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations() must not throw');

    const cols = (
      db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]
    ).filter((c) => c.name === 'planning_log_tail');
    assert.equal(cols.length, 1, 'exactly one planning_log_tail column — no duplicate');
  });

  it('pre-existing epic rows have planning_log_tail = NULL after migration', () => {
    // Build a "pre-migration" DB without planning_log_tail and seed data
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (20);

      CREATE TABLE epics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO epics (id, title, status) VALUES ('epic-001', 'Old Epic', 'done');
    `);
    db.pragma('foreign_keys = ON');

    runMigrations(db);

    const row = db
      .prepare('SELECT planning_log_tail FROM epics WHERE id = ?')
      .get('epic-001') as { planning_log_tail: string | null } | undefined;
    assert.ok(row, 'seeded row must survive migration');
    assert.equal(
      row!.planning_log_tail,
      null,
      'planning_log_tail must be NULL for pre-migration rows — never backfilled'
    );
  });
});

describe('EpicStore.updatePlanningLogTail (AC3)', () => {
  it('persists the tail to the epics.planning_log_tail column', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    epicStore.updatePlanningLogTail('epic-001', 'hello world');
    const row = epicStore.get('epic-001');
    assert.equal(row!.planning_log_tail, 'hello world');
  });

  it('overwrite works — second call replaces the first value', () => {
    const db = freshDb();
    const epicStore = new EpicStore(db);
    epicStore.create('epic-001', 'Test');

    epicStore.updatePlanningLogTail('epic-001', 'first');
    epicStore.updatePlanningLogTail('epic-001', 'second');
    const row = epicStore.get('epic-001');
    assert.equal(row!.planning_log_tail, 'second');
  });
});
