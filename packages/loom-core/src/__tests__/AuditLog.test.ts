import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AuditLog } from '../state/AuditLog.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import type Database from 'better-sqlite3';
import {
  AUDIT_GENESIS_HASH,
  canonicalPayload,
  computeEntryHash,
} from '../state/auditHash.js';

/**
 * Inserts an `agents` row with the exact id we need to test the LIKE/length
 * guard in `getByStory` — bypasses `AgentStore.create()`'s random suffix so
 * the test controls the agent_id shape under audit.
 */
function seedAgent(db: Database.Database, id: string, storyId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO agents (id, epic_id, story_id, status, updated_at) VALUES (?, 'epic-001', ?, 'done', ?)"
  ).run(id, storyId, now);
}

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-al-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
});

describe('AuditLog.getByStory — story-id prefix guard (v0.5.0)', () => {
  it('returns rows for an exact story_id match across agent_id and command shapes', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-001-abcdef01', 'story-001-001');
    seedAgent(db, 'agent-story-001-001-12345678', 'story-001-001');
    seedAgent(db, 'agent-story-001-002-deadbeef', 'story-001-002');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-001-abcdef01', action: 'dispatch' });
    audit.record({ agent_id: 'agent-story-001-001-12345678', action: 'completion' });
    audit.record({
      action: 'epic_integration_attempt',
      command: 'story-001-001',
    });
    audit.record({ agent_id: 'agent-story-001-002-deadbeef', action: 'dispatch' });

    const rows = audit.getByStory('story-001-001');
    const actions = rows.map((r) => r.action).sort();
    assert.deepEqual(
      actions,
      ['completion', 'dispatch', 'epic_integration_attempt'],
      'matches every attempt + the rolling-integrator command row'
    );
  });

  it('does NOT match a story_id that is a prefix of another (length guard)', () => {
    // The bug: `LIKE 'agent-story-001-%'` matches `agent-story-001-002-<hex>`.
    // With the length guard, `story-001` only matches `agent-story-001-<8hex>`
    // — a (well-formed) agent whose storyId is exactly `story-001`. The
    // `story-001-002` agents stay invisible to this query.
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-002-abcdef01', 'story-001-002');
    seedAgent(db, 'agent-story-001-002-deadbeef', 'story-001-002');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-002-abcdef01', action: 'dispatch' });
    audit.record({ agent_id: 'agent-story-001-002-deadbeef', action: 'completion' });

    const rows = audit.getByStory('story-001');
    assert.equal(rows.length, 0, 'no rows leak in from sibling stories whose id starts the same');
  });

  it('positive control: a well-formed agent-<story-001>-<8hex> row DOES match story-001', () => {
    // Belt-and-suspenders for the length guard: the prior test shows we don't
    // bleed sibling stories in, but we also must not over-restrict the
    // legitimate match. A bare `story-001` story (well-formed, just shorter
    // than the loom-canonical `story-NNN-MMM`) with one own agent_id should
    // be returned by `getByStory('story-001')`.
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-deadbeef', 'story-001');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-deadbeef', action: 'dispatch' });
    const rows = audit.getByStory('story-001');
    assert.equal(rows.length, 1, 'well-formed agent_id matches its own storyId');
  });

  it('command=<storyId> rows are picked up even when no agent_id matches', () => {
    const audit = new AuditLog(openDatabase(loomDir));
    audit.record({
      action: 'epic_rolling_merge_conflict',
      command: 'story-005-006',
    });
    const rows = audit.getByStory('story-005-006');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'epic_rolling_merge_conflict');
  });
});

type AnchorRow = {
  id: number;
  hashed_row_count: number;
  cutover_id: number | null;
  last_id: number | null;
  last_entry_hash: string | null;
};

