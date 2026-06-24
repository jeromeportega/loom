/**
 * story-060-004: Idempotency and re-runnable rollback tests for ForwardReverter.
 *
 * These tests live in a separate file (story-004 ownership) and complement the
 * existing ForwardReverter.test.ts (story-003 ownership) without editing it.
 *
 * Test plan from QA:
 *  (re-run convergence, AC1) run rollback, force second repo's revert merge to
 *    error mid-way, then re-run with healthy seam ⇒ second run completes and
 *    converges to pre-landing state with no error and no exception.
 *  (skip reverted, AC2) a repo_merges row already at mergeState='reverted' is
 *    excluded by pendingReverts and never gets a second git revert — assert it
 *    appears in RollbackResult.skipped.
 *  (resume revert_pending, AC3) a row left at 'revert_pending' resumes from
 *    the existing revert PR rather than opening a new one.
 *  (durable-ordering, AC3) simulate interruption between markRevertPending and
 *    markReverted and assert the re-run reads the persisted state and resumes
 *    — proving each transition is written before its side effect.
 *  (all-reverted DB convergence) when all repos are already reverted the DB
 *    attempt.status is written to 'rolled_back', even if a prior run failed.
 *  (repeated re-runs idempotent) 3 consecutive rollbacks on a finished attempt
 *    each return rolled_back; no git/gh commands after the first run.
 *  (unit: collectSkipped / hasConverged) predicate helpers in rollbackResume.ts.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { createDatabase } from '../../state/Database.js';
import { LandingStore } from '../../state/LandingStore.js';
import { PolicyEngine } from '../../guardrails/PolicyEngine.js';
import { IntegrationGate } from '../IntegrationGate.js';
import { ForwardReverter } from '../ForwardReverter.js';
import { collectSkipped, hasConverged } from '../rollbackResume.js';
import type { RepoMergeRecord } from '../landingTypes.js';
import type { RepoStage } from '../CrossRepoCoordinator.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-freverter-idempotency-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(name: string): Database.Database {
  return createDatabase(path.join(tmpDir, name));
}

function seedEpic(db: Database.Database, epicId = 'epic-test'): void {
  db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES (?, ?, 'planned')").run(
    epicId,
    'Test epic',
  );
}

function makeStage(repoSlug: string, dependsOn: string[] = []): RepoStage {
  return {
    repoSlug,
    repoRoot: `/tmp/${repoSlug}`,
    storyIds: [`story-${repoSlug}-001`],
    dependsOnRepos: dependsOn,
    status: 'pending',
    prUrl: `https://github.com/org/${repoSlug}/pull/1`,
  };
}

function makePassingGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'echo pass',
    runner: async () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 5 }),
  });
}

const DEFAULT_POLICY = new PolicyEngine(PolicyEngine.defaultPolicy());

interface Cmd { type: 'git' | 'gh'; cwd?: string; args: string[] }

function makeStubs(opts: {
  remoteUrl?: string;
  revertPrUrl?: (slug: string) => string;
  mergeSha?: (slug: string) => string;
  onGhCall?: (args: string[], cwd?: string) => void;
} = {}): {
  log: Cmd[];
  execGit: (cwd: string, args: string[]) => string;
  execGh: (args: string[], cwd?: string) => string;
} {
  const log: Cmd[] = [];
  const remoteUrl = opts.remoteUrl ?? 'https://github.com/org/repo';
  const revertPrUrl = opts.revertPrUrl ?? ((slug: string) => `https://github.com/org/${slug}/pull/99`);
  const mergeSha = opts.mergeSha ?? ((slug: string) => `revert-sha-${slug}`);

  const execGit = (cwd: string, args: string[]): string => {
    log.push({ type: 'git', cwd, args });
    if (args[0] === 'remote' && args.length === 1) return 'origin';
    if (args[0] === 'remote' && args[1] === 'get-url') return remoteUrl;
    return '';
  };

  const execGh = (args: string[], cwd?: string): string => {
    log.push({ type: 'gh', cwd, args });
    opts.onGhCall?.(args, cwd);
    if (args[0] === 'pr' && args[1] === 'create') {
      const headIdx = args.indexOf('--head');
      const head = headIdx >= 0 ? args[headIdx + 1] : '';
      const slug = head.split('/').at(-1) ?? 'unknown';
      return JSON.stringify({ url: revertPrUrl(slug) });
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const prUrl = args[2] ?? '';
      const slug = prUrl.split('/').filter(Boolean).at(-3) ?? 'unknown';
      return JSON.stringify({ number: 99, mergeCommit: { oid: mergeSha(slug) } });
    }
    return '';
  };

  return { log, execGit, execGh };
}

function makeReverter(
  store: LandingStore,
  stubs: ReturnType<typeof makeStubs>,
  gate: IntegrationGate = makePassingGate(),
  repoRoots: Record<string, string> = {},
): ForwardReverter {
  return new ForwardReverter({
    projectRoot: '/tmp/project',
    store,
    policy: DEFAULT_POLICY,
    integrationGate: gate,
    allowedRemotes: ['https://github.com/org/*'],
    repoRoots,
    _execGit: stubs.execGit,
    _execGh: stubs.execGh,
  });
}

function seedMerged(
  store: LandingStore,
  stages: RepoStage[],
  mergedSlugs: Array<{ slug: string; sha: string }>,
  epicId = 'epic-test',
): string {
  const attemptId = store.beginAttempt(epicId, stages);
  for (const { slug, sha } of mergedSlugs) {
    store.recordMerge(attemptId, {
      repoSlug: slug,
      prNumber: 1,
      prUrl: `https://github.com/org/${slug}/pull/1`,
      mergeCommitSha: sha,
    });
  }
  return attemptId;
}

// ─── AC1: Re-run convergence ──────────────────────────────────────────────────

describe('ForwardReverter idempotency — re-run convergence (AC1)', () => {
  it('re-run after a mid-rollback failure converges without error and reverts remaining repos', async () => {
    const db = makeDb('rerun-convergence.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    const repoRoots = { 'repo-a': '/tmp/repo-a', 'repo-b': '/tmp/repo-b' };

    // First run: repo-b's pr merge throws after repo-a succeeds.
    let mergeCallCount = 0;
    const failingStubs = makeStubs({
      onGhCall: (args) => {
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeCallCount++;
          if (mergeCallCount === 2) {
            // Second merge (repo-b after repo-a) fails.
            throw new Error('gh: network error (simulated)');
          }
        }
      },
    });
    const firstReverter = makeReverter(store, failingStubs, makePassingGate(), repoRoots);

    await assert.rejects(() => firstReverter.rollback(attemptId));

    // Rollback order is consumer-before-producer: repo-b (consumer) processes first, then repo-a.
    // The second merge call (repo-a) is what throws — so after the first failed run:
    //   repo-b: fully reverted (merge call 1 succeeded)
    //   repo-a: revert_pending (PR created, markRevertPending called, but merge call 2 threw)
    const { attempt: attemptAfterFail, merges: mergesAfterFail } = store.getAttempt(attemptId);
    const aAfterFail = mergesAfterFail.find(m => m.repoSlug === 'repo-a');
    const bAfterFail = mergesAfterFail.find(m => m.repoSlug === 'repo-b');
    assert.equal(bAfterFail?.mergeState, 'reverted', 'repo-b (consumer) must be reverted after first run');
    assert.equal(aAfterFail?.mergeState, 'revert_pending', 'repo-a (producer) must be revert_pending (PR created before merge threw)');
    assert.equal(attemptAfterFail.status, 'failed', 'attempt must be in failed state after first run');

    // Second run (healthy seam): must complete without error.
    const healthyStubs = makeStubs();
    const secondReverter = makeReverter(store, healthyStubs, makePassingGate(), repoRoots);

    let result;
    try {
      result = await secondReverter.rollback(attemptId);
    } catch (err) {
      assert.fail(`Re-run must not throw: ${(err as Error).message}`);
    }

    assert.equal(result.status, 'rolled_back', 'second run must return rolled_back');
    assert.equal(result.reverted.length, 1, 'second run reverts only repo-a (producer)');
    assert.equal(result.reverted[0].repoSlug, 'repo-a');
    assert.ok(result.skipped.includes('repo-b'), 'repo-b must appear in skipped (already reverted)');

    // DB state: all repos reverted, attempt rolled_back.
    const { attempt: finalAttempt, merges: finalMerges } = store.getAttempt(attemptId);
    for (const m of finalMerges) {
      assert.equal(m.mergeState, 'reverted', `${m.repoSlug} must be reverted after second run`);
    }
    assert.equal(finalAttempt.status, 'rolled_back', 'attempt must be rolled_back after second run');

    // No git/gh commands for repo-b on the second run (already reverted).
    const repoBCmds = healthyStubs.log.filter(
      c => c.cwd === '/tmp/repo-b' || (typeof c.args[2] === 'string' && c.args[2].includes('repo-b')),
    );
    assert.equal(repoBCmds.length, 0, 'no commands for repo-b on second run (already reverted)');

    db.close();
  });

  it('re-run after exception before markRevertPending retries from merged state', async () => {
    const db = makeDb('rerun-before-mark.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMerged(store, stages, [{ slug: 'repo-a', sha: 'sha-a' }]);

    // First run: git push throws before gh pr create (before markRevertPending).
    const failBeforeMark = makeStubs({
      onGhCall: (args) => {
        if (args[0] === 'pr' && args[1] === 'create') {
          throw new Error('gh: rate limit (simulated)');
        }
      },
    });
    const firstReverter = makeReverter(store, failBeforeMark, makePassingGate(), {
      'repo-a': '/tmp/repo-a',
    });

    await assert.rejects(() => firstReverter.rollback(attemptId));

    // Repo-a is still 'merged' (markRevertPending was never called).
    const { merges: mergesAfter } = store.getAttempt(attemptId);
    assert.equal(mergesAfter[0].mergeState, 'merged', 'must still be merged before re-run');

    // Second run (healthy): must complete.
    const healthyStubs = makeStubs();
    const secondReverter = makeReverter(store, healthyStubs, makePassingGate(), {
      'repo-a': '/tmp/repo-a',
    });

    const result = await secondReverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 1);
    assert.equal(result.reverted[0].repoSlug, 'repo-a');

    const { merges: finalMerges } = store.getAttempt(attemptId);
    assert.equal(finalMerges[0].mergeState, 'reverted');

    db.close();
  });
});

// ─── AC2: Skip reverted — no revert-of-a-revert ──────────────────────────────

describe('ForwardReverter idempotency — skip reverted, no revert-of-a-revert (AC2)', () => {
  it('a reverted row is excluded from pendingReverts and appears in RollbackResult.skipped', async () => {
    const db = makeDb('skip-reverted.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [
      makeStage('repo-lib'),
      makeStage('repo-app', ['repo-lib']),
      makeStage('repo-svc', ['repo-app']),
    ];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-lib', sha: 'sha-lib' },
      { slug: 'repo-app', sha: 'sha-app' },
      { slug: 'repo-svc', sha: 'sha-svc' },
    ]);

    // Manually mark repo-svc as already fully reverted.
    store.markRevertPending(attemptId, 'repo-svc', 'https://github.com/org/repo-svc/pull/99');
    store.markReverted(attemptId, 'repo-svc', 'already-reverted-sha-svc');

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), {
      'repo-lib': '/tmp/repo-lib',
      'repo-app': '/tmp/repo-app',
      'repo-svc': '/tmp/repo-svc',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.ok(result.skipped.includes('repo-svc'), 'repo-svc must be in skipped');
    assert.ok(!result.reverted.some(r => r.repoSlug === 'repo-svc'), 'repo-svc must not be in reverted');

    // No git revert or gh pr create for repo-svc.
    const svcGitRevert = stubs.log.filter(
      c => c.type === 'git' && c.cwd === '/tmp/repo-svc' && c.args.includes('revert'),
    );
    assert.equal(svcGitRevert.length, 0, 'must not git revert an already-reverted repo');

    const svcPrCreate = stubs.log.filter(
      c => c.type === 'gh' && c.args[1] === 'create' && c.cwd === '/tmp/repo-svc',
    );
    assert.equal(svcPrCreate.length, 0, 'must not open a second revert PR for repo-svc');

    db.close();
  });

  it('pendingReverts never returns a reverted row — verified via store query', () => {
    const db = makeDb('pending-reverts-filter.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = store.beginAttempt('epic-test', stages);
    store.recordMerge(attemptId, { repoSlug: 'repo-a', prNumber: 1, prUrl: 'https://github.com/org/repo-a/pull/1', mergeCommitSha: 'sha-a' });
    store.recordMerge(attemptId, { repoSlug: 'repo-b', prNumber: 1, prUrl: 'https://github.com/org/repo-b/pull/1', mergeCommitSha: 'sha-b' });

    // Mark repo-a as fully reverted.
    store.markRevertPending(attemptId, 'repo-a', 'https://github.com/org/repo-a/pull/99');
    store.markReverted(attemptId, 'repo-a', 'revert-sha-a');

    const pending = store.pendingReverts(attemptId);
    const slugs = pending.map(r => r.repoSlug);

    assert.ok(!slugs.includes('repo-a'), 'pendingReverts must exclude reverted rows');
    assert.ok(slugs.includes('repo-b'), 'pendingReverts must include merged rows');

    db.close();
  });
});

// ─── AC3: Resume from revert_pending — no duplicate PR ───────────────────────

describe('ForwardReverter idempotency — resume from revert_pending (AC3)', () => {
  it('resumes from existing revert PR without re-creating branch or PR', async () => {
    const db = makeDb('resume-pending.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMerged(store, stages, [{ slug: 'repo-a', sha: 'sha-a' }]);

    // Simulate a prior run that created the PR but crashed before merging it.
    const existingPrUrl = 'https://github.com/org/repo-a/pull/77';
    store.markRevertPending(attemptId, 'repo-a', existingPrUrl);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), {
      'repo-a': '/tmp/repo-a',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 1);
    assert.equal(result.reverted[0].repoSlug, 'repo-a');
    assert.equal(result.reverted[0].revertPrUrl, existingPrUrl);

    // No branch creation (PR already exists).
    const checkoutCalls = stubs.log.filter(
      c => c.type === 'git' && c.args.includes('checkout') && c.args.includes('-b'),
    );
    assert.equal(checkoutCalls.length, 0, 'must not re-create revert branch');

    // No git revert (PR already created — commit already reverted in the branch).
    const revertCalls = stubs.log.filter(
      c => c.type === 'git' && c.args.includes('revert'),
    );
    assert.equal(revertCalls.length, 0, 'must not re-run git revert for revert_pending');

    // No gh pr create (PR already exists).
    const prCreateCalls = stubs.log.filter(
      c => c.type === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create',
    );
    assert.equal(prCreateCalls.length, 0, 'must not open a duplicate revert PR');

    // gh pr merge must use the existing PR URL.
    const mergeCalls = stubs.log.filter(
      c => c.type === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge',
    );
    assert.equal(mergeCalls.length, 1, 'must issue exactly one merge call');
    assert.ok(mergeCalls[0].args.includes(existingPrUrl), 'merge must use the existing PR URL');

    db.close();
  });

  it('resume works for multiple repos — pending repo resumes, reverted repo skips', async () => {
    const db = makeDb('resume-mixed.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-lib'), makeStage('repo-app', ['repo-lib'])];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-lib', sha: 'sha-lib' },
      { slug: 'repo-app', sha: 'sha-app' },
    ]);

    // repo-app was fully reverted; repo-lib has a PR but not yet merged.
    store.markRevertPending(attemptId, 'repo-app', 'https://github.com/org/repo-app/pull/88');
    store.markReverted(attemptId, 'repo-app', 'revert-sha-app');
    const libPrUrl = 'https://github.com/org/repo-lib/pull/77';
    store.markRevertPending(attemptId, 'repo-lib', libPrUrl);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), {
      'repo-lib': '/tmp/repo-lib',
      'repo-app': '/tmp/repo-app',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    // repo-lib is the only one that needed action.
    assert.equal(result.reverted.length, 1);
    assert.equal(result.reverted[0].repoSlug, 'repo-lib');
    assert.ok(result.skipped.includes('repo-app'), 'repo-app must be skipped');

    // No checkout or git revert for repo-lib (it was revert_pending).
    const checkoutLib = stubs.log.filter(c => c.type === 'git' && c.cwd === '/tmp/repo-lib' && c.args.includes('checkout'));
    assert.equal(checkoutLib.length, 0, 'must not re-create branch for revert_pending repo-lib');

    db.close();
  });
});

// ─── AC3: Durable ordering — markRevertPending before gh pr merge ────────────

describe('ForwardReverter idempotency — durable ordering (AC3)', () => {
  it('markRevertPending is written durably before gh pr merge; re-run after merge failure resumes', async () => {
    const db = makeDb('durable-order.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMerged(store, stages, [{ slug: 'repo-a', sha: 'sha-a' }]);

    // Spy on the store to verify markRevertPending is called before the merge.
    let prUrlWrittenBeforeMerge: string | null = null;
    let mergeWasCalled = false;
    const spyStore: typeof store = Object.create(store);
    spyStore.markRevertPending = (aid: string, slug: string, url: string) => {
      store.markRevertPending(aid, slug, url);
      prUrlWrittenBeforeMerge = url;
    };

    // gh stub that records the order and throws on pr merge.
    const log: Cmd[] = [];
    const execGit = (cwd: string, args: string[]): string => {
      log.push({ type: 'git', cwd, args });
      if (args[0] === 'remote' && args.length === 1) return 'origin';
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/org/repo';
      return '';
    };
    const execGh = (args: string[], cwd?: string): string => {
      log.push({ type: 'gh', cwd, args });
      if (args[0] === 'pr' && args[1] === 'create') {
        return JSON.stringify({ url: 'https://github.com/org/repo-a/pull/55' });
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        mergeWasCalled = true;
        // Verify the write happened BEFORE we reach the merge call.
        assert.ok(prUrlWrittenBeforeMerge, 'markRevertPending must have been called before gh pr merge');
        throw new Error('gh: merge error (simulated interruption)');
      }
      return '';
    };

    const reverter = new ForwardReverter({
      projectRoot: '/tmp/project',
      store: spyStore,
      policy: DEFAULT_POLICY,
      integrationGate: makePassingGate(),
      allowedRemotes: ['https://github.com/org/*'],
      repoRoots: { 'repo-a': '/tmp/repo-a' },
      _execGit: execGit,
      _execGh: execGh,
    });

    await assert.rejects(() => reverter.rollback(attemptId));

    // Ordering invariant confirmed: markRevertPending was written before merge was called.
    assert.ok(mergeWasCalled, 'merge must have been attempted');
    assert.ok(prUrlWrittenBeforeMerge, 'markRevertPending must be persisted before merge');

    // Re-read the DB to confirm the state is durably stored (not just in-memory).
    const { merges: mergesAfter } = store.getAttempt(attemptId);
    const aRow = mergesAfter.find(m => m.repoSlug === 'repo-a');
    assert.equal(aRow?.mergeState, 'revert_pending', 'state must be durably persisted as revert_pending');
    assert.equal(aRow?.revertPrUrl, prUrlWrittenBeforeMerge, 'revertPrUrl must match what was written');

    // Re-run with healthy seam: must resume from revert_pending (no new PR).
    const healthyLog: Cmd[] = [];
    const healthyGit = (cwd: string, args: string[]): string => {
      healthyLog.push({ type: 'git', cwd, args });
      if (args[0] === 'remote' && args.length === 1) return 'origin';
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/org/repo';
      return '';
    };
    const healthyGh = (args: string[], cwd?: string): string => {
      healthyLog.push({ type: 'gh', cwd, args });
      if (args[0] === 'pr' && args[1] === 'merge') {
        return JSON.stringify({ number: 55, mergeCommit: { oid: 'revert-sha-final' } });
      }
      return '';
    };

    const secondReverter = new ForwardReverter({
      projectRoot: '/tmp/project',
      store,
      policy: DEFAULT_POLICY,
      integrationGate: makePassingGate(),
      allowedRemotes: ['https://github.com/org/*'],
      repoRoots: { 'repo-a': '/tmp/repo-a' },
      _execGit: healthyGit,
      _execGh: healthyGh,
    });

    const result = await secondReverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted[0].repoSlug, 'repo-a');
    assert.equal(result.reverted[0].revertPrUrl, prUrlWrittenBeforeMerge);

    // No gh pr create on second run (state was revert_pending, not merged).
    const prCreateOnResume = healthyLog.filter(c => c.type === 'gh' && c.args[1] === 'create');
    assert.equal(prCreateOnResume.length, 0, 'must not open duplicate PR on resume');

    db.close();
  });

  it('markReverted is written before the next loop iteration — reverted row excluded on re-run', async () => {
    const db = makeDb('durable-mark-reverted.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    // After repo-b's merge succeeds, markReverted is called, then repo-a starts.
    // Simulate a crash right after repo-b's merge (markReverted already called).
    let repoACheckoutAttempted = false;
    const execGit = (cwd: string, args: string[]): string => {
      if (cwd === '/tmp/repo-a' && args.includes('checkout')) {
        repoACheckoutAttempted = true;
        throw new Error('git: checkout error (simulated crash after repo-b merged)');
      }
      if (args[0] === 'remote' && args.length === 1) return 'origin';
      if (args[0] === 'remote' && args[1] === 'get-url') return 'https://github.com/org/repo';
      return '';
    };
    const execGh = (args: string[], cwd?: string): string => {
      if (args[0] === 'pr' && args[1] === 'create') {
        const headIdx = args.indexOf('--head');
        const head = headIdx >= 0 ? args[headIdx + 1] : '';
        const slug = head.split('/').at(-1) ?? 'unknown';
        return JSON.stringify({ url: `https://github.com/org/${slug}/pull/99` });
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        const prUrl = args[2] ?? '';
        const slug = prUrl.split('/').filter(Boolean).at(-3) ?? 'unknown';
        return JSON.stringify({ number: 99, mergeCommit: { oid: `revert-sha-${slug}` } });
      }
      return '';
    };

    const firstReverter = new ForwardReverter({
      projectRoot: '/tmp/project',
      store,
      policy: DEFAULT_POLICY,
      integrationGate: makePassingGate(),
      allowedRemotes: ['https://github.com/org/*'],
      repoRoots: { 'repo-a': '/tmp/repo-a', 'repo-b': '/tmp/repo-b' },
      _execGit: execGit,
      _execGh: execGh,
    });

    // repo-b is processed first (consumer before producer), succeeds fully.
    // repo-a checkout throws (simulated crash).
    await assert.rejects(() => firstReverter.rollback(attemptId));
    assert.ok(repoACheckoutAttempted, 'repo-a checkout was attempted and failed');

    // Durability check: repo-b must be 'reverted' in DB (markReverted called before repo-a loop).
    const { merges: midMerges } = store.getAttempt(attemptId);
    const bMid = midMerges.find(m => m.repoSlug === 'repo-b');
    const aMid = midMerges.find(m => m.repoSlug === 'repo-a');
    assert.equal(bMid?.mergeState, 'reverted', 'repo-b must be durably reverted before re-run');
    assert.equal(aMid?.mergeState, 'merged', 'repo-a must still be merged (checkout failed)');

    // Re-run: only repo-a needs processing; repo-b is skipped.
    const healthyStubs = makeStubs();
    const secondReverter = makeReverter(store, healthyStubs, makePassingGate(), {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    const result = await secondReverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 1, 'only repo-a needs reverting on re-run');
    assert.equal(result.reverted[0].repoSlug, 'repo-a');
    assert.ok(result.skipped.includes('repo-b'), 'repo-b must be skipped (already reverted)');

    // No git/gh commands for repo-b on the second run.
    const repoBCmds = healthyStubs.log.filter(c => c.cwd === '/tmp/repo-b');
    assert.equal(repoBCmds.length, 0, 'no commands for repo-b on second run');

    db.close();
  });
});

// ─── All-reverted early-exit updates DB status ────────────────────────────────

describe('ForwardReverter idempotency — all-reverted convergence updates DB status', () => {
  it('when all repos are already reverted, attempt.status is set to rolled_back in DB', async () => {
    const db = makeDb('all-reverted-status.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    // Mark both repos as fully reverted, but leave attempt.status = 'failed'
    // (simulates a crashed run that wrote the repo rows but not the attempt row).
    store.markRevertPending(attemptId, 'repo-b', 'https://github.com/org/repo-b/pull/99');
    store.markReverted(attemptId, 'repo-b', 'revert-sha-b');
    store.markRevertPending(attemptId, 'repo-a', 'https://github.com/org/repo-a/pull/99');
    store.markReverted(attemptId, 'repo-a', 'revert-sha-a');
    store.setStatus(attemptId, 'failed');

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back', 'result must show rolled_back');
    assert.equal(result.reverted.length, 0, 'nothing to revert');
    assert.ok(result.skipped.includes('repo-a'), 'repo-a in skipped');
    assert.ok(result.skipped.includes('repo-b'), 'repo-b in skipped');

    // The DB attempt.status must now be 'rolled_back', not 'failed'.
    const { attempt } = store.getAttempt(attemptId);
    assert.equal(attempt.status, 'rolled_back', 'DB attempt.status must be rolled_back after convergence');

    // No git/gh commands (everything was already done).
    assert.equal(stubs.log.length, 0, 'no commands when all repos already reverted');

    db.close();
  });
});

// ─── Repeated re-runs are idempotent ─────────────────────────────────────────

describe('ForwardReverter idempotency — repeated re-runs produce identical converged state', () => {
  it('three consecutive rollbacks on a complete attempt all return rolled_back with no commands after first', async () => {
    const db = makeDb('repeated-reruns.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMerged(store, stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    const repoRoots = { 'repo-a': '/tmp/repo-a', 'repo-b': '/tmp/repo-b' };

    // First run: full rollback.
    const stubs1 = makeStubs();
    const r1 = await makeReverter(store, stubs1, makePassingGate(), repoRoots).rollback(attemptId);
    assert.equal(r1.status, 'rolled_back');
    assert.equal(r1.reverted.length, 2);
    assert.ok(stubs1.log.length > 0, 'first run must issue commands');

    // Second run: everything already done.
    const stubs2 = makeStubs();
    const r2 = await makeReverter(store, stubs2, makePassingGate(), repoRoots).rollback(attemptId);
    assert.equal(r2.status, 'rolled_back');
    assert.equal(r2.reverted.length, 0, 'nothing to revert on second run');
    assert.equal(r2.skipped.length, 2, 'both repos skipped on second run');
    assert.equal(stubs2.log.length, 0, 'second run must issue no git/gh commands');

    // Third run: still idempotent.
    const stubs3 = makeStubs();
    const r3 = await makeReverter(store, stubs3, makePassingGate(), repoRoots).rollback(attemptId);
    assert.equal(r3.status, 'rolled_back');
    assert.equal(r3.reverted.length, 0);
    assert.equal(stubs3.log.length, 0, 'third run must also issue no commands');

    // DB state is stable.
    const { attempt, merges } = store.getAttempt(attemptId);
    assert.equal(attempt.status, 'rolled_back');
    for (const m of merges) {
      assert.equal(m.mergeState, 'reverted', `${m.repoSlug} must still be reverted`);
    }

    db.close();
  });
});

// ─── Unit: rollbackResume.ts predicate helpers ────────────────────────────────

describe('rollbackResume — predicate unit tests', () => {
  function record(slug: string, mergeState: RepoMergeRecord['mergeState'], hasSha = true): RepoMergeRecord {
    return {
      attemptId: 'test-attempt',
      repoSlug: slug,
      dependsOn: [],
      prNumber: 1,
      prUrl: null,
      mergeCommitSha: hasSha ? `sha-${slug}` : null,
      mergeState,
      revertPrUrl: null,
      revertMergeSha: null,
      mergedAt: null,
      revertedAt: null,
    };
  }

  describe('collectSkipped', () => {
    it('returns only reverted repos that have a mergeCommitSha', () => {
      const records = [
        record('repo-a', 'reverted'),
        record('repo-b', 'merged'),
        record('repo-c', 'revert_pending'),
        record('repo-d', 'reverted'),
        record('repo-e', 'reverted', false),   // no mergeCommitSha — not a loom merge
      ];
      const skipped = collectSkipped(records);
      assert.deepEqual(skipped.sort(), ['repo-a', 'repo-d']);
    });

    it('returns empty array when no repos are reverted', () => {
      const records = [record('repo-a', 'merged'), record('repo-b', 'pending')];
      assert.deepEqual(collectSkipped(records), []);
    });

    it('returns empty array for empty input', () => {
      assert.deepEqual(collectSkipped([]), []);
    });
  });

  describe('hasConverged', () => {
    it('returns true when all records with a mergeCommitSha are reverted', () => {
      const records = [
        record('repo-a', 'reverted'),
        record('repo-b', 'reverted'),
        record('repo-c', 'pending', false),  // never merged — excluded
      ];
      assert.ok(hasConverged(records), 'should be converged when all merged rows are reverted');
    });

    it('returns false when any merged row is not yet reverted', () => {
      const records = [
        record('repo-a', 'reverted'),
        record('repo-b', 'merged'),
      ];
      assert.ok(!hasConverged(records));
    });

    it('returns false when any row is revert_pending', () => {
      const records = [
        record('repo-a', 'reverted'),
        record('repo-b', 'revert_pending'),
      ];
      assert.ok(!hasConverged(records));
    });

    it('returns false for empty input (not converged — no merges at all)', () => {
      assert.ok(!hasConverged([]));
    });

    it('returns false when records exist but none have a mergeCommitSha', () => {
      const records = [record('repo-a', 'pending', false)];
      assert.ok(!hasConverged(records), 'pending with no anchor is not a converged state');
    });
  });
});
