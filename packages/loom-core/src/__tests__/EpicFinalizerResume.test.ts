/**
 * EpicFinalizerResume.test.ts — story-066-001
 *
 * Tests for the durable finalize state machine: FR-1/2/3/4/10/11/12, NFR-1/2/3.
 * All git/gh/push seams are injected. DB uses real in-memory SQLite.
 * No network, no sleeps, no wall-clock.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createDatabase } from '../state/Database.js';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AuditLog } from '../state/AuditLog.js';
import { LeaseStore } from '../state/LeaseStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicFinalizer } from '../orchestrator/EpicFinalizer.js';
import type { EpicFinalizerOptions, ResumePlan } from '../orchestrator/EpicFinalizer.js';
import type { Story, EpicRecord } from '../types.js';

// ─── Test constants ──────────────────────────────────────────────────────────

const PR_URL = 'https://github.com/org/repo/pull/42';
const FINALIZE_REF = 'loom/finalize/epic-001-abc1234';

// ─── DB helpers ──────────────────────────────────────────────────────────────

function freshDb() {
  const db = createDatabase(':memory:');
  const store = new EpicStore(db);
  const audit = new AuditLog(db);
  return { db, store, audit };
}

/** Seeds a minimal epic row in publish_pending state with a finalize_ref. */
function seedPublishPending(
  store: EpicStore,
  epicId = 'epic-001',
  finalizeRef = FINALIZE_REF
) {
  store.create(epicId, `Test Epic ${epicId}`);
  store.beginFinalizing(epicId, 'pushing');
  store.publishPending(epicId, finalizeRef, 'push failed during test');
}

/** Creates a finalizer with all seams injected so no real git/gh is needed. */
function makeFinalizer(
  db: ReturnType<typeof createDatabase>,
  over: Partial<EpicFinalizerOptions> = {}
): EpicFinalizer {
  return new EpicFinalizer({
    projectRoot: '/tmp/loom-resume-test',
    db,
    allowedRemotes: ['https://example.com/**'],
    prStrategy: 'per-epic',
    // Inject a fake remote so resume() doesn't call real git commands
    resolveRemote: () => 'origin',
    pushBranch: () => ({ ok: true, output: 'pushed' }),
    openPr: () => PR_URL,
    prForRef: () => ({ exists: false }),
    remoteRefExists: () => false,
    integrationHeadMatchesRef: () => false,
    ...over,
  });
}

/** Access the private detectResumePhase method via cast (for unit-testing the matrix). */
function detectPhase(
  f: EpicFinalizer,
  epic: EpicRecord,
  remote: string | null
): ResumePlan {
  return (
    f as unknown as {
      detectResumePhase(epic: EpicRecord, remote: string | null): ResumePlan;
    }
  ).detectResumePhase(epic, remote);
}

// ─── FR-1: recordFinalizeRef called BEFORE push ─────────────────────────────

