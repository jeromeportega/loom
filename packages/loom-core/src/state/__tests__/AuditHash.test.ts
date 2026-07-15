/**
 * Tests for the audit hashing layer (epic-096 story-096-002):
 * - auditHash.ts pure functions
 * - AuditLog.record transaction (integration, real SQLite)
 * - AuditLog.verifyChain (integration, real SQLite)
 * - Concurrent write / linear chain invariant
 * - VerifyChainResult type export
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase } from '../Database.js';
import { AuditLog } from '../AuditLog.js';
import type { VerifyChainResult } from '../AuditLog.js';
import {
  AUDIT_GENESIS_HASH,
  canonicalPayload,
  computeEntryHash,
} from '../auditHash.js';
import type { AuditLogEntry } from '../../types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-audithash-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshDb(name: string): Database.Database {
  return createDatabase(path.join(tmpDir, `${name}.db`));
}

/** Insert a legacy row (NULL hashes) directly into audit_log. */
function insertLegacyRow(db: Database.Database, action: string): void {
  db.prepare(
    `INSERT INTO audit_log (action) VALUES (?)`
  ).run(action);
}

type RawRow = {
  id: number;
  prev_hash: string | null;
  entry_hash: string | null;
  contract_hash: string | null;
  action: string;
  timestamp: string;
  agent_id: string | null;
  command: string | null;
  allowed: number | null;
  policy_rule: string | null;
  detail: string | null;
};

function allRows(db: Database.Database): RawRow[] {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY id ASC')
    .all() as RawRow[];
}

// ─── auditHash.ts unit tests ──────────────────────────────────────────────────

describe('AUDIT_GENESIS_HASH', () => {
  it('is exactly 64 characters long', () => {
    assert.equal(AUDIT_GENESIS_HASH.length, 64);
  });

  it('consists entirely of "0" characters', () => {
    assert.ok(
      /^0+$/.test(AUDIT_GENESIS_HASH),
      'all chars should be "0"'
    );
  });
});

describe('canonicalPayload', () => {
  it('serialises exactly 10 elements in spec order', () => {
    const payload = canonicalPayload(
      1, 'agent-x', 'action_name', 'git status',
      1, 'rule', 'detail text',
      null, '2024-01-01T00:00:00', AUDIT_GENESIS_HASH
    );
    const parsed = JSON.parse(payload) as unknown[];
    assert.equal(parsed.length, 10, 'must have exactly 10 elements');
    assert.equal(parsed[0], 1,               'index 0: id');
    assert.equal(parsed[1], 'agent-x',       'index 1: agent_id');
    assert.equal(parsed[2], 'action_name',   'index 2: action');
    assert.equal(parsed[3], 'git status',    'index 3: command');
    assert.equal(parsed[4], 1,               'index 4: allowed');
    assert.equal(parsed[5], 'rule',          'index 5: policy_rule');
    assert.equal(parsed[6], 'detail text',   'index 6: detail');
    assert.equal(parsed[7], null,            'index 7: contract_hash (always null)');
    assert.equal(parsed[8], '2024-01-01T00:00:00', 'index 8: timestamp');
    assert.equal(parsed[9], AUDIT_GENESIS_HASH,     'index 9: prev_hash');
  });

  it('contract_hash at index 7 is always null regardless of call', () => {
    const payload = canonicalPayload(
      99, null, 'x', null, null, null, null, null, 'ts', '0'.repeat(64)
    );
    const parsed = JSON.parse(payload) as unknown[];
    assert.equal(parsed[7], null, 'contract_hash must always be null at index 7');
  });

  it('null values in other positions are preserved as JSON null', () => {
    const payload = canonicalPayload(
      5, null, 'act', null, null, null, null, null, 'ts', AUDIT_GENESIS_HASH
    );
    const parsed = JSON.parse(payload) as unknown[];
    assert.equal(parsed[1], null, 'agent_id null preserved');
    assert.equal(parsed[3], null, 'command null preserved');
    assert.equal(parsed[4], null, 'allowed null preserved');
    assert.equal(parsed[5], null, 'policy_rule null preserved');
    assert.equal(parsed[6], null, 'detail null preserved');
  });
});