describe('AuditLog.record — anchor update (story-097-002)', () => {
  it('first record sets anchor: hashed_row_count=1, cutover_id=last_id=row id, last_entry_hash matches', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);

    audit.record({ action: 'first_action' });

    const anchor = db.prepare('SELECT * FROM audit_chain_head WHERE id = 1').get() as AnchorRow;
    const row = db
      .prepare('SELECT id, entry_hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { id: number; entry_hash: string };

    assert.equal(anchor.hashed_row_count, 1, 'hashed_row_count = 1 after first record');
    assert.equal(anchor.cutover_id, row.id, 'cutover_id equals first row id');
    assert.equal(anchor.last_id, row.id, 'last_id equals first row id');
    assert.equal(anchor.last_entry_hash, row.entry_hash, 'last_entry_hash matches entry_hash');
  });

  it('three records: hashed_row_count=3, cutover_id unchanged, last_id/hash from third row', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);

    audit.record({ action: 'first' });
    const firstRow = db
      .prepare('SELECT id FROM audit_log ORDER BY id ASC LIMIT 1')
      .get() as { id: number };

    audit.record({ action: 'second' });
    audit.record({ action: 'third' });

    const anchor = db.prepare('SELECT * FROM audit_chain_head WHERE id = 1').get() as AnchorRow;
    const lastRow = db
      .prepare('SELECT id, entry_hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { id: number; entry_hash: string };

    assert.equal(anchor.hashed_row_count, 3, 'hashed_row_count = 3 after three records');
    assert.equal(anchor.cutover_id, firstRow.id, 'cutover_id unchanged (still first row id)');
    assert.equal(anchor.last_id, lastRow.id, 'last_id is third row id');
    assert.equal(anchor.last_entry_hash, lastRow.entry_hash, 'last_entry_hash is third row entry_hash');
  });

  it('atomic rollback: anchor table failure rolls back the audit_log insert', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);

    audit.record({ action: 'baseline' });

    const beforeCount = (
      db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }
    ).n;
    const beforeAnchor = db
      .prepare('SELECT * FROM audit_chain_head WHERE id = 1')
      .get() as AnchorRow;

    // Inject a fault INSIDE the transaction using a BEFORE UPDATE trigger.
    // The trigger fires after the audit_log INSERT (which is already in flight
    // within the same BEGIN IMMEDIATE transaction) and causes the UPDATE to fail,
    // which rolls back the entire transaction — proving atomicity of both writes.
    // (A table-rename before record() would fail at prepare-time, before the
    //  transaction even starts, and would not test in-transaction rollback.)
    db.exec(`
      CREATE TRIGGER fail_anchor_update
      BEFORE UPDATE ON audit_chain_head
      BEGIN
        SELECT RAISE(FAIL, 'injected anchor failure for rollback test');
      END
    `);

    try {
      assert.throws(() => audit.record({ action: 'should_rollback' }), /injected anchor failure/);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_anchor_update');
    }

    const afterCount = (
      db.prepare('SELECT COUNT(*) as n FROM audit_log').get() as { n: number }
    ).n;
    const afterAnchor = db
      .prepare('SELECT * FROM audit_chain_head WHERE id = 1')
      .get() as AnchorRow;

    assert.equal(afterCount, beforeCount, 'audit_log row count unchanged after rollback');
    assert.deepEqual(afterAnchor, beforeAnchor, 'anchor unchanged after rollback');
  });

  it('busy_timeout pragma is >= 5000 on createDatabase', () => {
    const db = createDatabase(':memory:');
    const timeout = db.pragma('busy_timeout', { simple: true }) as number;
    assert.ok(timeout >= 5000, `busy_timeout should be >= 5000, got ${timeout}`);
  });

  it('contract_hash stays NULL after record()', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);

    audit.record({ action: 'test_contract_hash' });

    const row = db
      .prepare('SELECT contract_hash FROM audit_log ORDER BY id DESC LIMIT 1')
      .get() as { contract_hash: string | null };
    assert.equal(row.contract_hash, null, 'contract_hash must remain NULL');
  });
});

// ─── FR-11: AuditLog.verifyChain — anchor-aware (story-097-003) ───────────────

type RawAuditRow097 = {
  id:            number;
  agent_id:      string | null;
  action:        string;
  command:       string | null;
  allowed:       number | null;
  policy_rule:   string | null;
  detail:        string | null;
  timestamp:     string;
  prev_hash:     string | null;
  entry_hash:    string | null;
  contract_hash: string | null;
};

function allAuditRows(db: Database.Database): RawAuditRow097[] {
  return db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all() as RawAuditRow097[];
}

