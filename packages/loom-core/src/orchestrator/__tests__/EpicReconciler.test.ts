import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicReconciler } from '../EpicReconciler.js';
import type { ReconcileRefusalReason } from '../EpicReconciler.js';

// ─── story-008-003 ───────────────────────────────────────────────────────────
// Integration tests for EpicReconciler against a real in-memory SQLite DB.
// Verification tools (gh/git) are stubbed via injectable gitBin/ghBin options
// pointing at canned shell scripts — no network, no real gh/git.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reconciler-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshDb(epicId = 'epic-003') {
  const db = createDatabase(':memory:');
  const store = new EpicStore(db);
  store.create(epicId, `Test Epic ${epicId}`);
  store.updateStatus(epicId, 'in_progress');
  return { db, store, audit: new AuditLog(db) };
}

/** Writes a shell script stub to tmpDir and returns its path. */
function stub(body: string): string {
  const p = path.join(tmpDir, `stub-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** gh stub: emits JSON on stdout then exits.
 *  JSON is written to a temp file to avoid shell quoting of arbitrary data. */
function ghOk(state: string, head: string, base: string): string {
  const json = JSON.stringify({ state, headRefName: head, baseRefName: base });
  const jsonFile = path.join(tmpDir, `gh-response-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jsonFile, json);
  return stub(`cat "${jsonFile}"`);
}

/** gh stub that exits non-zero (simulates offline / API error). */
function ghFail(code = 1): string {
  return stub(`exit ${code}`);
}

/** git stub: handles rev-parse (ok) and merge-base (ok). */
function gitMerged(): string {
  return stub('exit 0');
}

/** git stub: rev-parse exits 0 (branch exists), merge-base exits 1 (not ancestor). */
function gitNotAncestor(): string {
  return stub('if [ "$1" = "rev-parse" ]; then exit 0; fi\nexit 1');
}

/** git stub: always exits 1 — simulates missing branch (rev-parse fails). */
function gitNoBranch(): string {
  return stub('exit 1');
}

/** A path that does not exist — execFileSync throws ENOENT. */
function missingBin(): string {
  return path.join(tmpDir, 'does-not-exist-binary');
}

function reconciler(db: ReturnType<typeof createDatabase>, overrides: { gitBin?: string; ghBin?: string } = {}) {
  return new EpicReconciler({ projectRoot: tmpDir, db, ...overrides });
}

// ─── PR-URL path ─────────────────────────────────────────────────────────────

describe('PR-URL path', () => {
  it('[Happy] gh returns MERGED with matching refs → reconciled, epic done with epic_pr_url set', () => {
    const { db, store, audit } = freshDb();
    const prUrl = 'https://github.com/org/repo/pull/6';

    const result = reconciler(db, {
      ghBin: ghOk('MERGED', 'epic/epic-003', 'main'),
    }).reconcile('epic-003', { prUrl });

    assert.equal(result.status, 'reconciled');
    assert.equal(result.epicId, 'epic-003');
    assert.equal(result.prUrl, prUrl);
    assert.equal(result.reason, undefined);

    const epic = store.get('epic-003')!;
    assert.equal(epic.status, 'done');
    assert.equal(epic.epic_pr_url, prUrl);

    const rows = audit.getByCommand('epic-003', ['epic_reconciled']);
    assert.equal(rows.length, 1, 'epic_reconciled audit row must exist');
  });

  it('[Refuse] state !== MERGED → refused/not_merged, epic stays non-done', () => {
    const { db, store } = freshDb();
    const prUrl = 'https://github.com/org/repo/pull/6';

    const result = reconciler(db, {
      ghBin: ghOk('OPEN', 'epic/epic-003', 'main'),
    }).reconcile('epic-003', { prUrl });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'not_merged' satisfies ReconcileRefusalReason);
    assert.equal(store.get('epic-003')!.status, 'in_progress', 'epic must not be done');
  });

  it('[Refuse] state=MERGED but headRefName mismatch → refused/ref_mismatch', () => {
    const { db, store } = freshDb();
    const prUrl = 'https://github.com/org/repo/pull/6';

    const result = reconciler(db, {
      ghBin: ghOk('MERGED', 'epic/other-epic', 'main'),
    }).reconcile('epic-003', { prUrl });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'ref_mismatch' satisfies ReconcileRefusalReason);
    assert.equal(store.get('epic-003')!.epic_pr_url, null, 'epic_pr_url must not be set');
  });

  it('[Refuse] state=MERGED but baseRefName mismatch → refused/ref_mismatch', () => {
    const { db, store } = freshDb();
    const prUrl = 'https://github.com/org/repo/pull/6';

    const result = reconciler(db, {
      ghBin: ghOk('MERGED', 'epic/epic-003', 'dev'),
    }).reconcile('epic-003', { prUrl });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'ref_mismatch' satisfies ReconcileRefusalReason);
    assert.equal(store.get('epic-003')!.status, 'in_progress');
  });

  it('[Fail-closed] gh binary missing (ENOENT) → refused/tool_unavailable (distinct from not_merged)', () => {
    const { db, store } = freshDb();

    const result = reconciler(db, { ghBin: missingBin() }).reconcile('epic-003', {
      prUrl: 'https://github.com/org/repo/pull/6',
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'tool_unavailable' satisfies ReconcileRefusalReason);
    assert.notEqual(result.reason, 'not_merged', 'offline reason must be distinct from not_merged');
    assert.equal(store.get('epic-003')!.status, 'in_progress', 'epic must stay non-done');
  });

  it('[Fail-closed] gh exits non-zero → refused/unverifiable_offline (distinct from tool_unavailable)', () => {
    const { db, store } = freshDb();

    const result = reconciler(db, { ghBin: ghFail(1) }).reconcile('epic-003', {
      prUrl: 'https://github.com/org/repo/pull/6',
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'unverifiable_offline' satisfies ReconcileRefusalReason);
    assert.notEqual(result.reason, 'tool_unavailable', 'non-zero exit is offline, not tool_unavailable');
    assert.equal(store.get('epic-003')!.status, 'in_progress');
  });
});