describe('computeEntryHash', () => {
  it('returns a 64-character lowercase hex string', () => {
    const hash = computeEntryHash('some payload');
    assert.equal(hash.length, 64, 'hash must be 64 chars');
    assert.ok(/^[0-9a-f]+$/.test(hash), 'hash must be lowercase hex');
  });

  it('is deterministic — same payload yields same hash on repeated calls', () => {
    const payload = 'payload string';
    const h1 = computeEntryHash(payload);
    const h2 = computeEntryHash(payload);
    assert.equal(h1, h2, 'same input must produce same hash');
  });

  it('is sensitive — single-character difference yields different hash', () => {
    const h1 = computeEntryHash('payload-a');
    const h2 = computeEntryHash('payload-b');
    assert.notEqual(h1, h2, 'different payloads must produce different hashes');
  });
});

// ─── AuditLog.record integration tests ───────────────────────────────────────

describe('AuditLog.record — hash columns', () => {
  it('first call sets prev_hash = AUDIT_GENESIS_HASH and entry_hash is 64-char hex', () => {
    const db = freshDb('record-first');
    const log = new AuditLog(db);

    log.record({ action: 'guard_checked', command: 'git status' });

    const rows = allRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prev_hash, AUDIT_GENESIS_HASH, 'first row prev_hash = GENESIS');
    assert.ok(rows[0].entry_hash, 'entry_hash must be non-null');
    assert.equal(rows[0].entry_hash!.length, 64, 'entry_hash must be 64 chars');
    assert.ok(/^[0-9a-f]+$/.test(rows[0].entry_hash!), 'entry_hash must be lowercase hex');

    db.close();
  });

  it('second call prev_hash equals first row entry_hash (chain links)', () => {
    const db = freshDb('record-chain-link');
    const log = new AuditLog(db);

    log.record({ action: 'action_one' });
    log.record({ action: 'action_two' });

    const rows = allRows(db);
    assert.equal(rows.length, 2);
    assert.equal(
      rows[1].prev_hash,
      rows[0].entry_hash,
      'second row prev_hash must equal first row entry_hash'
    );
  });

  it('stored contract_hash in the DB row is NULL', () => {
    const db = freshDb('record-contract-null');
    const log = new AuditLog(db);

    log.record({ action: 'some_action' });

    const rows = allRows(db);
    assert.equal(rows[0].contract_hash, null, 'contract_hash must be NULL in DB');

    db.close();
  });

  it('entry_hash recomputed from stored row equals stored entry_hash (round-trip)', () => {
    const db = freshDb('record-roundtrip');
    const log = new AuditLog(db);

    log.record({ action: 'round_trip_test', command: 'git diff', allowed: true });

    const rows = allRows(db);
    const row = rows[0];
    assert.ok(row.prev_hash, 'prev_hash must be set');

    const payload = canonicalPayload(
      row.id,
      row.agent_id,
      row.action,
      row.command,
      row.allowed,
      row.policy_rule,
      row.detail,
      null,
      row.timestamp,
      row.prev_hash!
    );
    const recomputed = computeEntryHash(payload);

    assert.equal(recomputed, row.entry_hash, 'recomputed hash must match stored entry_hash');

    db.close();
  });

  it('stored id and timestamp are DB-assigned values used in hash computation', () => {
    const db = freshDb('record-id-timestamp');
    const log = new AuditLog(db);

    log.record({ action: 'ts_check' });

    const rows = allRows(db);
    const row = rows[0];

    assert.ok(row.id > 0, 'id must be DB-assigned positive integer');
    assert.ok(row.timestamp, 'timestamp must be non-null');

    const payload = canonicalPayload(
      row.id,
      row.agent_id,
      row.action,
      row.command,
      row.allowed,
      row.policy_rule,
      row.detail,
      null,
      row.timestamp,
      row.prev_hash!
    );
    const recomputed = computeEntryHash(payload);
    assert.equal(recomputed, row.entry_hash, 'hash uses DB id and timestamp');

    db.close();
  });
});

// ─── AuditLog.verifyChain integration tests ───────────────────────────────────

describe('AuditLog.verifyChain — empty table', () => {
  it('returns ok:true with zero counts and null ids', () => {
    const db = freshDb('verify-empty');
    const log = new AuditLog(db);

    const result = log.verifyChain();

    assert.equal(result.ok, true);
    assert.equal(result.hashedRows, 0);
    assert.equal(result.legacyRows, 0);
    assert.equal(result.fromId, null);
    assert.equal(result.toId, null);
    assert.equal(result.brokenAtId, undefined);
    assert.equal(result.reason, undefined);

    db.close();
  });
});

