/**
 * finalizeRecovery.e2e.test.ts — story-066-007
 *
 * End-to-end regression tests for the three stranding scenarios:
 *   1. Push fails → publish_pending persisted → fresh-process resume → done (no re-merge)
 *   2. PR-open fails → publish_pending persisted → fresh-process resume → done (no re-push, no re-merge)
 *   3. Fresh-process resume: detectResumePhase reads only persisted DB state with mocked
 *      git/gh seams — no session variable or in-memory state carried from the stranding run.
 *
 * Each scenario verifies:
 *   - The epic reaches the recoverable publish_pending state after the failure.
 *   - resume() on a fresh EpicFinalizer instance (new process) lands the epic as done.
 *   - No merge/gate work is repeated: the epic_finalize audit row is absent from the recovery run.
 *
 * All git/gh/push seams are injected. DB uses real in-memory SQLite. No network, no sleeps.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { EpicFinalizer } from '../orchestrator/EpicFinalizer.js';
import type { EpicFinalizerOptions, ResumePlan } from '../orchestrator/EpicFinalizer.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const PR_URL = 'https://github.com/org/repo/pull/99';
const FINALIZE_REF = 'loom/finalize/epic-001-abc1234';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshDb() {
  const db = createDatabase(':memory:');
  const store = new EpicStore(db);
  const audit = new AuditLog(db);
  return { db, store, audit };
}

/**
 * Seeds an epic row in publish_pending state — simulates a prior process that
 * successfully merged all stories and recorded the ref, but failed at push or PR-open.
 */
function seedPublishPending(
  store: EpicStore,
  epicId = 'epic-001',
  finalizeRef = FINALIZE_REF,
  note = 'push failed during stranding test'
) {
  store.create(epicId, `Test Epic ${epicId}`);
  store.beginFinalizing(epicId, 'pushing');
  store.publishPending(epicId, finalizeRef, note);
}

/**
 * Builds an EpicFinalizer with all git/gh seams injected — no real network or shell.
 * Represents a fresh process instantiation: no reference to any prior run.
 */
function makeFreshFinalizer(
  db: ReturnType<typeof createDatabase>,
  over: Partial<EpicFinalizerOptions> = {}
): EpicFinalizer {
  return new EpicFinalizer({
    projectRoot: '/tmp/loom-e2e-test',
    db,
    allowedRemotes: ['https://example.com/**'],
    prStrategy: 'per-epic',
    resolveRemote: () => 'origin',
    pushBranch: () => ({ ok: true, output: 'pushed' }),
    openPr: () => PR_URL,
    prForRef: () => ({ exists: false }),
    remoteRefExists: () => false,
    integrationHeadMatchesRef: () => false,
    ...over,
  });
}

/**
 * Calls the private detectResumePhase method via cast.
 * Callers must assert non-null before passing; the narrowed parameter type
 * removes the need for a ! at the internal call site.
 * The private-access cast is intentional for unit coverage of a hot path.
 */
function detectPhase(
  f: EpicFinalizer,
  epic: NonNullable<ReturnType<EpicStore['get']>>,
  remote: string | null
): ResumePlan {
  // accessing private method for unit coverage — intentional
  return (
    f as unknown as {
      detectResumePhase(epic: NonNullable<ReturnType<EpicStore['get']>>, remote: string | null): ResumePlan;
    }
  ).detectResumePhase(epic, remote);
}

// ─── Scenario 1: Push-fail stranding → fresh-process resume → done ──────────

