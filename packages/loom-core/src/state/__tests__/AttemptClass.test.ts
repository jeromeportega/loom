import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../Database.js';
import { AgentStore } from '../AgentStore.js';
import { AuditLog } from '../AuditLog.js';
import { EpicStore } from '../EpicStore.js';
import type {
  AttemptClass,
  InfraSignature,
} from '../../orchestrator/resilience/types.js';

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ac-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
});

// ─── v15 migration ───────────────────────────────────────────────────────────

describe('v15 attempt_class migration', () => {
  it('adds the attempt_class column to the agents table and bumps schema_version', () => {
    const db = openDatabase(loomDir);

    const cols = db.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
      type: string;
    }[];
    const col = cols.find((c) => c.name === 'attempt_class');
    assert.ok(col, 'attempt_class column exists');
    assert.equal(col!.type, 'TEXT', 'attempt_class is TEXT');

    const version = (
      db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
        version: number;
      }
    ).version;
    assert.equal(version, 16, 'schema_version is at v16');
  });

  it('is idempotent — re-running migrations on a DB that already has the column is a no-op', () => {
    // First open creates + migrates. A pre-v15 database, by contrast, has an
    // agents table WITHOUT attempt_class; simulate that by dropping the column
    // is not supported in sqlite, so instead assert the per-column guard does
    // not throw when the column is already present (the realistic upgrade path
    // for a process that opens the same DB twice).
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agent = new AgentStore(db).create('epic-001', 'story-006-001');

    // Re-running the DDL + per-column migration must not error or wipe data.
    resetDatabaseForTest();
    const db2 = openDatabase(loomDir);
    const cols = db2.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
    }[];
    assert.equal(
      cols.filter((c) => c.name === 'attempt_class').length,
      1,
      'column added exactly once across repeated migrations'
    );
    assert.ok(
      new AgentStore(db2).get(agent.id),
      'existing rows survive re-migration'
    );
  });

  it('applies attempt_class to a pre-v15 agents table without the column', () => {
    // Build a legacy agents table missing attempt_class, stamp schema_version
    // at 14, then run the migration via openDatabase and confirm it upgrades.
    const dbPath = path.join(loomDir, 'loom.db');
    fs.mkdirSync(loomDir, { recursive: true });
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE epics (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT);
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (14);
      INSERT INTO agents (id, epic_id, story_id) VALUES ('agent-legacy', 'epic-001', 'story-006-001');
    `);
    const before = raw.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
    }[];
    assert.ok(
      !before.some((c) => c.name === 'attempt_class'),
      'precondition: legacy table lacks attempt_class'
    );
    raw.close();

    resetDatabaseForTest();
    const db = openDatabase(loomDir);
    const after = db.prepare('PRAGMA table_info(agents)').all() as {
      name: string;
    }[];
    assert.ok(
      after.some((c) => c.name === 'attempt_class'),
      'migration adds attempt_class to the legacy table'
    );
    assert.equal(
      (
        db.prepare('SELECT version FROM schema_version LIMIT 1').get() as {
          version: number;
        }
      ).version,
      16,
      'schema_version upgraded 14 → 16'
    );
    // The legacy row is preserved and reads back with a NULL classification.
    const legacy = new AgentStore(db).get('agent-legacy');
    assert.ok(legacy, 'legacy row survives the migration');
    assert.equal(legacy!.attempt_class, null);
  });
});

// ─── attempt_class round-trip on AgentStore ────────────────────────────────────

describe('AgentStore.setAttemptClass', () => {
  const classes: (AttemptClass | null)[] = [
    'infra_failure',
    'work_failure',
    null,
  ];

  for (const value of classes) {
    it(`round-trips ${value === null ? 'null' : value}`, () => {
      const db = openDatabase(loomDir);
      new EpicStore(db).create('epic-001', 'Epic 1');
      const store = new AgentStore(db);
      const agent = store.create('epic-001', 'story-006-001');

      // A freshly created agent has no classification yet.
      assert.equal(agent.attempt_class, null, 'defaults to null on create');

      store.setAttemptClass(agent.id, value);
      assert.equal(
        store.get(agent.id)!.attempt_class,
        value,
        'value reads back from the column'
      );
    });
  }

  it('overwrites a prior classification (infra_failure → work_failure → null)', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-006-001');

    store.setAttemptClass(agent.id, 'infra_failure');
    assert.equal(store.get(agent.id)!.attempt_class, 'infra_failure');
    store.setAttemptClass(agent.id, 'work_failure');
    assert.equal(store.get(agent.id)!.attempt_class, 'work_failure');
    store.setAttemptClass(agent.id, null);
    assert.equal(store.get(agent.id)!.attempt_class, null, 'clears back to null');
  });

  it('does not touch status (orthogonal to the lifecycle enum, ADR-1)', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const store = new AgentStore(db);
    const agent = store.create('epic-001', 'story-006-001');
    store.updateStatus(agent.id, 'running');

    store.setAttemptClass(agent.id, 'infra_failure');
    const after = store.get(agent.id)!;
    assert.equal(after.status, 'running', 'status is unchanged by classification');
    assert.equal(after.attempt_class, 'infra_failure');
  });
});

// ─── attempt_classified audit detail ───────────────────────────────────────────

describe('AuditLog.recordAttemptClassified', () => {
  it('records the cause in the JSON detail and is retrievable by story', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const store = new AgentStore(db);
    const audit = new AuditLog(db);
    const agent = store.create('epic-001', 'story-006-001');

    const signature: InfraSignature = 'spawn_enoent';
    audit.recordAttemptClassified(
      'story-006-001',
      {
        attempt_class: 'infra_failure',
        signature,
        retry_attempt: 1,
        produced_output: false,
      },
      agent.id
    );

    const rows = audit.getByStory('story-006-001');
    const row = rows.find((r) => r.action === 'attempt_classified');
    assert.ok(row, 'attempt_classified row is retrievable by story');
    assert.equal(row!.command, 'story-006-001');
    assert.equal(row!.agent_id, agent.id);

    const detail = JSON.parse(row!.detail!) as Record<string, unknown>;
    assert.deepEqual(detail, {
      attempt_class: 'infra_failure',
      signature: 'spawn_enoent',
      retry_attempt: 1,
      produced_output: false,
    });
  });

  it('omits signature/retry_attempt when not provided (work_failure)', () => {
    const db = openDatabase(loomDir);
    const audit = new AuditLog(db);
    audit.recordAttemptClassified('story-006-002', {
      attempt_class: 'work_failure',
      produced_output: true,
    });

    const rows = audit.getByCommand('story-006-002', ['attempt_classified']);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail!) as Record<string, unknown>;
    assert.deepEqual(detail, {
      attempt_class: 'work_failure',
      produced_output: true,
    });
    assert.ok(!('signature' in detail), 'no signature on work_failure');
    assert.ok(!('retry_attempt' in detail), 'no retry_attempt when unset');
  });

  it('keeps produced_output: false (a falsy but meaningful value) in the detail', () => {
    const db = openDatabase(loomDir);
    const audit = new AuditLog(db);
    audit.recordAttemptClassified('story-006-003', {
      attempt_class: 'infra_failure',
      signature: 'exit_before_output',
      produced_output: false,
    });
    const rows = audit.getByCommand('story-006-003', ['attempt_classified']);
    const detail = JSON.parse(rows[0].detail!) as Record<string, unknown>;
    assert.equal(detail.produced_output, false);
    assert.equal(detail.signature, 'exit_before_output');
  });
});