describe('AuditLog.verifyChain — only legacy rows', () => {
  it('returns ok:true with legacyRows=N and hashedRows=0', () => {
    const db = freshDb('verify-legacy-only');
    const log = new AuditLog(db);

    insertLegacyRow(db, 'legacy_action_1');
    insertLegacyRow(db, 'legacy_action_2');
    insertLegacyRow(db, 'legacy_action_3');

    const result = log.verifyChain();

    assert.equal(result.ok, true);
    assert.equal(result.legacyRows, 3);
    assert.equal(result.hashedRows, 0);
    assert.equal(result.fromId, null);
    assert.equal(result.toId, null);

    db.close();
  });
});

describe('AuditLog.verifyChain — intact hashed chain', () => {
  it('returns ok:true for a 5-row hashed chain with correct fromId and toId', () => {
    const db = freshDb('verify-intact');
    const log = new AuditLog(db);

    for (let i = 0; i < 5; i++) {
      log.record({ action: `action_${i}` });
    }

    const rows = allRows(db);
    const result = log.verifyChain();

    assert.equal(result.ok, true);
    assert.equal(result.hashedRows, 5);
    assert.equal(result.legacyRows, 0);
    assert.equal(result.fromId, rows[0].id);
    assert.equal(result.toId, rows[4].id);

    db.close();
  });
});

describe('AuditLog.verifyChain — mixed legacy and hashed rows', () => {
  it('3 legacy + 4 hashed → ok:true, correct counts', () => {
    const db = freshDb('verify-mixed');
    const log = new AuditLog(db);

    insertLegacyRow(db, 'legacy_1');
    insertLegacyRow(db, 'legacy_2');
    insertLegacyRow(db, 'legacy_3');
    for (let i = 0; i < 4; i++) {
      log.record({ action: `hashed_${i}` });
    }

    const result = log.verifyChain();

    assert.equal(result.ok, true);
    assert.equal(result.legacyRows, 3);
    assert.equal(result.hashedRows, 4);

    db.close();
  });

  it('legacy row interspersed among hashed rows never causes ok:false', () => {
    const db = freshDb('verify-legacy-interspersed');
    const log = new AuditLog(db);

    log.record({ action: 'hashed_before' });
    insertLegacyRow(db, 'legacy_middle');
    log.record({ action: 'hashed_after' });

    const result = log.verifyChain();
    assert.equal(result.ok, true, 'legacy rows between hashed rows must not cause failure');

    db.close();
  });
});

describe('AuditLog.verifyChain — tampered action field', () => {
  it('mutating action on hashed row 3 returns ok:false with correct brokenAtId', () => {
    const db = freshDb('verify-tamper-action');
    const log = new AuditLog(db);

    for (let i = 0; i < 5; i++) {
      log.record({ action: `action_${i}` });
    }

    const rows = allRows(db);
    const targetId = rows[2].id;

    db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('HACKED', targetId);

    const result = log.verifyChain();

    assert.equal(result.ok, false);
    assert.equal(result.brokenAtId, targetId, 'brokenAtId must point to the tampered row');
    assert.ok(result.reason && result.reason.length > 0, 'reason must be non-empty string');

    db.close();
  });
});

describe('AuditLog.verifyChain — tampered entry_hash', () => {
  it('mutating entry_hash of row 2 returns entry-hash-mismatch at row 2, not successor', () => {
    const db = freshDb('verify-tamper-hash');
    const log = new AuditLog(db);

    for (let i = 0; i < 5; i++) {
      log.record({ action: `action_${i}` });
    }

    const rows = allRows(db);
    const targetId = rows[1].id;
    const fakeHash = 'a'.repeat(64);

    db.prepare('UPDATE audit_log SET entry_hash = ? WHERE id = ?').run(fakeHash, targetId);

    const result = log.verifyChain();

    assert.equal(result.ok, false);
    assert.equal(result.brokenAtId, targetId, 'brokenAtId must be row 2, not its successor');
    assert.equal(result.reason, 'entry-hash-mismatch');

    db.close();
  });
});

describe('AuditLog.verifyChain — deleted middle row', () => {
  it('deleting row 3 of a 5-row chain returns broken-link at next surviving hashed row', () => {
    const db = freshDb('verify-delete-middle');
    const log = new AuditLog(db);

    for (let i = 0; i < 5; i++) {
      log.record({ action: `action_${i}` });
    }

    const rows = allRows(db);
    const deletedId = rows[2].id;
    const nextId = rows[3].id;

    db.prepare('DELETE FROM audit_log WHERE id = ?').run(deletedId);

    const result = log.verifyChain();

    assert.equal(result.ok, false);
    assert.equal(result.brokenAtId, nextId, 'brokenAtId must be row 4 (next after deleted row 3)');
    assert.equal(result.reason, 'broken-link');

    db.close();
  });
});