describe('Stranding scenario 1: push-fail → publish_pending → fresh-process resume → done', () => {
  it('push-fail (ref lands on remote): resume opens PR only — push and merge NOT called', async () => {
    const { db, store, audit } = freshDb();

    // Simulate the stranding: prior process failed at push, but the ref
    // actually made it to the remote before the process died.
    seedPublishPending(store, 'epic-001', FINALIZE_REF, 'push failed: connection reset');

    // Verify recoverable state is persisted
    const strandedEpic = store.get('epic-001')!;
    assert.equal(strandedEpic.status, 'publish_pending', 'stranded epic must be in publish_pending');
    assert.equal(strandedEpic.finalize_ref, FINALIZE_REF, 'finalize_ref must be persisted');
    assert.equal(strandedEpic.finalize_phase, null, 'finalize_phase must be cleared');

    // Fresh process: create a new EpicFinalizer — no reference to the prior run.
    let pushCallCount = 0;
    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // ref made it to the remote before crash
      pushBranch: () => { pushCallCount++; return { ok: true, output: 'pushed' }; },
      openPr: () => PR_URL,
    });

    const result = await freshFinalizer.resume('epic-001');

    // ── Outcome assertions ──────────────────────────────────────────────────
    assert.equal(result.status, 'merged', 'resume must return merged');
    assert.equal(result.url, PR_URL, 'resume must return the PR URL');

    const doneEpic = store.get('epic-001')!;
    assert.equal(doneEpic.status, 'done', 'epic must be done after recovery');
    assert.equal(doneEpic.epic_pr_url, PR_URL, 'PR URL must be recorded');

    // ── No re-push ──────────────────────────────────────────────────────────
    assert.equal(pushCallCount, 0, 'push must NOT be called: ref was already on remote');

    // ── No re-merge: epic_finalize audit row must be absent ─────────────────
    // finalize() (which runs merge+gate) writes 'epic_finalize'; resume() writes 'epic_finalize_resume'.
    // If no epic_finalize row exists, the merge/gate path was not re-entered.
    // getByCommand(epicId, actions) → rows WHERE command=epicId AND action IN (actions).
    // The second parameter is actions?: string[] per AuditLog.getByCommand's actual signature.
    const finalizeRows = audit.getByCommand('epic-001', ['epic_finalize']);
    assert.equal(finalizeRows.length, 0, 'epic_finalize must NOT be written — merge was not redone');

    // ── Audit trail for recovery ─────────────────────────────────────────────
    assert.equal(audit.getByCommand('epic-001', ['epic_finalize_resume']).length, 1);
    assert.equal(audit.getByCommand('epic-001', ['epic_published']).length, 1);
  });

  it('push-fail (ref NOT on remote, local head matches): resume re-pushes then opens PR — merge NOT called', async () => {
    const { db, store, audit } = freshDb();

    // The ref never reached the remote; the local epic branch still has the correct sha.
    seedPublishPending(store, 'epic-001', FINALIZE_REF, 'push failed: remote rejected');

    // Verify recoverable state
    assert.equal(store.get('epic-001')!.status, 'publish_pending');

    // Fresh process
    let pushCallCount = 0;
    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,              // ref NOT on remote
      integrationHeadMatchesRef: () => true,     // local epic branch still at the correct sha
      pushBranch: () => { pushCallCount++; return { ok: true, output: 'pushed' }; },
      openPr: () => PR_URL,
    });

    const result = await freshFinalizer.resume('epic-001');

    assert.equal(result.status, 'merged');
    assert.equal(result.url, PR_URL);
    assert.equal(store.get('epic-001')!.status, 'done');
    assert.equal(pushCallCount, 1, 'exactly one re-push must occur for push-and-open plan');

    // No re-merge
    const finalizeRows = audit.getByCommand('epic-001', ['epic_finalize']);
    assert.equal(finalizeRows.length, 0, 'epic_finalize must NOT be written — merge was not redone');

    assert.equal(audit.getByCommand('epic-001', ['epic_finalize_resume']).length, 1);
    assert.equal(audit.getByCommand('epic-001', ['epic_published']).length, 1);
  });

  it('push-fail (ref NOT on remote, local sha mismatch): plan is full-finalize — requires re-merge', () => {
    const { db, store } = freshDb();

    // Ref never reached the remote AND the local epic branch has since diverged.
    // Both guards fail → the prior gate result cannot be trusted → full re-finalize needed.
    seedPublishPending(store, 'epic-001', FINALIZE_REF, 'push failed and sha diverged');

    const epic = store.get('epic-001')!;

    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,           // ref NOT on remote
      integrationHeadMatchesRef: () => false, // local sha has diverged — cannot re-push safely
    });

    const plan = detectPhase(freshFinalizer, epic, 'origin');
    assert.equal(
      plan.action,
      'full-finalize',
      'irrecoverable: ref not on remote and local head does not match stored sha'
    );
  });
});