describe('AuditLog.verifyChain — known-answer vector (FR-11)', () => {
  it('computeEntryHash of a fixed literal payload equals the hardcoded sha256 constant', () => {
    // This pins the canonicalPayload format. If the format changes (field order,
    // serialisation, arity), this test catches it before chain verification breaks.
    const GENESIS = '0'.repeat(64);
    const payload = canonicalPayload(
      1, null, 'test_action', null, null, null, null, null,
      '2024-01-01T00:00:00.000Z', GENESIS
    );
    const actual = computeEntryHash(payload);
    const EXPECTED = '87a236da1324c9a8632ed27f2a1b3db223d4199c8bebb69e654df62f4f5e15bb';
    assert.equal(actual, EXPECTED, 'sha256 must match hardcoded constant — format drift detected');
    assert.equal(actual.length, 64, 'hash must be 64-char hex');
    assert.ok(/^[0-9a-f]+$/.test(actual), 'hash must be lowercase hex');
  });
});

describe('AuditLog.verifyChain — regression: existing checks unchanged (FR-11)', () => {
  it('editing a mid-chain row returns entry-hash-mismatch at that row id', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    for (let i = 0; i < 5; i++) audit.record({ action: `action_${i}` });

    const rows = allAuditRows(db);
    const targetId = rows[2].id;
    db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tampered', targetId);

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'entry-hash-mismatch', 'reason must be exact string entry-hash-mismatch');
    assert.equal(result.brokenAtId, targetId, 'brokenAtId must point to the tampered row');
  });

  it('deleting a MIDDLE hashed row returns broken-link at the successor id', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    for (let i = 0; i < 5; i++) audit.record({ action: `action_${i}` });

    const rows = allAuditRows(db);
    const deletedId = rows[2].id;
    const successorId = rows[3].id;
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(deletedId);

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'broken-link', 'reason must be exact string broken-link');
    assert.equal(result.brokenAtId, successorId, 'brokenAtId must be the successor of the deleted row');
  });
});

describe('AuditLog.verifyChain — content tamper exact reason (FR-11)', () => {
  it('changing detail without updating entry_hash returns entry-hash-mismatch (not a renamed reason)', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    audit.record({ action: 'original', detail: { x: 1 } });

    const rows = allAuditRows(db);
    db.prepare('UPDATE audit_log SET detail = ? WHERE id = ?')
      .run('{"x":999}', rows[0].id);

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'entry-hash-mismatch');
  });
});

describe('AuditLog.verifyChain — edit + local rehash caught at successor (FR-11)', () => {
  it('updating detail AND rehashing row 2 correctly exposes broken-link at row 3', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    audit.record({ action: 'row1' });
    audit.record({ action: 'row2', detail: { v: 'original' } });
    audit.record({ action: 'row3' });

    const rows = allAuditRows(db);
    const row2 = rows[1];
    const row3 = rows[2];

    // Recompute a "valid-looking" entry_hash for row2 with tampered detail,
    // keeping prev_hash unchanged — this makes row2 pass its own check but
    // breaks the chain at row3 (its prev_hash still points to the original H2).
    const tamperedDetail = '{"v":"tampered"}';
    const newPayload = canonicalPayload(
      row2.id, row2.agent_id, row2.action, row2.command,
      row2.allowed, row2.policy_rule, tamperedDetail,
      null, row2.timestamp, row2.prev_hash as string
    );
    const newHash = computeEntryHash(newPayload);

    db.prepare('UPDATE audit_log SET detail = ?, entry_hash = ? WHERE id = ?')
      .run(tamperedDetail, newHash, row2.id);

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'broken-link', 'successor row must detect the stale prev_hash');
    assert.equal(result.brokenAtId, row3.id, 'broken at row 3, not row 2');
  });
});

describe('AuditLog.verifyChain — tail truncation (FR-11)', () => {
  it('deleting the 2 newest hashed rows returns count-mismatch (anchor says 5, walked 3)', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    for (let i = 0; i < 5; i++) audit.record({ action: `row_${i}` });

    const rows = allAuditRows(db);
    // Delete last 2 rows
    db.prepare('DELETE FROM audit_log WHERE id IN (?, ?)').run(rows[3].id, rows[4].id);

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'count-mismatch');
    assert.equal(result.hashedRows, 3, 'walked 3 hashed rows after deletion');
  });
});

