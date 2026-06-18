import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicFinalizer,
  AuditLog,
  EpicStore,
} from '../index.js';
import type { IntegrationGate } from '../orchestrator/IntegrationGate.js';

// ─── story-005-001: finalizeRef naming helper ──────────────────────────────
// `finalizeRef` is private but is a pure function with no side effects.
// We test it by accessing it through the class instance.

describe('EpicFinalizer.finalizeRef — naming helper (story-005-001)', () => {
  let loomDirForRefTests: string;
  let dbForRefTests: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    resetDatabaseForTest();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ref-'));
    loomDirForRefTests = path.join(tmp, '.loom');
    fs.mkdirSync(loomDirForRefTests, { recursive: true });
    dbForRefTests = openDatabase(loomDirForRefTests);
  });

  afterEach(() => {
    resetDatabaseForTest();
  });

  function makeMinimalFinalizer(): EpicFinalizer {
    return new EpicFinalizer({
      projectRoot: loomDirForRefTests,
      db: dbForRefTests,
      allowedRemotes: [],
      prStrategy: 'per-epic',
    });
  }

  function callFinalizeRef(epicId: string, integratedHead: string): string {
    const f = makeMinimalFinalizer();
    return (f as unknown as { finalizeRef(a: string, b: string): string }).finalizeRef(
      epicId,
      integratedHead
    );
  }

  it('returns the expected deterministic ref name with 7-char sha prefix', () => {
    const ref = callFinalizeRef('epic-005', '1a2b3c4dabc1234');
    assert.equal(ref, 'loom/finalize/epic-005-1a2b3c4');
  });

  it('slices exactly 7 chars regardless of sha length', () => {
    assert.equal(
      callFinalizeRef('epic-001', 'abcdef1234567890abcdef'),
      'loom/finalize/epic-001-abcdef1'
    );
    assert.equal(
      callFinalizeRef('epic-001', 'deadbeef'),
      'loom/finalize/epic-001-deadbee'
    );
  });

  it('determinism: identical (epicId, integratedHead) always produces the same ref', () => {
    const head = 'deadbeef1234567abc';
    const r1 = callFinalizeRef('epic-001', head);
    const r2 = callFinalizeRef('epic-001', head);
    assert.equal(r1, r2);
  });

  it('collision-proof: different epicId with the same head sha produces a different ref', () => {
    const head = 'deadbeef1234567abc';
    const r1 = callFinalizeRef('epic-001', head);
    const r2 = callFinalizeRef('epic-002', head);
    assert.notEqual(r1, r2);
    assert.ok(r1.includes('epic-001'), `r1 embeds the epicId: ${r1}`);
    assert.ok(r2.includes('epic-002'), `r2 embeds the epicId: ${r2}`);
  });

  it('collision-proof: same epic but different integratedHead sha produces a different ref', () => {
    const r1 = callFinalizeRef('epic-001', 'aaaaaaa1234567abc');
    const r2 = callFinalizeRef('epic-001', 'bbbbbbb1234567abc');
    assert.notEqual(r1, r2);
    assert.ok(r1.endsWith('-aaaaaaa'), `r1 embeds head slice: ${r1}`);
    assert.ok(r2.endsWith('-bbbbbbb'), `r2 embeds head slice: ${r2}`);
  });

  it('collision-proof: two concurrent epics with equal sha never produce the same ref', () => {
    const sameHead = 'c0ffee1234567abc';
    assert.notEqual(
      callFinalizeRef('epic-100', sameHead),
      callFinalizeRef('epic-101', sameHead)
    );
  });

  it('ref starts with loom/finalize/', () => {
    const ref = callFinalizeRef('epic-007', '1234567abcdef');
    assert.ok(ref.startsWith('loom/finalize/'), `expected loom/finalize/ prefix: ${ref}`);
  });
});

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-epf-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});
afterEach(() => {
  resetDatabaseForTest();
});

/**
 * Test-only access to the private `rebindLatebound` so we can exercise the
 * multi-call behavior without spinning up a git repo + epic YAML for a
 * full `finalize()` invocation. The bug we're verifying is in this method
 * alone, so probing it directly is the lightest test that locks the fix.
 */
function rebind(finalizer: EpicFinalizer, epicId: string, audit: AuditLog): void {
  (finalizer as unknown as {
    rebindLatebound: (epicId: string, audit: AuditLog) => void;
  }).rebindLatebound(epicId, audit);
}

const stubGate = {} as IntegrationGate;

describe('EpicFinalizer.rebindLatebound — multi-epic spurious rebind regression (PR #57 P2)', () => {
  it('fires epic_policy_rebound ONCE when the live policy changes once, not per-epic', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'one');
    new EpicStore(db).create('epic-002', 'two');
    const audit = new AuditLog(db);
    let liveTestCommand = 'original';
    const finalizer = new EpicFinalizer({
      projectRoot: loomDir,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      testCommand: 'original',
      gate: stubGate,
      refreshPolicy: () => ({ testCommand: liveTestCommand }),
    });

    // First epic's finalize-entry: live differs from opts.testCommand,
    // a rebind row fires.
    liveTestCommand = 'updated';
    rebind(finalizer, 'epic-001', audit);
    const firstRows = audit.getByCommand('epic-001', ['epic_policy_rebound']);
    assert.equal(firstRows.length, 1, 'first epic sees the change → one rebind row');
    const detail = JSON.parse(firstRows[0].detail ?? '{}');
    assert.equal(detail.changes.test_command.from, 'original');
    assert.equal(detail.changes.test_command.to, 'updated');

    // Second epic's finalize-entry: live still 'updated', effective is now
    // 'updated' too. Pre-fix this fired another rebind row because the
    // comparison was against the immutable `opts.testCommand`. Post-fix it's
    // a no-op.
    rebind(finalizer, 'epic-002', audit);
    const secondRows = audit.getByCommand('epic-002', ['epic_policy_rebound']);
    assert.equal(
      secondRows.length,
      0,
      'second epic sees no change → no spurious rebind row'
    );
  });

  it('fires a SECOND rebind row when the operator changes test_command again mid-run', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'one');
    new EpicStore(db).create('epic-002', 'two');
    const audit = new AuditLog(db);
    let liveTestCommand: string | undefined = 'a';
    const finalizer = new EpicFinalizer({
      projectRoot: loomDir,
      db,
      allowedRemotes: [],
      prStrategy: 'per-epic',
      testCommand: 'a',
      gate: stubGate,
      refreshPolicy: () => ({ testCommand: liveTestCommand }),
    });

    liveTestCommand = 'b';
    rebind(finalizer, 'epic-001', audit);
    assert.equal(audit.getByCommand('epic-001', ['epic_policy_rebound']).length, 1);

    liveTestCommand = 'c';
    rebind(finalizer, 'epic-002', audit);
    const rows = audit.getByCommand('epic-002', ['epic_policy_rebound']);
    assert.equal(rows.length, 1, 'genuine subsequent change → one new rebind row');
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(
      detail.changes.test_command.from,
      'b',
      'tracks the effective value, not opts.testCommand'
    );
    assert.equal(detail.changes.test_command.to, 'c');
  });
});