describe('AuditLog.verifyChain — return shape completeness', () => {
  it('ok:true result always has ok, hashedRows, legacyRows, fromId, toId', () => {
    const db = freshDb('verify-shape-ok');
    const log = new AuditLog(db);
    log.record({ action: 'x' });

    const result = log.verifyChain();

    assert.ok('ok'         in result, 'ok key must be present');
    assert.ok('hashedRows' in result, 'hashedRows key must be present');
    assert.ok('legacyRows' in result, 'legacyRows key must be present');
    assert.ok('fromId'     in result, 'fromId key must be present');
    assert.ok('toId'       in result, 'toId key must be present');

    db.close();
  });

  it('ok:false result also carries brokenAtId and reason', () => {
    const db = freshDb('verify-shape-broken');
    const log = new AuditLog(db);
    log.record({ action: 'x' });

    const rows = allRows(db);
    db.prepare('UPDATE audit_log SET action = ? WHERE id = ?').run('tampered', rows[0].id);

    const result = log.verifyChain();

    assert.equal(result.ok, false);
    assert.ok('brokenAtId' in result, 'brokenAtId key must be present when ok:false');
    assert.ok('reason'     in result, 'reason key must be present when ok:false');
    assert.ok(result.reason, 'reason must be truthy when ok:false');

    db.close();
  });
});

// ─── Concurrent write test ─────────────────────────────────────────────────────

describe('AuditLog.record — concurrent writes via two DB handles', () => {
  it('alternating record() calls produce a linear chain with no forks', () => {
    const dbPath = path.join(tmpDir, 'concurrent.db');
    createDatabase(dbPath);

    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    db1.pragma('busy_timeout = 5000');
    const log1 = new AuditLog(db1);

    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');
    db2.pragma('busy_timeout = 5000');
    const log2 = new AuditLog(db2);

    const N = 6;
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) {
        log1.record({ action: `from_handle_1_${i}` });
      } else {
        log2.record({ action: `from_handle_2_${i}` });
      }
    }

    const db = new Database(dbPath);
    const rows = db.prepare(
      'SELECT id, prev_hash, entry_hash FROM audit_log ORDER BY id ASC'
    ).all() as { id: number; prev_hash: string | null; entry_hash: string | null }[];

    assert.equal(rows.length, N, `must have ${N} rows`);

    let prevHash = AUDIT_GENESIS_HASH;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      assert.equal(
        row.prev_hash,
        prevHash,
        `row ${i + 1} (id=${row.id}) prev_hash must equal predecessor entry_hash`
      );
      assert.ok(row.entry_hash, `row ${i + 1} must have entry_hash`);
      prevHash = row.entry_hash!;
    }

    db1.close();
    db2.close();
    db.close();
  });
});

// ─── Type export tests ─────────────────────────────────────────────────────────

describe('VerifyChainResult type export', () => {
  it('VerifyChainResult is importable and satisfiable from state/index.ts', () => {
    const good: VerifyChainResult = {
      ok: true,
      hashedRows: 3,
      legacyRows: 1,
      fromId: 1,
      toId: 3,
    };
    assert.equal(good.ok, true);

    const broken: VerifyChainResult = {
      ok: false,
      hashedRows: 2,
      legacyRows: 0,
      fromId: 1,
      toId: 2,
      brokenAtId: 2,
      reason: 'entry-hash-mismatch',
    };
    assert.equal(broken.ok, false);
  });
});

describe('AuditLogEntry optional hash fields', () => {
  it('AuditLogEntry accepts prev_hash, entry_hash, contract_hash as optional', () => {
    const entry: AuditLogEntry = {
      id: 1,
      agent_id: null,
      action: 'test',
      command: null,
      allowed: null,
      policy_rule: null,
      detail: null,
      timestamp: '2024-01-01',
      prev_hash: AUDIT_GENESIS_HASH,
      entry_hash: 'a'.repeat(64),
      contract_hash: null,
    };
    assert.equal(entry.prev_hash, AUDIT_GENESIS_HASH);
    assert.equal(entry.entry_hash!.length, 64);
    assert.equal(entry.contract_hash, null);
  });

  it('AuditLogEntry without hash fields is still valid (optional)', () => {
    const entry: AuditLogEntry = {
      id: 2,
      agent_id: null,
      action: 'legacy',
      command: null,
      allowed: null,
      policy_rule: null,
      detail: null,
      timestamp: '2024-01-01',
    };
    assert.equal(entry.prev_hash, undefined);
    assert.equal(entry.entry_hash, undefined);
  });
});