describe('FR-1: recordFinalizeRef persisted before pushBranch fires', () => {
  let repo: string;
  let db: ReturnType<typeof openDatabase>;
  let store: EpicStore;

  beforeEach(() => {
    resetDatabaseForTest();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-resume-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['config', 'user.email', 'test@loom.dev']);
    git(['config', 'user.name', 'Loom Test']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'initial']);
    git(['remote', 'add', 'origin', 'https://example.com/acme/loom.git']);

    const loomDir = path.join(repo, '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    db = openDatabase(loomDir);
    store = new EpicStore(db);
  });

  afterEach(() => {
    resetDatabaseForTest();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('finalize_ref is persisted in the epics row when pushBranch fires', async () => {
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const epicId = 'epic-001';
    const storyId = 'story-001-001';

    // Build a minimal epic + story branch
    const storyObj: Story = {
      id: storyId, title: 'Story', description: 'work',
      acceptance_criteria: ['done'], estimated_complexity: 'small', dependencies: [],
    };
    const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, yaml.dump({
      epic_id: epicId, title: `Epic ${epicId}`, status: 'planned',
      priority: 'must-have', prd_ref: 'x', requirements: ['FR-1'], stories: [storyObj],
    }));

    store.create(epicId, `Epic ${epicId}`, rel);
    store.updateStatus(epicId, 'approved');
    store.updateBaseSha(epicId, git(['rev-parse', 'HEAD']));

    git(['checkout', '-q', '-b', `story/${storyId}`]);
    git(['commit', '--allow-empty', '-q', '-m', `${storyId}: work`]);
    git(['checkout', '-q', '-']);

    const agentStore = new AgentStore(db);
    const a = agentStore.create(epicId, storyId, `wt-${storyId}`);
    agentStore.updateStatus(a.id, 'done');

    // Track finalize_ref at the moment pushBranch is called
    let finalizeRefAtPush: string | null | undefined = undefined;
    const finalizer = new EpicFinalizer({
      projectRoot: repo,
      db,
      allowedRemotes: ['https://example.com/**'],
      prStrategy: 'per-epic',
      pushBranch: () => {
        // Read inside the push seam to confirm FR-1 ordering
        finalizeRefAtPush = store.get(epicId)?.finalize_ref;
        return { ok: true, output: 'pushed' };
      },
      openPr: () => PR_URL,
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => false,
    });

    await finalizer.finalize(epicId);

    assert.notEqual(finalizeRefAtPush, undefined, 'pushBranch spy must have been called');
    assert.ok(finalizeRefAtPush, 'finalize_ref must be non-null at push time');
    assert.match(
      finalizeRefAtPush ?? '',
      /^loom\/finalize\/epic-001-[0-9a-f]{7}$/,
      'finalize_ref has the canonical format at push time'
    );
  });
});

// ─── FR-2: publishPending semantics ─────────────────────────────────────────

describe('FR-2: publishPending() sets status=publish_pending atomically', () => {
  it('publishPending: status=publish_pending, finalize_ref set, publish_note set, phase cleared', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.beginFinalizing('epic-001', 'pushing');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);

    store.publishPending('epic-001', FINALIZE_REF, 'push failed: remote rejected');

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'publish_pending');
    assert.equal(epic.finalize_ref, FINALIZE_REF);
    assert.match(epic.publish_note ?? '', /push failed/i);
    assert.equal(epic.finalize_phase, null, 'publishPending clears finalize_phase');
    assert.equal(epic.epic_pr_url, null);
    assert.equal(epic.error, null, 'publish_pending does not set error');
  });

  it('PR-open-fail: publishPending sets status=publish_pending, not finalizing or failed', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.beginFinalizing('epic-001', 'opening_pr');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);

    store.publishPending('epic-001', FINALIZE_REF, 'PR open failed — run `loom publish epic-001` to retry.');

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'publish_pending');
    assert.match(epic.publish_note ?? '', /loom publish/i);
    assert.equal(epic.finalize_phase, null);
    assert.notEqual(epic.status, 'finalizing');
    assert.notEqual(epic.status, 'failed');
  });
});

// ─── FR-3: resume() completes remainder only ────────────────────────────────

describe('FR-3: resume() completes remaining phases without re-merging or re-gating', () => {
  it('publish_pending + ref on remote: resume opens PR, flips to done, no merge/gate seam called', async () => {
    const { db, store, audit } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    let openPrCalled = false;

    const f = makeFinalizer(db, {
      remoteRefExists: () => true,          // ref is on remote → open-pr plan
      prForRef: () => ({ exists: false }),   // no live PR yet
      openPr: () => { openPrCalled = true; return PR_URL; },
    });

    const result = await f.resume('epic-001');

    assert.ok(openPrCalled, 'openPr must be called');
    assert.equal(result.status, 'merged');
    assert.equal(result.url, PR_URL);

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'done');
    assert.equal(epic.epic_pr_url, PR_URL);

    // NFR-3: audit written
    const rows = audit.getByCommand('epic-001', ['epic_finalize_resume']);
    assert.equal(rows.length, 1, 'epic_finalize_resume audit row must be written');
  });
});

// ─── detectResumePhase matrix ────────────────────────────────────────────────

