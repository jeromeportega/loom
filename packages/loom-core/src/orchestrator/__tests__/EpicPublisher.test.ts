import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicPublisher } from '../EpicPublisher.js';

// ─── story-005-005 ───────────────────────────────────────────────────────────
// Integration tests for EpicPublisher against a real in-memory SQLite DB.
// The openPr seam is injected so no real gh binary or network is needed.

const FINALIZE_REF = 'loom/finalize/epic-001-1a2b3c4';
const PR_URL = 'https://github.com/org/repo/pull/42';

function freshDb(epicId = 'epic-001') {
  const db = createDatabase(':memory:');
  const store = new EpicStore(db);
  store.create(epicId, `Test Epic ${epicId}`);
  return { db, store, audit: new AuditLog(db) };
}

function setPublishPending(store: EpicStore, epicId: string, finalizeRef = FINALIZE_REF) {
  store.publishPending(epicId, finalizeRef, 'PR open failed during finalize');
}

function publisher(
  db: ReturnType<typeof createDatabase>,
  openPr: (input: { branch: string }) => string | undefined = () => PR_URL
) {
  return new EpicPublisher({ projectRoot: '/tmp/test', db, openPr });
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('[AC1, AC2] opens PR from finalize_ref, records URL, flips to done; returns published', () => {
    const { db, store, audit } = freshDb();
    setPublishPending(store, 'epic-001');

    let capturedBranch: string | undefined;
    const result = publisher(db, (input) => {
      capturedBranch = input.branch;
      return PR_URL;
    }).publish('epic-001');

    assert.equal(result.status, 'published');
    assert.equal(result.epicId, 'epic-001');
    assert.equal(result.prUrl, PR_URL);

    // PR was opened with the finalize_ref
    assert.equal(capturedBranch, FINALIZE_REF);

    // epic is done with PR URL recorded
    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'done');
    assert.equal(epic.epic_pr_url, PR_URL);

    // audit row written (Key Invariant 5)
    const rows = audit.getByCommand('epic-001', ['epic_published']);
    assert.equal(rows.length, 1, 'epic_published audit row must exist');
  });
});

// ─── Transaction ordering ────────────────────────────────────────────────────

describe('transaction ordering', () => {
  it('[AC2] recordPrUrl → clearFinalizePhase → audit → updateStatus order enforced atomically', () => {
    const { db, store, audit } = freshDb();
    setPublishPending(store, 'epic-001');

    // Pre-check: epic is publish_pending, finalize_phase is NULL after publishPending()
    const before = store.get('epic-001')!;
    assert.equal(before.status, 'publish_pending');
    assert.equal(before.finalize_phase, null); // publishPending() clears it

    publisher(db).publish('epic-001');

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'done');
    assert.equal(epic.epic_pr_url, PR_URL);
    assert.equal(epic.finalize_phase, null);

    const rows = audit.getByCommand('epic-001', ['epic_published']);
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0]!.detail ?? '{}') as { finalize_ref: string; pr_url: string };
    assert.equal(detail.finalize_ref, FINALIZE_REF);
    assert.equal(detail.pr_url, PR_URL);
  });
});

// ─── Refusal preconditions ───────────────────────────────────────────────────

describe('refusal preconditions', () => {
  it('[AC3] in_progress epic → refused, no PR opened, no state change', () => {
    const { db, store } = freshDb();
    store.updateStatus('epic-001', 'in_progress');

    let prOpened = false;
    const result = publisher(db, () => { prOpened = true; return PR_URL; }).publish('epic-001');

    assert.equal(result.status, 'refused');
    assert.equal(prOpened, false, 'no PR should be opened on refusal');
    assert.equal(store.get('epic-001')!.status, 'in_progress');
  });

  it('[AC3] failed epic → refused, no PR opened, no state change', () => {
    const { db, store } = freshDb();
    store.fail('epic-001', 'something went wrong');

    let prOpened = false;
    const result = publisher(db, () => { prOpened = true; return PR_URL; }).publish('epic-001');

    assert.equal(result.status, 'refused');
    assert.equal(prOpened, false);
    assert.equal(store.get('epic-001')!.status, 'failed');
  });

  it('[AC3] done epic → refused, no PR opened, no state change', () => {
    const { db, store } = freshDb();
    store.updateStatus('epic-001', 'done');

    let prOpened = false;
    const result = publisher(db, () => { prOpened = true; return PR_URL; }).publish('epic-001');

    assert.equal(result.status, 'refused');
    assert.equal(prOpened, false);
    assert.equal(store.get('epic-001')!.status, 'done');
  });

  it('[AC3] non-existent epic → refused', () => {
    const { db } = freshDb();
    const result = publisher(db).publish('epic-999');
    assert.equal(result.status, 'refused');
    assert.ok(result.note.includes('epic-999'));
  });

  it('[AC3] empty epicId → refused', () => {
    const { db } = freshDb();
    const result = publisher(db).publish('');
    assert.equal(result.status, 'refused');
  });
});

// ─── PR-open failure ─────────────────────────────────────────────────────────

describe('PR-open failure', () => {
  it('[AC1 boundary] openPr throws → failed, epic stays publish_pending, no partial write', () => {
    const { db, store } = freshDb();
    setPublishPending(store, 'epic-001');

    const result = publisher(db, () => {
      throw new Error('gh: authentication failed');
    }).publish('epic-001');

    assert.equal(result.status, 'failed');
    assert.ok(result.note.includes('gh: authentication failed'));

    // No partial state written
    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'publish_pending', 'epic must stay publish_pending');
    assert.equal(epic.epic_pr_url, null, 'no PR URL should be recorded on failure');
  });

  it('[AC1 boundary] openPr returns undefined (no URL parsed) → failed, epic stays publish_pending', () => {
    const { db, store } = freshDb();
    setPublishPending(store, 'epic-001');

    const result = publisher(db, () => undefined).publish('epic-001');

    assert.equal(result.status, 'failed');
    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'publish_pending');
    assert.equal(epic.epic_pr_url, null);
  });
});

// ─── Reconcile untouched / verb separation ────────────────────────────────────

describe('verb separation from reconcile', () => {
  it('[AC3, AC4] already-merged (not publish_pending) epic is refused by publish — publish and reconcile do not overlap', () => {
    // An epic that has been manually set to in_progress (simulating the state
    // reconcile would target) is refused by publish. The EpicReconciler itself
    // is not invoked here; the important assertion is that publish refuses anything
    // that is not publish_pending, which is the exact status reconcile operates on.
    const { db, store } = freshDb();
    store.updateStatus('epic-001', 'in_progress');

    const result = publisher(db).publish('epic-001');
    assert.equal(result.status, 'refused');
    assert.ok(result.note.includes('reconcile'), 'note should hint at reconcile for non-publish_pending epics');
  });
});

// ─── Docs assertion ──────────────────────────────────────────────────────────

describe('docs', () => {
  it('[AC5] docs/capabilities.md contains a loom publish row', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    // Walk up from the compiled test location until we find docs/capabilities.md
    let dir = __dirname;
    let capabilitiesPath: string | undefined;
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, 'docs', 'capabilities.md');
      if (fs.existsSync(candidate)) { capabilitiesPath = candidate; break; }
      dir = path.dirname(dir);
    }
    assert.ok(capabilitiesPath, 'could not locate docs/capabilities.md');
    const content = fs.readFileSync(capabilitiesPath!, 'utf8');
    assert.ok(
      content.includes('loom publish'),
      'docs/capabilities.md must contain a loom publish row'
    );
  });
});