describe('AuditLog.verifyChain — head mismatch (FR-11)', () => {
  it('corrupting last_entry_hash in the anchor returns head-mismatch', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    for (let i = 0; i < 3; i++) audit.record({ action: `row_${i}` });

    db.prepare('UPDATE audit_chain_head SET last_entry_hash = ? WHERE id = 1')
      .run('dead'.repeat(16));  // 64-char fake hash

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'head-mismatch');
  });

  it('corrupting last_id in the anchor returns head-mismatch', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    for (let i = 0; i < 3; i++) audit.record({ action: `row_${i}` });

    db.prepare('UPDATE audit_chain_head SET last_id = 9999 WHERE id = 1').run();

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'head-mismatch');
  });
});

describe('AuditLog.verifyChain — null-in-chain (FR-11)', () => {
  it('NULL entry_hash row at id >= cutover_id returns null-in-chain at that id', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    audit.record({ action: 'first_hashed' });  // sets cutover_id

    // Insert a NULL-hash row after cutover — simulates a row that bypassed hashing.
    db.prepare("INSERT INTO audit_log (action) VALUES ('unhashed_post_cutover')").run();
    const rows = allAuditRows(db);
    const nullRowId = rows[rows.length - 1].id;

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'null-in-chain');
    assert.equal(result.brokenAtId, nullRowId, 'brokenAtId must be the NULL row');
  });
});

describe('AuditLog.verifyChain — legacy tolerated (FR-11)', () => {
  it('NULL entry_hash row at id < cutover_id is counted as legacy and chain is ok', () => {
    const db = createDatabase(':memory:');
    // Insert legacy row directly (entry_hash stays NULL, no anchor update).
    db.prepare("INSERT INTO audit_log (action) VALUES ('legacy_pre_cutover')").run();
    // Now record a hashed row — sets cutover_id to this row's id (> legacy row id).
    const audit = new AuditLog(db);
    audit.record({ action: 'first_hashed' });

    const result = audit.verifyChain();
    assert.equal(result.ok, true, 'legacy row before cutover must be tolerated');
    assert.equal(result.legacyRows, 1, 'legacy row counted');
    assert.equal(result.hashedRows, 1, 'hashed row counted');
  });
});

describe('AuditLog.verifyChain — missing anchor (FR-11)', () => {
  it('deleting the anchor row while hashed rows exist returns missing-anchor', () => {
    const db = createDatabase(':memory:');
    const audit = new AuditLog(db);
    audit.record({ action: 'some_action' });

    db.prepare('DELETE FROM audit_chain_head WHERE id = 1').run();

    const result = audit.verifyChain();
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-anchor');
  });

  it('absent anchor with no hashed rows is ok (empty chain)', () => {
    const db = createDatabase(':memory:');
    db.prepare('DELETE FROM audit_chain_head WHERE id = 1').run();

    const audit = new AuditLog(db);
    const result = audit.verifyChain();
    assert.equal(result.ok, true, 'empty chain without anchor is valid');
    assert.equal(result.hashedRows, 0);
  });
});

describe('AuditLog.verifyChain — sequential multi-handle writes produce linear chain (FR-11)', () => {
  // better-sqlite3 is synchronous; these writes are strictly sequential, not concurrent.
  // This test confirms the chain integrity invariant holds when two DB handles alternate
  // writes. It does NOT test locking or true concurrent access.
  it('alternating record() calls via two handles produce a verifiable linear chain', () => {
    const db1 = createDatabase(':memory:');
    // Verify the chain via a separate AuditLog instance pointing at the same DB.
    const audit1 = new AuditLog(db1);
    const audit2 = new AuditLog(db1);  // same in-memory DB

    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) {
        audit1.record({ action: `handle1_${i}` });
      } else {
        audit2.record({ action: `handle2_${i}` });
      }
    }

    const result = audit1.verifyChain();
    assert.equal(result.ok, true, 'linear chain must verify ok');
    assert.equal(result.hashedRows, 6, 'all 6 rows hashed');
  });
});