// ─── Ancestry path ───────────────────────────────────────────────────────────

describe('ancestry path (no prUrl)', () => {
  it('[Happy] branch exists and is ancestor of main → reconciled, epic done', () => {
    const { db, store, audit } = freshDb();

    const result = reconciler(db, { gitBin: gitMerged() }).reconcile('epic-003');

    assert.equal(result.status, 'reconciled');
    assert.equal(result.epicId, 'epic-003');
    assert.equal(result.reason, undefined);

    const epic = store.get('epic-003')!;
    assert.equal(epic.status, 'done');

    const rows = audit.getByCommand('epic-003', ['epic_reconciled']);
    assert.equal(rows.length, 1, 'epic_reconciled audit row must exist');
    const detail = JSON.parse(rows[0].detail!) as Record<string, unknown>;
    assert.equal(detail.path, 'ancestry');
    assert.equal(detail.verified_via, 'git merge-base');
  });

  it('[Refuse] branch does not exist → refused/no_epic_branch', () => {
    const { db, store } = freshDb();

    const result = reconciler(db, { gitBin: gitNoBranch() }).reconcile('epic-003');

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'no_epic_branch' satisfies ReconcileRefusalReason);
    assert.equal(store.get('epic-003')!.status, 'in_progress');
  });

  it('[Refuse + hint] branch exists but not ancestor → refused/not_merged with --pr <url> squash hint', () => {
    const { db, store } = freshDb();

    const result = reconciler(db, { gitBin: gitNotAncestor() }).reconcile('epic-003');

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'not_merged' satisfies ReconcileRefusalReason);
    assert.ok(result.note.includes('--pr <url>'), `note must contain "--pr <url>" hint, got: ${result.note}`);
    assert.equal(store.get('epic-003')!.status, 'in_progress');
  });

  it('[Fail-closed] git binary missing → refused/tool_unavailable, epic stays non-done', () => {
    const { db, store } = freshDb();

    const result = reconciler(db, { gitBin: missingBin() }).reconcile('epic-003');

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'tool_unavailable' satisfies ReconcileRefusalReason);
    assert.equal(store.get('epic-003')!.status, 'in_progress');
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('[Noop] epic already status=done → noop, no verification call', () => {
    const { db, store } = freshDb();
    store.updateStatus('epic-003', 'done');

    // Pass a failing stub — if reconcile() tries to call it, the test will
    // return refused (not noop), catching the bug.
    const result = reconciler(db, { ghBin: missingBin(), gitBin: missingBin() }).reconcile('epic-003', {
      prUrl: 'https://github.com/org/repo/pull/6',
    });

    assert.equal(result.status, 'noop');
    assert.equal(result.reason, undefined);
  });

  it('[Noop] epic has non-null epic_pr_url (not yet done) → noop, no re-record', () => {
    const { db, store, audit } = freshDb();
    const existingUrl = 'https://github.com/org/repo/pull/5';
    store.recordPrUrl('epic-003', existingUrl);

    const rowsBefore = audit.getByCommand('epic-003', ['epic_reconciled']).length;

    const result = reconciler(db, { ghBin: missingBin() }).reconcile('epic-003', {
      prUrl: 'https://github.com/org/repo/pull/6',
    });

    assert.equal(result.status, 'noop');
    assert.equal(store.get('epic-003')!.epic_pr_url, existingUrl, 'existing URL must not be overwritten');
    assert.equal(
      audit.getByCommand('epic-003', ['epic_reconciled']).length,
      rowsBefore,
      'no new audit row on noop'
    );
  });

  it('[Refuse] unknown epic id → refused/epic_not_found', () => {
    const { db } = freshDb();

    const result = reconciler(db, { ghBin: missingBin() }).reconcile('epic-999');

    assert.equal(result.status, 'refused');
    assert.equal(result.reason, 'epic_not_found' satisfies ReconcileRefusalReason);
  });
});

