/**
 * story-060-005: Unit tests for landingReport(attemptId, store).
 *
 * Test plan cases:
 *  (blocked, AC1)      attempt at 'blocked' with blocker ⇒ report names failing check + repo
 *  (rolled-back, AC2)  attempt at 'rolled_back' ⇒ all repos restored + originating failure cause
 *  (clean-retry, AC3)  rolled_back report makes retry-as-new-attempt unambiguous (ADR-006)
 *  (cleanState true)   pending/reverted repos ⇒ cleanState:true
 *  (cleanState false)  merged repo ⇒ cleanState:false
 *  (no blocker)        attempt without blocker ⇒ report.blocker is undefined
 *  (no-new-channel)    report is derived purely from store — no side-effect calls expected
 *  (integration)       landingReport + real LandingStore + real DB ⇒ end-to-end shape check
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { landingReport } from '../landingReport.js';
import { createDatabase } from '../../state/Database.js';
import { LandingStore } from '../../state/LandingStore.js';
import type {
  LandingAttempt,
  LandingAttemptStatus,
  LandingBlocker,
  LandingStorePort,
  MergeState,
  RepoMergeRecord,
} from '../landingTypes.js';
import type { RepoStage } from '../CrossRepoCoordinator.js';

// ─── Minimal mock store ────────────────────────────────────────────────────────

function makeAttempt(
  id: string,
  epicId: string,
  status: LandingAttemptStatus,
  blocker: LandingBlocker | null = null,
): LandingAttempt {
  return {
    id,
    epicId,
    status,
    baseShas: {},
    blocker,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:01:00Z',
  };
}

function makeMerge(
  attemptId: string,
  repoSlug: string,
  mergeState: MergeState,
  prUrl: string | null = `https://github.com/org/repo-${repoSlug}/pull/1`,
): RepoMergeRecord {
  return {
    attemptId,
    repoSlug,
    dependsOn: [],
    prNumber: 1,
    prUrl,
    mergeCommitSha: mergeState === 'merged' ? 'abc123' : null,
    mergeState,
    revertPrUrl: null,
    revertMergeSha: null,
    mergedAt: null,
    revertedAt: null,
  };
}

function makeStore(
  attempt: LandingAttempt,
  merges: RepoMergeRecord[],
): LandingStorePort {
  const noop = (): never => { throw new Error('unexpected store call'); };
  return {
    getAttempt: (id: string) => {
      assert.equal(id, attempt.id, 'getAttempt must be called with the correct attemptId');
      return { attempt, merges };
    },
    beginAttempt: noop as unknown as LandingStorePort['beginAttempt'],
    recordMerge: noop as unknown as LandingStorePort['recordMerge'],
    markRevertPending: noop as unknown as LandingStorePort['markRevertPending'],
    markReverted: noop as unknown as LandingStorePort['markReverted'],
    pendingReverts: noop as unknown as LandingStorePort['pendingReverts'],
    setStatus: noop as unknown as LandingStorePort['setStatus'],
    latestAttemptIdForEpic: noop as unknown as LandingStorePort['latestAttemptIdForEpic'],
  };
}

// ─── Test helpers for integration section ─────────────────────────────────────

function makeRealStore(): { db: import('better-sqlite3').Database; store: LandingStore } {
  const db = createDatabase(':memory:');
  db.prepare("INSERT INTO epics (id, title, status) VALUES ('epic-real', 'Real Epic', 'planned')").run();
  const store = new LandingStore(db, () => 'sha-placeholder');
  return { db, store };
}

function makeStage(repoSlug: string, dependsOn: string[] = []): RepoStage {
  return {
    repoSlug,
    repoRoot: '/tmp/fake',
    storyIds: [],
    dependsOnRepos: dependsOn,
    status: 'pending',
    prUrl: `https://github.com/org/${repoSlug}/pull/1`,
  };
}

// ─── Unit tests (mock store) ───────────────────────────────────────────────────

describe('landingReport — blocked attempt (AC1)', () => {
  const blocker: LandingBlocker = {
    repoSlug: 'api-service',
    check: 'pr_open',
    reason: 'PR #42 is not open',
  };
  const attempt = makeAttempt('landing-epic-001-0', 'epic-001', 'blocked', blocker);
  const merges = [makeMerge('landing-epic-001-0', 'api-service', 'pending')];
  const store = makeStore(attempt, merges);

  it('report.status is blocked', () => {
    const r = landingReport('landing-epic-001-0', store);
    assert.equal(r.status, 'blocked');
  });

  it('report.blocker names the failing check and repo', () => {
    const r = landingReport('landing-epic-001-0', store);
    assert.ok(r.blocker, 'blocker must be set');
    assert.equal(r.blocker.check, 'pr_open');
    assert.equal(r.blocker.repoSlug, 'api-service');
    assert.equal(r.blocker.reason, 'PR #42 is not open');
  });

  it('report.cleanState is true (no repos were merged)', () => {
    const r = landingReport('landing-epic-001-0', store);
    assert.equal(r.cleanState, true);
  });

  it('report.repos contains the repo with pending state', () => {
    const r = landingReport('landing-epic-001-0', store);
    assert.equal(r.repos.length, 1);
    assert.equal(r.repos[0].repoSlug, 'api-service');
    assert.equal(r.repos[0].mergeState, 'pending');
  });
});

describe('landingReport — blocked on integration_gate (AC1)', () => {
  const blocker: LandingBlocker = {
    repoSlug: 'frontend',
    check: 'integration_gate',
    reason: 'tests failed: 3 suites red',
  };
  const attempt = makeAttempt('landing-epic-002-0', 'epic-002', 'blocked', blocker);
  const merges = [
    makeMerge('landing-epic-002-0', 'api-service', 'pending'),
    makeMerge('landing-epic-002-0', 'frontend', 'pending'),
  ];

  it('names the integration_gate check and the blocking repo', () => {
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-002-0', store);
    assert.equal(r.blocker?.check, 'integration_gate');
    assert.equal(r.blocker?.repoSlug, 'frontend');
  });
});

describe('landingReport — rolled_back attempt (AC2)', () => {
  const blocker: LandingBlocker = {
    repoSlug: 'frontend',
    check: 'integration_gate',
    reason: 'gate red after merge',
  };
  const attempt = makeAttempt('landing-epic-003-0', 'epic-003', 'rolled_back', blocker);
  const merges = [
    makeMerge('landing-epic-003-0', 'api-service', 'reverted'),
    makeMerge('landing-epic-003-0', 'frontend', 'reverted'),
  ];
  const store = makeStore(attempt, merges);

  it('report.status is rolled_back', () => {
    const r = landingReport('landing-epic-003-0', store);
    assert.equal(r.status, 'rolled_back');
  });

  it('surfaces the originating failure cause via report.blocker', () => {
    const r = landingReport('landing-epic-003-0', store);
    assert.ok(r.blocker, 'blocker (originating failure) must be present after rollback');
    assert.equal(r.blocker.check, 'integration_gate');
    assert.equal(r.blocker.repoSlug, 'frontend');
  });

  it('cleanState is true when all repos are reverted', () => {
    const r = landingReport('landing-epic-003-0', store);
    assert.equal(r.cleanState, true, 'cleanState must be true when every repo is reverted');
  });

  it('repos array reflects reverted state for every repo', () => {
    const r = landingReport('landing-epic-003-0', store);
    assert.equal(r.repos.length, 2);
    assert.ok(r.repos.every((repo) => repo.mergeState === 'reverted'));
  });
});

describe('landingReport — cleanState false when merged repo remains (AC2)', () => {
  const blocker: LandingBlocker = {
    repoSlug: 'frontend',
    check: 'pr_open',
    reason: 'PR not open',
  };
  const attempt = makeAttempt('landing-epic-004-0', 'epic-004', 'rolling_back', blocker);
  const merges = [
    makeMerge('landing-epic-004-0', 'api-service', 'merged'),
    makeMerge('landing-epic-004-0', 'frontend', 'pending'),
  ];

  it('cleanState is false when a repo is still in merged state', () => {
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-004-0', store);
    assert.equal(r.cleanState, false);
  });
});

describe('landingReport — cleanState true for mixed pending+reverted (AC2)', () => {
  const attempt = makeAttempt('landing-epic-005-0', 'epic-005', 'rolled_back', {
    repoSlug: 'api-service',
    check: 'pr_open',
    reason: 'test',
  });
  // api-service was never touched (pending); frontend was reverted
  const merges = [
    makeMerge('landing-epic-005-0', 'api-service', 'pending'),
    makeMerge('landing-epic-005-0', 'frontend', 'reverted'),
  ];

  it('cleanState is true for pending+reverted mix', () => {
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-005-0', store);
    assert.equal(r.cleanState, true);
  });
});

describe('landingReport — clean retry clarity (AC3 + ADR-006)', () => {
  it('rolled_back report surfaces the blocker (failure cause) so operator knows WHY', () => {
    const blocker: LandingBlocker = {
      repoSlug: 'api-service',
      check: 'pr_open',
      reason: 'PR closed',
    };
    const attempt = makeAttempt('landing-epic-006-0', 'epic-006', 'rolled_back', blocker);
    const merges = [makeMerge('landing-epic-006-0', 'api-service', 'reverted')];
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-006-0', store);

    assert.ok(r.blocker, 'report must surface the originating failure cause after rollback');
    assert.equal(r.blocker.repoSlug, 'api-service');
  });

  it('cleanState:true is the gate for safe retry — operator needs no manual git repair', () => {
    const attempt = makeAttempt('landing-epic-007-0', 'epic-007', 'rolled_back', null);
    const merges = [makeMerge('landing-epic-007-0', 'api-service', 'reverted')];
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-007-0', store);

    assert.equal(r.cleanState, true, 'cleanState:true signals the repo state is clean for retry');
  });
});

describe('landingReport — attempt without blocker', () => {
  it('report.blocker is undefined when attempt has no blocker', () => {
    const attempt = makeAttempt('landing-epic-008-0', 'epic-008', 'landed', null);
    const merges = [makeMerge('landing-epic-008-0', 'api-service', 'merged')];
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-008-0', store);
    assert.equal(r.blocker, undefined);
  });
});

describe('landingReport — base fields (no-new-channel)', () => {
  it('returns attemptId, epicId, status, repos from the store', () => {
    const attempt = makeAttempt('landing-epic-009-0', 'epic-009', 'staging', null);
    const merges = [
      makeMerge('landing-epic-009-0', 'repo-a', 'pending', 'https://github.com/org/repo-a/pull/5'),
      makeMerge('landing-epic-009-0', 'repo-b', 'pending', null),
    ];
    const store = makeStore(attempt, merges);
    const r = landingReport('landing-epic-009-0', store);

    assert.equal(r.attemptId, 'landing-epic-009-0');
    assert.equal(r.epicId, 'epic-009');
    assert.equal(r.status, 'staging');
    assert.equal(r.repos.length, 2);

    const a = r.repos.find((x) => x.repoSlug === 'repo-a');
    assert.ok(a);
    assert.equal(a.prUrl, 'https://github.com/org/repo-a/pull/5');

    const b = r.repos.find((x) => x.repoSlug === 'repo-b');
    assert.ok(b);
    assert.equal(b.prUrl, null);
  });

  it('only calls store.getAttempt — no other store methods are invoked', () => {
    // The mock store throws on any method other than getAttempt.
    const attempt = makeAttempt('landing-epic-010-0', 'epic-010', 'staging', null);
    const merges: RepoMergeRecord[] = [];
    const store = makeStore(attempt, merges);
    assert.doesNotThrow(() => landingReport('landing-epic-010-0', store));
  });
});

// ─── Integration tests (real DB + LandingStore) ───────────────────────────────

describe('landingReport — integration with real LandingStore (no-new-channel)', () => {
  it('blocked attempt: derives report from DB ledger only, correct blocker', () => {
    const { store } = makeRealStore();
    const attemptId = store.beginAttempt('epic-real', [makeStage('svc-a'), makeStage('svc-b')]);
    const blocker = { repoSlug: 'svc-a', check: 'pr_open' as const, reason: 'PR not open' };
    store.setStatus(attemptId, 'blocked', blocker);

    const r = landingReport(attemptId, store);
    assert.equal(r.status, 'blocked');
    assert.ok(r.blocker);
    assert.equal(r.blocker.repoSlug, 'svc-a');
    assert.equal(r.blocker.check, 'pr_open');
    assert.equal(r.cleanState, true, 'no merges happened so cleanState must be true');
  });

  it('rolled_back attempt: surfaces failure cause and all repos reverted', () => {
    const { store } = makeRealStore();
    const attemptId = store.beginAttempt('epic-real', [makeStage('svc-a'), makeStage('svc-b', ['svc-a'])]);

    store.recordMerge(attemptId, { repoSlug: 'svc-a', prNumber: 1, prUrl: 'https://github.com/org/svc-a/pull/1', mergeCommitSha: 'sha-a' });
    store.recordMerge(attemptId, { repoSlug: 'svc-b', prNumber: 2, prUrl: 'https://github.com/org/svc-b/pull/2', mergeCommitSha: 'sha-b' });
    store.markRevertPending(attemptId, 'svc-b', 'https://github.com/org/svc-b/pull/99');
    store.markReverted(attemptId, 'svc-b', 'sha-b-revert');
    store.markRevertPending(attemptId, 'svc-a', 'https://github.com/org/svc-a/pull/98');
    store.markReverted(attemptId, 'svc-a', 'sha-a-revert');

    const blocker = { repoSlug: 'svc-b', check: 'integration_gate' as const, reason: 'tests failed' };
    store.setStatus(attemptId, 'rolled_back', blocker);

    const r = landingReport(attemptId, store);
    assert.equal(r.status, 'rolled_back');
    assert.ok(r.blocker, 'originating failure cause must be present');
    assert.equal(r.blocker.repoSlug, 'svc-b');
    assert.equal(r.repos.length, 2);
    assert.ok(r.repos.every((repo) => repo.mergeState === 'reverted'));
    assert.equal(r.cleanState, true, 'all reverted ⇒ cleanState must be true');
  });

  it('landingReport does not mutate store state (pure read)', () => {
    const { store } = makeRealStore();
    const attemptId = store.beginAttempt('epic-real', [makeStage('svc-x')]);
    landingReport(attemptId, store);

    // Independently verify the attempt was NOT modified
    const { attempt } = store.getAttempt(attemptId);
    assert.equal(attempt.status, 'staging', 'landingReport must not mutate store state');
  });
});