// ─── Scenario 2: PR-open-fail stranding → fresh-process resume → done ────────

describe('Stranding scenario 2: PR-open-fail → publish_pending → fresh-process resume → done', () => {
  it('PR-open-fail: ref is on remote, PR was never opened; resume opens PR — push and merge NOT called', async () => {
    const { db, store, audit } = freshDb();

    // Simulate a prior process that: merged, ran gate, pushed successfully to the
    // finalizer ref, but then the gh pr create call threw.
    store.create('epic-001', 'Test Epic epic-001');
    store.beginFinalizing('epic-001', 'opening_pr');
    store.publishPending(
      'epic-001',
      FINALIZE_REF,
      "epic/epic-001 pushed to loom/finalize/epic-001-abc1234; PR open failed — run `loom publish epic-001` to retry."
    );

    // Verify recoverable state
    const strandedEpic = store.get('epic-001')!;
    assert.equal(strandedEpic.status, 'publish_pending');
    assert.equal(strandedEpic.finalize_ref, FINALIZE_REF);
    assert.equal(strandedEpic.epic_pr_url, null, 'no PR URL must be set when PR open failed');

    // Fresh process: create a new EpicFinalizer — simulates `loom finalize --resume epic-001`
    let pushCallCount = 0;
    let openPrCallCount = 0;
    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }), // still no live PR on remote
      remoteRefExists: () => true,          // ref IS on remote (push succeeded)
      pushBranch: () => { pushCallCount++; return { ok: true, output: 'pushed' }; },
      openPr: () => { openPrCallCount++; return PR_URL; },
    });

    const result = await freshFinalizer.resume('epic-001');

    // ── Outcome assertions ──────────────────────────────────────────────────
    assert.equal(result.status, 'merged', 'resume must return merged');
    assert.equal(result.url, PR_URL);

    const doneEpic = store.get('epic-001')!;
    assert.equal(doneEpic.status, 'done');
    assert.equal(doneEpic.epic_pr_url, PR_URL);

    // ── No re-push: ref was already on remote ───────────────────────────────
    assert.equal(pushCallCount, 0, 'push must NOT be called: ref was already on remote');

    // ── PR was opened exactly once ───────────────────────────────────────────
    assert.equal(openPrCallCount, 1, 'openPr must be called exactly once');

    // ── No re-merge ─────────────────────────────────────────────────────────
    const finalizeRows = audit.getByCommand('epic-001', ['epic_finalize']);
    assert.equal(finalizeRows.length, 0, 'epic_finalize must NOT be written — merge was not redone');

    assert.equal(audit.getByCommand('epic-001', ['epic_finalize_resume']).length, 1);
    assert.equal(audit.getByCommand('epic-001', ['epic_published']).length, 1);
  });

  it('PR-open-fail idempotent: second resume() after PR already exists uses record-pr — no duplicate open', async () => {
    const { db, store, audit } = freshDb();

    // First recovery: PR was actually opened but the process crashed before recording it
    store.create('epic-001', 'Test Epic epic-001');
    store.beginFinalizing('epic-001', 'opening_pr');
    store.publishPending('epic-001', FINALIZE_REF, 'PR open failed');

    // Fresh process 1: opens the PR
    const freshFinalizer1 = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true,
      openPr: () => PR_URL,
    });
    await freshFinalizer1.resume('epic-001');
    assert.equal(store.get('epic-001')!.status, 'done');

    // Fresh process 2: a second resume() — remote now reports the live PR
    let openPrCalled = false;
    let push2Called = false;
    const freshFinalizer2 = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: true, url: PR_URL }), // remote says PR exists
      // prForRef returns live PR first → already-done path → pushBranch never consulted.
      // Seam is wired to confirm this invariant holds.
      pushBranch: () => { push2Called = true; return { ok: true, output: 'pushed' }; },
      openPr: () => { openPrCalled = true; return PR_URL; },
    });
    const result2 = await freshFinalizer2.resume('epic-001');

    assert.equal(result2.status, 'merged', 'already-done plan returns merged');
    assert.ok(!openPrCalled, 'openPr must NOT be called on an already-done epic');
    assert.ok(!push2Called, 'pushBranch must not fire on an already-done epic');
    assert.equal(store.get('epic-001')!.status, 'done', 'status unchanged after idempotent resume');

    // resume() writes 'epic_finalize_resume' BEFORE publishPhase regardless of plan type
    // (including 'already-done'), so both calls contribute a row.
    const resumeRows = audit.getByCommand('epic-001', ['epic_finalize_resume']);
    assert.equal(resumeRows.length, 2, 'each resume() call writes exactly one epic_finalize_resume');
    const finalizeRows = audit.getByCommand('epic-001', ['epic_finalize']);
    assert.equal(finalizeRows.length, 0, 'epic_finalize must NEVER be written via the open-pr/record-pr path');
  });
});