describe('detectResumePhase → ResumePlan matrix (FR-4, FR-10, FR-11, FR-12)', () => {
  it('already-done: epic_pr_url set + prForRef reports live PR', async () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);
    store.recordPrUrl('epic-001', PR_URL);

    const f = makeFinalizer(db, { prForRef: () => ({ exists: true, url: PR_URL }) });
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'already-done');
    assert.equal((plan as Extract<ResumePlan, { action: 'already-done' }>).prUrl, PR_URL);
  });

  it('record-pr: no epic_pr_url but prForRef reports live PR (FR-10 — remote wins)', async () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);
    // epic_pr_url is NOT set in DB

    const f = makeFinalizer(db, { prForRef: () => ({ exists: true, url: PR_URL }) });
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'record-pr');
    assert.equal((plan as Extract<ResumePlan, { action: 'record-pr' }>).prUrl, PR_URL);
  });

  it('open-pr: finalize_ref set + remoteRefExists=true + no live PR', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true,
    });
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'open-pr');
    assert.equal(
      (plan as Extract<ResumePlan, { action: 'open-pr' }>).finalizeRef,
      FINALIZE_REF
    );
  });

  it('push-and-open: remoteRefExists=false + integrationHeadMatchesRef=true (FR-12 — deleted remote branch)', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => true, // local branch still at correct sha
    });
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'push-and-open');
    assert.equal(
      (plan as Extract<ResumePlan, { action: 'push-and-open' }>).finalizeRef,
      FINALIZE_REF
    );
  });

  it('full-finalize: finalize_ref set but integrationHeadMatchesRef=false (FR-11 — sha mismatch)', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => false, // sha changed
    });
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'full-finalize');
  });

  it('full-finalize: no finalize_ref in DB (epic never got to push phase)', async () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    // No finalize_ref — never started push

    const f = makeFinalizer(db);
    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'full-finalize');
  });

  it('noop-terminal: remote=null (no remote configured)', async () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');

    const f = makeFinalizer(db);
    const plan = detectPhase(f, store.get('epic-001')!, null);

    assert.equal(plan.action, 'noop-terminal');
    assert.match((plan as Extract<ResumePlan, { action: 'noop-terminal' }>).note, /no remote/i);
  });
});

// ─── FR-4: cross-process safety ──────────────────────────────────────────────

describe('FR-4: detectResumePhase safe across separate process invocations', () => {
  it('loading EpicRecord fresh from store + mocked probes produces identical plan each time', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // open-pr plan
    });

    // First call (simulates process 1)
    const plan1 = await detectPhase(f, store.get('epic-001')!, 'origin');
    // Second call (simulates process 2 loading fresh from DB)
    const plan2 = await detectPhase(f, store.get('epic-001')!, 'origin');

    assert.deepEqual(plan1, plan2, 'detectResumePhase is deterministic across invocations');
    assert.equal(plan1.action, 'open-pr');
  });
});

// ─── FR-10: remote wins over DB hint ────────────────────────────────────────

describe('FR-10: remote is the source of truth for PR existence', () => {
  it('DB says epic_pr_url set but prForRef reports no PR → not already-done (remote wins)', async () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);
    store.recordPrUrl('epic-001', 'https://old.pr.url'); // DB claims PR exists

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }), // Remote says NO live PR (remote wins)
      remoteRefExists: () => true,          // but ref is still on remote
    });

    const plan = detectPhase(f, store.get('epic-001')!, 'origin');

    assert.equal(plan.action, 'open-pr', 'Remote disagreement → open-pr, not already-done');
  });
});

// ─── FR-11: sha-match gate ───────────────────────────────────────────────────

describe('FR-11: sha-match determines whether prior gate result is trusted', () => {
  it('sha mismatch: full-finalize (gate treated as not-yet-satisfied)', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => false, // sha changed → do not trust gate
    });

    const plan = detectPhase(f, store.get('epic-001')!, 'origin');
    assert.equal(plan.action, 'full-finalize', 'sha mismatch must trigger full-finalize');
  });

  it('sha match: push-and-open (gate trusted, no re-merge)', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const f = makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => true, // sha matches → trust gate
    });

    const plan = detectPhase(f, store.get('epic-001')!, 'origin');
    assert.equal(plan.action, 'push-and-open', 'sha match → push-and-open (gate trusted)');
  });
});

// ─── FR-12: recordFinalizeRef idempotency ────────────────────────────────────