// ─── Ordered write (FR-9) ────────────────────────────────────────────────────

describe('ordered write', () => {
  it('PR-URL path: recordPrUrl → clearFinalizePhase → audit(epic_reconciled) → updateStatus(done)', () => {
    const { db, store } = freshDb();
    // Seed a finalize_phase so clearFinalizePhase is observable
    store.updateFinalizePhase('epic-003', 'gate');

    const log: string[] = [];

    const origRecordPrUrl = EpicStore.prototype.recordPrUrl;
    const origClear = EpicStore.prototype.clearFinalizePhase;
    const origUpdateStatus = EpicStore.prototype.updateStatus;
    const origRecord = AuditLog.prototype.record;

    EpicStore.prototype.recordPrUrl = function (id, url) {
      log.push('recordPrUrl');
      origRecordPrUrl.call(this, id, url);
    };
    EpicStore.prototype.clearFinalizePhase = function (id) {
      log.push('clearFinalizePhase');
      origClear.call(this, id);
    };
    EpicStore.prototype.updateStatus = function (id, status, reason?) {
      log.push(`updateStatus:${status}`);
      origUpdateStatus.call(this, id, status, reason);
    };
    AuditLog.prototype.record = function (entry) {
      if (entry.action === 'epic_reconciled') log.push('audit:epic_reconciled');
      origRecord.call(this, entry);
    };

    try {
      const prUrl = 'https://github.com/org/repo/pull/6';
      const result = reconciler(db, {
        ghBin: ghOk('MERGED', 'epic/epic-003', 'main'),
      }).reconcile('epic-003', { prUrl });
      assert.equal(result.status, 'reconciled');
    } finally {
      EpicStore.prototype.recordPrUrl = origRecordPrUrl;
      EpicStore.prototype.clearFinalizePhase = origClear;
      EpicStore.prototype.updateStatus = origUpdateStatus;
      AuditLog.prototype.record = origRecord;
    }

    assert.deepEqual(log, [
      'recordPrUrl',
      'clearFinalizePhase',
      'audit:epic_reconciled',
      'updateStatus:done',
    ]);

    // epic_pr_url durable before done: the write log proves recordPrUrl came
    // first, and the DB reflects the final consistent state.
    const epic = store.get('epic-003')!;
    assert.equal(epic.status, 'done');
    assert.ok(epic.epic_pr_url != null, 'epic_pr_url must be set');
    assert.equal(epic.finalize_phase, null, 'finalize_phase must be cleared');

    // Audit row written before reconcile() returned
    const rows = new AuditLog(db).getByCommand('epic-003', ['epic_reconciled']);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail!) as Record<string, unknown>;
    assert.equal(detail.path, 'pr-url');
    assert.equal(detail.verified_via, 'gh pr view');
    assert.equal(detail.head_ref, 'epic/epic-003');
    assert.equal(detail.base_ref, 'main');
  });

  it('ancestry path: clearFinalizePhase → audit(epic_reconciled) → updateStatus(done)', () => {
    const { db, store } = freshDb();
    store.updateFinalizePhase('epic-003', 'gate');

    const log: string[] = [];

    const origClear = EpicStore.prototype.clearFinalizePhase;
    const origUpdateStatus = EpicStore.prototype.updateStatus;
    const origRecord = AuditLog.prototype.record;

    EpicStore.prototype.clearFinalizePhase = function (id) {
      log.push('clearFinalizePhase');
      origClear.call(this, id);
    };
    EpicStore.prototype.updateStatus = function (id, status, reason?) {
      log.push(`updateStatus:${status}`);
      origUpdateStatus.call(this, id, status, reason);
    };
    AuditLog.prototype.record = function (entry) {
      if (entry.action === 'epic_reconciled') log.push('audit:epic_reconciled');
      origRecord.call(this, entry);
    };

    try {
      const result = reconciler(db, { gitBin: gitMerged() }).reconcile('epic-003');
      assert.equal(result.status, 'reconciled');
    } finally {
      EpicStore.prototype.clearFinalizePhase = origClear;
      EpicStore.prototype.updateStatus = origUpdateStatus;
      AuditLog.prototype.record = origRecord;
    }

    assert.deepEqual(log, ['clearFinalizePhase', 'audit:epic_reconciled', 'updateStatus:done']);

    const epic = store.get('epic-003')!;
    assert.equal(epic.status, 'done');
    assert.equal(epic.finalize_phase, null);
  });
});