// ─── Scenario 3: Fresh-process resume via persisted state only ───────────────

describe('Scenario 3: Fresh-process resume — detectResumePhase driven by persisted DB state only', () => {
  it('detectResumePhase derives the correct plan from the DB row — no session variable needed', () => {
    const { db, store } = freshDb();

    // Simulate the stranding by directly writing state (the "first process" is gone):
    // only the DB survives across the process boundary.
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    // The "second process" reads the epic from the DB and creates a fresh finalizer.
    // No reference to any first-process object is held.
    const epic = store.get('epic-001')!;
    assert.ok(epic, 'epic must be readable from DB');
    assert.equal(epic.status, 'publish_pending', 'DB must carry the recoverable status');
    assert.equal(epic.finalize_ref, FINALIZE_REF, 'DB must carry the finalize_ref');
    assert.equal(epic.finalize_phase, null, 'finalize_phase must be cleared');

    // Fresh-process finalizer reads only the DB row + injectable remote probes.
    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // ref IS on remote → open-pr plan
    });

    // detectResumePhase reads epic.finalize_ref from the row (NOT a session variable)
    const plan = detectPhase(freshFinalizer, epic, 'origin');

    assert.equal(plan.action, 'open-pr', 'plan must be open-pr: ref is on remote, no live PR');
    assert.equal(
      (plan as Extract<ResumePlan, { action: 'open-pr' }>).finalizeRef,
      FINALIZE_REF,
      'finalizeRef in plan must come from the DB row'
    );
  });

  it('fresh-process resume: full e2e via persisted state → done — epic_finalize audit row absent', async () => {
    const { db, store, audit } = freshDb();

    // ── "Process 1" writes state and then conceptually exits ──────────────────
    {
      const processOneStore = new EpicStore(db);
      processOneStore.create('epic-001', 'My Epic');
      processOneStore.beginFinalizing('epic-001', 'pushing');
      processOneStore.publishPending('epic-001', FINALIZE_REF, 'push failed — simulating process 1 crash');
      // processOneStore and processOneFinalizer go out of scope here.
      // Only the DB survives.
    }

    // Verify the DB state that process 2 will read
    const recoveredEpic = store.get('epic-001')!;
    assert.equal(recoveredEpic.status, 'publish_pending');
    assert.equal(recoveredEpic.finalize_ref, FINALIZE_REF);
    assert.equal(recoveredEpic.epic_pr_url, null);

    // ── "Process 2" starts fresh: no EpicFinalizer or store from process 1 ───
    // This is exactly what `loom finalize --resume epic-001` does: create a new
    // EpicFinalizer from disk, call resume(). The finalize_ref comes ONLY from
    // the DB row; there is no session variable linking this finalizer to process 1.
    // The open-pr plan (remoteRefExists=true) must NOT trigger pushBranch.
    let unexpectedPushCalled = false;
    const processTwoFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // ref on remote → open-pr plan (no re-push, no re-merge)
      pushBranch: () => {
        // pushBranch must not fire on the open-pr plan (remoteRefExists=true)
        unexpectedPushCalled = true;
        return { ok: true, output: 'pushed' };
      },
      openPr: () => PR_URL,
    });

    const result = await processTwoFinalizer.resume('epic-001');

    // ── End-to-end outcome ───────────────────────────────────────────────────
    assert.equal(result.status, 'merged', 'fresh-process resume must return merged');
    assert.equal(result.url, PR_URL, 'fresh-process resume must return the PR URL');

    const finalEpic = store.get('epic-001')!;
    assert.equal(finalEpic.status, 'done', 'epic must reach done after fresh-process recovery');
    assert.equal(finalEpic.epic_pr_url, PR_URL, 'PR URL must be recorded in DB');

    // ── Merge/gate was NOT redone ─────────────────────────────────────────────
    // Primary guard: epic_finalize audit row absent (the merge+gate path was not traversed).
    // Secondary guard: pushBranch must not fire on the open-pr plan (ref was already remote).
    assert.ok(!unexpectedPushCalled, 'pushBranch must not fire on the open-pr path (remoteRefExists=true)');
    const epicFinalizeRows = audit.getByCommand('epic-001', ['epic_finalize']);
    assert.equal(
      epicFinalizeRows.length,
      0,
      'epic_finalize (merge+gate path) must NOT appear in audit — merged work was not redone'
    );

    // ── Recovery audit trail ──────────────────────────────────────────────────
    const resumeRows = audit.getByCommand('epic-001', ['epic_finalize_resume']);
    assert.equal(resumeRows.length, 1, 'exactly one epic_finalize_resume row');
    const publishedRows = audit.getByCommand('epic-001', ['epic_published']);
    assert.equal(publishedRows.length, 1, 'exactly one epic_published row');
  });

  it('fresh-process resume reads finalize_ref from DB, not from any in-memory variable', async () => {
    const { db, store, audit } = freshDb();

    const customRef = 'loom/finalize/epic-001-deadbeef';

    // Write the state that a prior process left behind — the ref is the only
    // pointer to what was pushed; the new process must read it from the DB.
    store.create('epic-001', 'Epic via persisted ref');
    store.beginFinalizing('epic-001', 'opening_pr'); // PR-open-fail scenario
    store.publishPending('epic-001', customRef, 'PR open failed');

    // Fresh process: no knowledge of customRef — it reads it from the DB row
    const refUsedForPrOpen: string[] = [];
    const freshFinalizer = makeFreshFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true,
      openPr: ({ branch }) => {
        refUsedForPrOpen.push(branch); // capture the ref the finalizer used
        return PR_URL;
      },
    });

    await freshFinalizer.resume('epic-001');

    assert.equal(refUsedForPrOpen.length, 1, 'openPr must be called once');
    assert.equal(
      refUsedForPrOpen[0],
      customRef,
      'the ref passed to openPr must be the one read from the DB — not a hardcoded or session value'
    );

    assert.equal(store.get('epic-001')!.status, 'done');
    assert.equal(audit.getByCommand('epic-001', ['epic_finalize']).length, 0);
  });
});