describe('FR-12: recordFinalizeRef is safe to re-invoke (idempotent UPDATE)', () => {
  it('calling recordFinalizeRef twice persists a single value, no error', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');

    store.recordFinalizeRef('epic-001', FINALIZE_REF);
    assert.equal(store.get('epic-001')!.finalize_ref, FINALIZE_REF, 'first call persists ref');

    // Second call with same ref — idempotent
    assert.doesNotThrow(() => store.recordFinalizeRef('epic-001', FINALIZE_REF));
    assert.equal(store.get('epic-001')!.finalize_ref, FINALIZE_REF, 'second call same ref');

    // Call with new ref (re-merge produced a new sha)
    const newRef = 'loom/finalize/epic-001-fffffff';
    store.recordFinalizeRef('epic-001', newRef);
    assert.equal(store.get('epic-001')!.finalize_ref, newRef, 'ref updates to new value');

    // Status must not be changed by recordFinalizeRef
    assert.equal(store.get('epic-001')!.status, 'planned', 'recordFinalizeRef must not change status');
  });
});

// ─── NFR-1: lease serialization ──────────────────────────────────────────────

describe('NFR-1: concurrent resume() serialized — no double-push or double-PR', () => {
  it('second resume() with lease held by another owner returns skipped, no push or openPr called', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    // A competing process holds the lease
    const competingLease = new LeaseStore(db, {
      owner: 'competing-process-uuid',
      pid: 99999,
      hostname: 'other-host',
      isAlive: () => true,
    });
    competingLease.acquire('epic-001');

    let pushCalled = false;
    let openPrCalled = false;

    const f = makeFinalizer(db, {
      remoteRefExists: () => true,
      prForRef: () => ({ exists: false }),
      pushBranch: () => { pushCalled = true; return { ok: true, output: 'pushed' }; },
      openPr: () => { openPrCalled = true; return PR_URL; },
    });

    const result = await f.resume('epic-001');

    assert.equal(result.status, 'skipped', 'lease contention must return skipped');
    assert.ok(!pushCalled, 'push must not fire when lease held by another');
    assert.ok(!openPrCalled, 'openPr must not fire when lease held by another');

    // Epic remains publish_pending (not done)
    assert.equal(store.get('epic-001')!.status, 'publish_pending');
  });

  it('prForRef probe precedes openPr in resume (idempotent — check before create)', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const callOrder: string[] = [];

    const f = makeFinalizer(db, {
      prForRef: () => { callOrder.push('prForRef'); return { exists: false }; },
      remoteRefExists: () => { callOrder.push('remoteRefExists'); return true; },
      openPr: () => { callOrder.push('openPr'); return PR_URL; },
    });

    await f.resume('epic-001');

    const prIdx = callOrder.indexOf('prForRef');
    const openIdx = callOrder.indexOf('openPr');
    assert.ok(prIdx >= 0, 'prForRef must be called');
    assert.ok(openIdx >= 0, 'openPr must be called');
    assert.ok(prIdx < openIdx, 'prForRef must precede openPr (FR-10 check before create)');
  });
});

// ─── NFR-2: no new durability table ──────────────────────────────────────────

describe('NFR-2: all durability routes through publishPending/recordFinalizeRef — no new tables', () => {
  it('publishPending only writes to existing epics columns', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.publishPending('epic-001', FINALIZE_REF, 'note');

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'publish_pending');
    assert.equal(epic.finalize_ref, FINALIZE_REF);
    assert.equal(epic.publish_note, 'note');
    assert.equal(epic.finalize_phase, null);
  });

  it('recordFinalizeRef only writes finalize_ref column without status change', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);

    const epic = store.get('epic-001')!;
    assert.equal(epic.finalize_ref, FINALIZE_REF);
    assert.equal(epic.status, 'planned', 'recordFinalizeRef must not change the status');
    assert.equal(epic.publish_note, null);
  });
});

// ─── NFR-3: audit_log written before returning ───────────────────────────────