// ─── EpicStore.clearFinalizePhase unit test ──────────────────────────────────

describe('EpicStore.clearFinalizePhase', () => {
  it('sets finalize_phase=NULL without touching status', () => {
    const db = createDatabase(':memory:');
    const store = new EpicStore(db);
    store.create('epic-001', 'Test Epic');
    store.updateStatus('epic-001', 'finalizing');
    store.updateFinalizePhase('epic-001', 'gate');

    const before = store.get('epic-001')!;
    assert.equal(before.finalize_phase, 'gate');
    assert.equal(before.status, 'finalizing');

    store.clearFinalizePhase('epic-001');

    const after = store.get('epic-001')!;
    assert.equal(after.finalize_phase, null, 'finalize_phase must be NULL');
    assert.equal(after.status, 'finalizing', 'status must not change');
  });

  it('is idempotent when finalize_phase is already NULL', () => {
    const db = createDatabase(':memory:');
    const store = new EpicStore(db);
    store.create('epic-001', 'Test Epic');

    assert.doesNotThrow(() => store.clearFinalizePhase('epic-001'));
    assert.equal(store.get('epic-001')!.finalize_phase, null);
  });
});

// ─── No false done — exhaustive refusal coverage ─────────────────────────────

describe('no false done in any refusal case', () => {
  const refusalCases: Array<{
    label: string;
    setup: (store: EpicStore) => void;
    runReconcile: (r: EpicReconciler) => ReturnType<EpicReconciler['reconcile']>;
    ghBin?: () => string;
    gitBin?: () => string;
  }> = [
    {
      label: 'PR-URL: not merged',
      setup: () => {},
      runReconcile: (r) =>
        r.reconcile('epic-003', { prUrl: 'https://github.com/org/repo/pull/6' }),
      ghBin: () => ghOk('OPEN', 'epic/epic-003', 'main'),
    },
    {
      label: 'PR-URL: ref mismatch',
      setup: () => {},
      runReconcile: (r) =>
        r.reconcile('epic-003', { prUrl: 'https://github.com/org/repo/pull/6' }),
      ghBin: () => ghOk('MERGED', 'epic/other', 'main'),
    },
    {
      label: 'PR-URL: gh missing',
      setup: () => {},
      runReconcile: (r) =>
        r.reconcile('epic-003', { prUrl: 'https://github.com/org/repo/pull/6' }),
      ghBin: () => missingBin(),
    },
    {
      label: 'PR-URL: gh offline',
      setup: () => {},
      runReconcile: (r) =>
        r.reconcile('epic-003', { prUrl: 'https://github.com/org/repo/pull/6' }),
      ghBin: () => ghFail(1),
    },
    {
      label: 'ancestry: no branch',
      setup: () => {},
      runReconcile: (r) => r.reconcile('epic-003'),
      gitBin: () => gitNoBranch(),
    },
    {
      label: 'ancestry: not ancestor',
      setup: () => {},
      runReconcile: (r) => r.reconcile('epic-003'),
      gitBin: () => gitNotAncestor(),
    },
    {
      label: 'ancestry: git missing',
      setup: () => {},
      runReconcile: (r) => r.reconcile('epic-003'),
      gitBin: () => missingBin(),
    },
    {
      label: 'unknown epic',
      setup: () => {},
      runReconcile: (r) => r.reconcile('epic-999'),
      ghBin: () => missingBin(),
    },
  ];

  for (const tc of refusalCases) {
    it(`never sets done for: ${tc.label}`, () => {
      const { db, store } = freshDb();
      tc.setup(store);

      const r = new EpicReconciler({
        projectRoot: tmpDir,
        db,
        ghBin: tc.ghBin?.(),
        gitBin: tc.gitBin?.(),
      });
      const result = tc.runReconcile(r);

      assert.notEqual(result.status, 'reconciled', `must not reconcile: ${tc.label}`);
      // The epic that exists must not be done
      const epic = store.get('epic-003');
      if (epic) {
        assert.notEqual(epic.status, 'done', `epic must not be done after refusal: ${tc.label}`);
      }
    });
  }
});