describe('NFR-3: audit_log rows written before returning; no push to protected branches', () => {
  it('resume() writes epic_finalize_resume before returning', async () => {
    const { db, store, audit } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    await makeFinalizer(db, {
      remoteRefExists: () => true,
      prForRef: () => ({ exists: false }),
      openPr: () => PR_URL,
    }).resume('epic-001');

    const rows = audit.getByCommand('epic-001', ['epic_finalize_resume']);
    assert.equal(rows.length, 1, 'epic_finalize_resume must be written once');
  });

  it('publishPhase writes epic_published inside the done transaction', async () => {
    const { db, store, audit } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    await makeFinalizer(db, {
      remoteRefExists: () => true,
      prForRef: () => ({ exists: false }),
      openPr: () => PR_URL,
    }).resume('epic-001');

    const rows = audit.getByCommand('epic-001', ['epic_published']);
    assert.equal(rows.length, 1, 'epic_published must be written inside the done transaction');
  });

  it('push-and-open path uses loom/finalize/* refspec — never main or protected branch', async () => {
    const { db, store } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    const pushCalls: Array<{ remote: string; branch: string }> = [];

    await makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => false,
      integrationHeadMatchesRef: () => true, // push-and-open plan
      pushBranch: (remote, branch) => {
        pushCalls.push({ remote, branch });
        return { ok: true, output: 'pushed' };
      },
      openPr: () => PR_URL,
    }).resume('epic-001');

    assert.equal(pushCalls.length, 1, 'exactly one push must occur');
    assert.match(pushCalls[0]!.branch, /^loom\/finalize\//, 'push ref must be loom/finalize/*');
    assert.ok(!pushCalls[0]!.branch.includes('main'), 'push ref must never be main');
  });
});

// ─── Done-write ownership ─────────────────────────────────────────────────────

describe('Done-write ownership: finalize() never writes done; resume() does', () => {
  it('finalize() publishPending path never writes done', () => {
    const { db, store } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.beginFinalizing('epic-001', 'pushing');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);

    // Simulate finalize() calling publishPending on push failure (FR-2)
    store.publishPending('epic-001', FINALIZE_REF, 'push failed');

    assert.notEqual(store.get('epic-001')!.status, 'done', 'publishPending must not write done');
  });

  it('resume() writes done via canonical order: recordPrUrl → clearFinalizePhase → epic_published → done', async () => {
    const { db, store, audit } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    // Spy on EpicStore write order
    const writeOrder: string[] = [];
    const proto = EpicStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    assert.ok(typeof proto.recordPrUrl === 'function', 'recordPrUrl must exist on EpicStore.prototype');
    assert.ok(typeof proto.clearFinalizePhase === 'function', 'clearFinalizePhase must exist on EpicStore.prototype');
    assert.ok(typeof proto.updateStatus === 'function', 'updateStatus must exist on EpicStore.prototype');
    const origRecordPrUrl = proto.recordPrUrl;
    const origClearFinalizePhase = proto.clearFinalizePhase;
    const origUpdateStatus = proto.updateStatus;
    proto.recordPrUrl = function (this: EpicStore, ...args: unknown[]) {
      writeOrder.push('recordPrUrl');
      return origRecordPrUrl.apply(this, args);
    };
    proto.clearFinalizePhase = function (this: EpicStore, ...args: unknown[]) {
      writeOrder.push('clearFinalizePhase');
      return origClearFinalizePhase.apply(this, args);
    };
    proto.updateStatus = function (this: EpicStore, ...args: unknown[]) {
      writeOrder.push(`updateStatus:${args[1] as string}`);
      return origUpdateStatus.apply(this, args);
    };

    try {
      await makeFinalizer(db, {
        remoteRefExists: () => true,
        prForRef: () => ({ exists: false }),
        openPr: () => PR_URL,
      }).resume('epic-001');
    } finally {
      proto.recordPrUrl = origRecordPrUrl;
      proto.clearFinalizePhase = origClearFinalizePhase;
      proto.updateStatus = origUpdateStatus;
    }

    const epic = store.get('epic-001')!;
    assert.equal(epic.status, 'done', 'resume() must flip to done');
    assert.equal(epic.epic_pr_url, PR_URL, 'PR URL must be recorded');

    const prIdx = writeOrder.indexOf('recordPrUrl');
    const clearIdx = writeOrder.indexOf('clearFinalizePhase');
    const doneIdx = writeOrder.indexOf('updateStatus:done');
    assert.ok(prIdx >= 0, 'recordPrUrl must be called');
    assert.ok(clearIdx >= 0, 'clearFinalizePhase must be called');
    assert.ok(doneIdx >= 0, 'updateStatus(done) must be called');
    assert.ok(prIdx < doneIdx, 'recordPrUrl must precede done write (ADR-3)');
    assert.ok(clearIdx > prIdx && clearIdx < doneIdx, 'clearFinalizePhase must be between recordPrUrl and done');

    // epic_published audit must also exist
    const pubRows = audit.getByCommand('epic-001', ['epic_published']);
    assert.equal(pubRows.length, 1, 'epic_published must be written in the done transaction');
  });
});

// ─── Stranding + resume end-to-end scenarios ─────────────────────────────────

describe('Stranding + resume end-to-end: push-fail and PR-open-fail reach recoverable state, then done', () => {
  it('push-fail scenario: resume from publish_pending → done without re-merging (ref on remote)', async () => {
    const { db, store, audit } = freshDb();
    seedPublishPending(store, 'epic-001', FINALIZE_REF);

    // Simulate: ref IS on remote (previous push happened before we failed elsewhere)
    // OR: this is a second recovery attempt after ref was pushed
    let pushCallCount = 0;

    const result = await makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // ref already on remote → open-pr plan
      pushBranch: () => { pushCallCount++; return { ok: true, output: 'pushed' }; },
      openPr: () => PR_URL,
    }).resume('epic-001');

    assert.equal(result.status, 'merged');
    assert.equal(result.url, PR_URL);
    assert.equal(store.get('epic-001')!.status, 'done');
    assert.equal(store.get('epic-001')!.epic_pr_url, PR_URL);
    assert.equal(pushCallCount, 0, 'push must NOT be called: ref was already on remote');

    // Both audit rows present
    assert.equal(audit.getByCommand('epic-001', ['epic_finalize_resume']).length, 1);
    assert.equal(audit.getByCommand('epic-001', ['epic_published']).length, 1);
  });

  it('PR-open-fail scenario: resume from publish_pending → done without re-merging (ref on remote)', async () => {
    const { db, store, audit } = freshDb();
    // Simulate PR-open-fail: ref was pushed, PR creation failed
    store.create('epic-001', 'Test Epic');
    store.beginFinalizing('epic-001', 'opening_pr');
    store.publishPending('epic-001', FINALIZE_REF, 'PR open failed — run `loom publish epic-001` to retry.');

    let pushCallCount = 0;

    const result = await makeFinalizer(db, {
      prForRef: () => ({ exists: false }),
      remoteRefExists: () => true, // ref is still on remote
      pushBranch: () => { pushCallCount++; return { ok: true, output: 'pushed' }; },
      openPr: () => PR_URL,
    }).resume('epic-001');

    assert.equal(result.status, 'merged');
    assert.equal(result.url, PR_URL);
    assert.equal(store.get('epic-001')!.status, 'done');
    assert.equal(pushCallCount, 0, 'push must NOT be called: ref was already on remote');

    assert.equal(audit.getByCommand('epic-001', ['epic_finalize_resume']).length, 1);
    assert.equal(audit.getByCommand('epic-001', ['epic_published']).length, 1);
  });

  it('already-done scenario: resume returns merged without changing epic status or PR url', async () => {
    const { db, store, audit } = freshDb();
    store.create('epic-001', 'Test Epic');
    store.recordFinalizeRef('epic-001', FINALIZE_REF);
    store.recordPrUrl('epic-001', PR_URL);

    // Snapshot status before
    const beforeStatus = store.get('epic-001')!.status;

    const result = await makeFinalizer(db, {
      prForRef: () => ({ exists: true, url: PR_URL }), // already-done plan
    }).resume('epic-001');

    assert.equal(result.status, 'merged');
    assert.equal(result.url, PR_URL);

    // Status and PR URL unchanged (resume returns early for already-done)
    const after = store.get('epic-001')!;
    assert.equal(after.status, beforeStatus, 'already-done must not change epic status');
    assert.equal(after.epic_pr_url, PR_URL, 'already-done must not change epic_pr_url');

    // NFR-3: resume audit row is written even for already-done
    const resumeRows = audit.getByCommand('epic-001', ['epic_finalize_resume']);
    assert.equal(resumeRows.length, 1, 'epic_finalize_resume audit must be written');
  });
});
