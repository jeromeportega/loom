/**
 * story-060-003: Unit + integration tests for ForwardReverter.rollback().
 *
 * Test plan from QA:
 *  (happy, AC1+AC5) attempt with producer merged then consumer merge fails ⇒
 *    rollback reverts every already-merged repo anchored to its recorded
 *    merge_commit_sha; returns status:'rolled_back' with one reverted entry per repo.
 *  (order, AC2) reverts execute consumer-before-producer (reverse of depends_on).
 *  (additive-only, AC3) inspect every issued command — assert only git revert +
 *    git push + gh pr create + gh pr merge --squash appear and NO force-push,
 *    branch ref push, or rebase of main; assert PolicyEngine rejects --force.
 *  (guardrails, AC4) when a revert PR fails its own gate, rollback does NOT bypass
 *    it: returns status:'partial' with stranded naming the repo and reason.
 *  (ADR-001 guard) assert ForwardReverter issues no branch-delete or PR-close calls.
 *  (noop boundary) attempt with no merged repos ⇒ status:'noop', no commands issued.
 *  (resume/idempotency) already-reverted repos are skipped; revert_pending repos
 *    resume from the merge step (PR already created).
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
import { PolicySchema } from '../../types.js';
import { IntegrationGate } from '../IntegrationGate.js';
import { ForwardReverter } from '../ForwardReverter.js';
import type { LandingStorePort } from '../landingTypes.js';
import type { RepoStage } from '../CrossRepoCoordinator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-freverter-test-'));
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

function makeStage(repoSlug: string, dependsOn: string[] = [], prUrl?: string): RepoStage {
  return {
    repoSlug,
    repoRoot: `/tmp/${repoSlug}`,
    storyIds: [`story-${repoSlug}-001`],
    dependsOnRepos: dependsOn,
    status: 'pending',
    prUrl: prUrl ?? `https://github.com/org/${repoSlug}/pull/1`,
  };
}

/** Fake gate that always passes (testCommand forces runner invocation). */
function makePassingGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'echo pass',
    runner: async () => ({ exitCode: 0, output: 'ok', timedOut: false, durationMs: 5 }),
  });
}

/** Fake gate that always fails. */
function makeFailingGate(): IntegrationGate {
  return new IntegrationGate({
    testCommand: 'echo fail',
    runner: async () => ({ exitCode: 1, output: 'FAIL', timedOut: false, durationMs: 5 }),
  });
}

/** Default PolicyEngine (forbidden_flags = ['--force','--force-with-lease','--hard']). */
const DEFAULT_POLICY = new PolicyEngine(PolicyEngine.defaultPolicy());

/** A command log entry — records what was run. */
interface Cmd { type: 'git' | 'gh'; cwd?: string; args: string[] }

/**
 * Returns stub git/gh executors that record every issued command.
 * git remote → 'origin'; git remote get-url → remoteUrl.
 * gh pr create → JSON { url: revertPrUrl(slug) }.
 * gh pr merge → JSON { number: 99, mergeCommit: { oid: mergeSha(slug) } }.
 */
function makeStubs(opts: {
  remoteUrl?: string;
  revertPrUrl?: (slug: string) => string;
  mergeSha?: (slug: string) => string;
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

/** Seeds the store with merged repos. */
function seedMergedRepo(
  store: LandingStore,
  epicId: string,
  stages: RepoStage[],
  mergedSlugs: Array<{ slug: string; sha: string; prNumber?: number }>,
): string {
  const attemptId = store.beginAttempt(epicId, stages);
  for (const { slug, sha, prNumber } of mergedSlugs) {
    store.recordMerge(attemptId, {
      repoSlug: slug,
      prNumber: prNumber ?? 1,
      prUrl: `https://github.com/org/${slug}/pull/1`,
      mergeCommitSha: sha,
    });
  }
  return attemptId;
}

function makeReverter(
  store: LandingStorePort,
  stubs: ReturnType<typeof makeStubs>,
  gate: IntegrationGate = makePassingGate(),
  policy: PolicyEngine = DEFAULT_POLICY,
  repoRoots: Record<string, string> = {},
  allowedRemotes = ['https://github.com/org/*'],
): ForwardReverter {
  return new ForwardReverter({
    projectRoot: '/tmp/project',
    store,
    policy,
    integrationGate: gate,
    allowedRemotes,
    repoRoots,
    _execGit: stubs.execGit,
    _execGh: stubs.execGh,
  });
}

// ─── Noop boundary ────────────────────────────────────────────────────────────

describe('ForwardReverter — noop boundary (no merged repos)', () => {
  it('returns status:noop and issues no commands when no repos are merged', async () => {
    const db = makeDb('noop.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = store.beginAttempt('epic-test', stages);
    // Both repos still pending — nothing to revert.

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs);

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'noop');
    assert.deepEqual(result.reverted, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(stubs.log.length, 0, 'no commands issued for noop');
    db.close();
  });
});

// ─── Happy path (AC1 + AC5) ───────────────────────────────────────────────────

describe('ForwardReverter — happy path (AC1+AC5)', () => {
  it('rolls back all merged repos and returns status:rolled_back with one entry per repo', async () => {
    const db = makeDb('happy.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');

    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a-merge' },
      { slug: 'repo-b', sha: 'sha-b-merge' },
    ]);

    const stubs = makeStubs({
      revertPrUrl: (slug) => `https://github.com/org/${slug}/pull/99`,
      mergeSha: (slug) => `revert-sha-${slug}`,
    });
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 2, 'two repos reverted');
    assert.ok(result.reverted.some(r => r.repoSlug === 'repo-a'));
    assert.ok(result.reverted.some(r => r.repoSlug === 'repo-b'));
    assert.deepEqual(result.skipped, []);
    assert.equal(result.stranded, undefined);

    const { merges } = store.getAttempt(attemptId);
    for (const m of merges) {
      assert.equal(m.mergeState, 'reverted', `${m.repoSlug} should be reverted in ledger`);
      assert.ok(m.revertMergeSha, `${m.repoSlug} revertMergeSha should be set`);
    }
    db.close();
  });

  it('git revert uses the recorded mergeCommitSha as the anchor (AC1)', async () => {
    const db = makeDb('sha-anchor.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'abc123merge' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    await reverter.rollback(attemptId);

    const revertCall = stubs.log.find(
      c => c.type === 'git' && c.args.includes('revert'),
    );
    assert.ok(revertCall, 'git revert must be issued');
    assert.ok(revertCall.args.includes('abc123merge'), 'git revert must use the recorded merge SHA');
    assert.ok(revertCall.args.includes('--no-edit'), 'git revert must use --no-edit');
    assert.ok(revertCall.args.includes('-m'), 'git revert must use -m 1 (mainline)');
    assert.equal(revertCall.args[revertCall.args.indexOf('-m') + 1], '1');
    db.close();
  });

  it('revert branch follows the revert/<attemptId>/<repoSlug> naming convention', async () => {
    const db = makeDb('branch-name.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha1' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    await reverter.rollback(attemptId);

    const checkoutCall = stubs.log.find(
      c => c.type === 'git' && c.args.includes('checkout') && c.args.includes('-b'),
    );
    assert.ok(checkoutCall, 'git checkout -b must be issued');
    const bIdx = checkoutCall.args.indexOf('-b');
    const branchArg = checkoutCall.args[bIdx + 1];
    assert.ok(branchArg?.startsWith(`revert/${attemptId}/`), `branch must start with revert/<attemptId>/`);
    assert.ok(branchArg?.endsWith('repo-a'), 'branch must end with repoSlug');
    db.close();
  });

  it('revert entry in RollbackResult includes revertPrUrl and revertMergeSha (AC5)', async () => {
    const db = makeDb('result-fields.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    const stubs = makeStubs({
      revertPrUrl: () => 'https://github.com/org/repo-a/pull/99',
      mergeSha: () => 'revert-merge-sha-a',
    });
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.reverted.length, 1);
    const entry = result.reverted[0];
    assert.equal(entry.repoSlug, 'repo-a');
    assert.equal(entry.revertPrUrl, 'https://github.com/org/repo-a/pull/99');
    assert.ok(entry.revertMergeSha, 'revertMergeSha must be set');
    db.close();
  });
});

// ─── Reverse dependency order (AC2) ──────────────────────────────────────────

describe('ForwardReverter — reverse dependency order (AC2)', () => {
  it('reverts consumer before producer (reverse depends_on)', async () => {
    const db = makeDb('order.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');

    const stages = [
      makeStage('repo-lib'),
      makeStage('repo-app', ['repo-lib']),
    ];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-lib', sha: 'sha-lib' },
      { slug: 'repo-app', sha: 'sha-app' },
    ]);

    const revertOrder: string[] = [];
    const stubs = makeStubs();
    const origExecGit = stubs.execGit;
    const trackingExecGit = (cwd: string, args: string[]): string => {
      if (args[0] === 'revert') {
        const slug = cwd.split('/').at(-1) ?? cwd;
        revertOrder.push(slug);
      }
      return origExecGit(cwd, args);
    };

    const reverter = new ForwardReverter({
      projectRoot: '/tmp/project',
      store,
      policy: DEFAULT_POLICY,
      integrationGate: makePassingGate(),
      allowedRemotes: ['https://github.com/org/*'],
      repoRoots: { 'repo-lib': '/tmp/repo-lib', 'repo-app': '/tmp/repo-app' },
      _execGit: trackingExecGit,
      _execGh: stubs.execGh,
    });

    await reverter.rollback(attemptId);

    assert.deepEqual(revertOrder, ['repo-app', 'repo-lib'],
      'consumer (repo-app) must be reverted before producer (repo-lib)');
    db.close();
  });

  it('returns reverted entries in consumer-before-producer order', async () => {
    const db = makeDb('order-result.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-lib'), makeStage('repo-app', ['repo-lib'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-lib', sha: 'sha-lib' },
      { slug: 'repo-app', sha: 'sha-app' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-lib': '/tmp/repo-lib',
      'repo-app': '/tmp/repo-app',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.reverted[0].repoSlug, 'repo-app', 'consumer first in result');
    assert.equal(result.reverted[1].repoSlug, 'repo-lib', 'producer second in result');
    db.close();
  });
});

// ─── Additive-only (AC3) ──────────────────────────────────────────────────────

describe('ForwardReverter — additive-only (AC3)', () => {
  it('issues only git checkout, git revert, git push, gh pr create, gh pr merge — never force-push', async () => {
    const db = makeDb('additive.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    await reverter.rollback(attemptId);

    const gitCmds = stubs.log.filter(c => c.type === 'git');
    const ghCmds = stubs.log.filter(c => c.type === 'gh');

    // No force-push.
    for (const cmd of gitCmds) {
      assert.ok(
        !cmd.args.includes('--force') && !cmd.args.includes('--force-with-lease'),
        `git command must not contain --force: ${cmd.args.join(' ')}`,
      );
    }

    // No rebase or hard reset of main.
    for (const cmd of gitCmds) {
      assert.ok(!cmd.args.includes('rebase'), `must not rebase: ${cmd.args.join(' ')}`);
      if (cmd.args.includes('reset')) {
        assert.ok(!cmd.args.includes('--hard'), 'must not reset --hard');
      }
    }

    // No branch deletion.
    for (const cmd of gitCmds) {
      if (cmd.args.includes('branch')) {
        assert.ok(!cmd.args.includes('-D'), 'must not git branch -D');
        assert.ok(!cmd.args.includes('-d'), 'must not git branch -d');
      }
      if (cmd.args.includes('push')) {
        assert.ok(!cmd.args.includes('-d'), 'must not push -d (delete remote ref)');
        assert.ok(!cmd.args.includes('--delete'), 'must not push --delete');
      }
    }

    // No PR close.
    for (const cmd of ghCmds) {
      assert.ok(
        !(cmd.args[0] === 'pr' && cmd.args[1] === 'close'),
        'must not gh pr close (ADR-001)',
      );
    }

    // gh pr merge must use --squash (never rebase or no strategy).
    const mergeCmd = ghCmds.find(c => c.args[0] === 'pr' && c.args[1] === 'merge');
    assert.ok(mergeCmd, 'gh pr merge must be issued');
    assert.ok(mergeCmd.args.includes('--squash'), 'gh pr merge must use --squash');
    assert.ok(!mergeCmd.args.includes('--rebase'), 'gh pr merge must not use --rebase');
    db.close();
  });

  it('PolicyEngine rejects git push --force (additive-only invariant)', () => {
    const result = DEFAULT_POLICY.check('git push origin main --force');
    assert.equal(result.allowed, false, 'policy must block --force push');
    assert.equal(result.rule, 'git.forbidden_flags');
  });

  it('PolicyEngine rejects git reset --hard HEAD~1 (history rewrite blocked)', () => {
    const result = DEFAULT_POLICY.check('git reset --hard HEAD~1');
    assert.equal(result.allowed, false, 'policy must block --hard reset');
    assert.equal(result.rule, 'git.forbidden_flags');
  });

  it('PolicyEngine allows git revert --no-edit -m 1 (the only revert command used)', () => {
    const result = DEFAULT_POLICY.check('git revert --no-edit -m 1 abc1234');
    assert.equal(result.allowed, true, 'git revert --no-edit -m 1 must be allowed by policy');
  });

  it('PolicyEngine allows git push origin <revert-branch> (non-protected branch push)', () => {
    const result = DEFAULT_POLICY.check('git push origin revert/landing-epic-001-0/repo-a');
    assert.equal(result.allowed, true, 'revert branch push must be allowed by policy');
  });

  it('PolicyEngine blocks git push origin main (direct push to protected branch)', () => {
    const result = DEFAULT_POLICY.check('git push origin main');
    assert.equal(result.allowed, false, 'direct push to main must be blocked');
    assert.equal(result.rule, 'git.protected_branches');
  });
});

// ─── Guardrails — gate failure strands (AC4) ─────────────────────────────────

describe('ForwardReverter — gate failure strands (AC4)', () => {
  it('returns status:partial with stranded when a revert PR fails its integration gate', async () => {
    const db = makeDb('strand.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makeFailingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'partial');
    assert.ok(result.stranded, 'stranded must be set');
    assert.equal(result.stranded?.repoSlug, 'repo-a');
    assert.ok(result.stranded?.reason, 'stranded must include a reason');

    // gh pr merge must NOT be called — gate failure prevented the merge.
    const mergeCmd = stubs.log.find(c => c.type === 'gh' && c.args.includes('merge'));
    assert.equal(mergeCmd, undefined, 'must not call gh pr merge when gate fails');
    db.close();
  });

  it('stranded rollback does not mark the repo as reverted in the ledger', async () => {
    const db = makeDb('strand-ledger.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makeFailingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    await reverter.rollback(attemptId);

    const { merges } = store.getAttempt(attemptId);
    const aRecord = merges.find(m => m.repoSlug === 'repo-a');
    assert.ok(aRecord, 'repo-a merge record must exist');
    assert.notEqual(aRecord?.mergeState, 'reverted', 'gate-stranded repo must NOT be marked reverted');
    db.close();
  });

  it('stranded rollback still records the revert_pending state in the ledger', async () => {
    const db = makeDb('strand-pending.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makeFailingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    await reverter.rollback(attemptId);

    const { merges } = store.getAttempt(attemptId);
    const aRecord = merges.find(m => m.repoSlug === 'repo-a');
    // PR was created before gate check, so state should be revert_pending.
    assert.equal(aRecord?.mergeState, 'revert_pending', 'PR was opened so state is revert_pending');
    assert.ok(aRecord?.revertPrUrl, 'revert PR URL should be recorded');
    db.close();
  });

  it('strands on producer after consumer is fully reverted (partial multi-repo)', async () => {
    const db = makeDb('strand-partial.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-lib'), makeStage('repo-app', ['repo-lib'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-lib', sha: 'sha-lib' },
      { slug: 'repo-app', sha: 'sha-app' },
    ]);

    // First gate call (consumer repo-app) passes; second (producer repo-lib) fails.
    let gateCallCount = 0;
    const mixedGate = new IntegrationGate({
      testCommand: 'echo test',
      runner: async () => {
        gateCallCount++;
        const pass = gateCallCount === 1;
        return { exitCode: pass ? 0 : 1, output: pass ? 'ok' : 'FAIL', timedOut: false, durationMs: 5 };
      },
    });

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, mixedGate, DEFAULT_POLICY, {
      'repo-lib': '/tmp/repo-lib',
      'repo-app': '/tmp/repo-app',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'partial');
    assert.equal(result.reverted.length, 1, 'one repo fully reverted before strand');
    assert.equal(result.reverted[0].repoSlug, 'repo-app', 'consumer reverted before strand');
    assert.ok(result.stranded, 'stranded must be set for producer');
    assert.equal(result.stranded?.repoSlug, 'repo-lib');
    db.close();
  });
});

// ─── ADR-001 guard: not EpicReverter ─────────────────────────────────────────

describe('ForwardReverter — ADR-001 guard (no branch-delete or PR-close)', () => {
  it('never issues branch-delete or PR-close commands across a full rollback', async () => {
    const db = makeDb('adr001.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    await reverter.rollback(attemptId);

    // No git branch -D or -d.
    for (const cmd of stubs.log.filter(c => c.type === 'git')) {
      if (cmd.args.includes('branch')) {
        assert.ok(!cmd.args.includes('-D'), 'must not use git branch -D');
        assert.ok(!cmd.args.includes('-d'), 'must not use git branch -d');
      }
      if (cmd.args.includes('push')) {
        assert.ok(!cmd.args.includes('-d') && !cmd.args.includes('--delete'), 'must not push --delete');
      }
    }

    // No gh pr close.
    for (const cmd of stubs.log.filter(c => c.type === 'gh')) {
      assert.ok(!(cmd.args[0] === 'pr' && cmd.args[1] === 'close'), 'must not gh pr close');
    }

    // No worktree remove.
    for (const cmd of stubs.log.filter(c => c.type === 'git')) {
      if (cmd.args.includes('worktree')) {
        assert.ok(!cmd.args.includes('remove'), 'must not run git worktree remove');
      }
    }
    db.close();
  });
});

// ─── Idempotency / resume ─────────────────────────────────────────────────────

describe('ForwardReverter — idempotency and resume', () => {
  it('skips repos already at mergeState:reverted', async () => {
    const db = makeDb('idempotent.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a'), makeStage('repo-b', ['repo-a'])];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
      { slug: 'repo-b', sha: 'sha-b' },
    ]);

    // Manually mark repo-b as already reverted.
    store.markRevertPending(attemptId, 'repo-b', 'https://github.com/org/repo-b/pull/99');
    store.markReverted(attemptId, 'repo-b', 'already-reverted-sha');

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
      'repo-b': '/tmp/repo-b',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 1, 'only repo-a re-reverted');
    assert.equal(result.reverted[0].repoSlug, 'repo-a');
    assert.ok(result.skipped.includes('repo-b'), 'repo-b must be in skipped list');
    db.close();
  });

  it('resumes a revert_pending repo by merging its existing PR (no re-create)', async () => {
    const db = makeDb('resume.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    // Simulate a prior crashed run: PR created but not merged.
    const existingPrUrl = 'https://github.com/org/repo-a/pull/99';
    store.markRevertPending(attemptId, 'repo-a', existingPrUrl);

    const stubs = makeStubs();
    const reverter = makeReverter(store, stubs, makePassingGate(), DEFAULT_POLICY, {
      'repo-a': '/tmp/repo-a',
    });

    const result = await reverter.rollback(attemptId);

    assert.equal(result.status, 'rolled_back');
    assert.equal(result.reverted.length, 1);

    // Must NOT issue another git checkout or git revert (PR already exists).
    const checkoutCalls = stubs.log.filter(
      c => c.type === 'git' && c.args.includes('checkout'),
    );
    assert.equal(checkoutCalls.length, 0, 'must not re-create branch for revert_pending');

    const revertCalls = stubs.log.filter(
      c => c.type === 'git' && c.args.includes('revert'),
    );
    assert.equal(revertCalls.length, 0, 'must not re-run git revert for revert_pending');

    // Must merge the existing PR.
    const mergeCmds = stubs.log.filter(c => c.type === 'gh' && c.args.includes('merge'));
    assert.equal(mergeCmds.length, 1, 'one merge command for resume');
    assert.ok(mergeCmds[0].args.includes(existingPrUrl), 'must merge the existing PR URL');
    db.close();
  });
});

// ─── Policy gate — commands checked before execution ─────────────────────────

describe('ForwardReverter — policy gate (commands pre-checked)', () => {
  it('throws before executing git revert when policy blocks the command', async () => {
    const db = makeDb('policy-revert.db');
    seedEpic(db);
    const store = new LandingStore(db, () => '');
    const stages = [makeStage('repo-a')];
    const attemptId = seedMergedRepo(store, 'epic-test', stages, [
      { slug: 'repo-a', sha: 'sha-a' },
    ]);

    // Policy that blocks --no-edit (ForwardReverter always passes --no-edit to git revert).
    const restrictedPolicy = new PolicyEngine(
      PolicySchema.parse({ git: { forbidden_flags: ['--force', '--no-edit'] } }),
    );

    const stubs = makeStubs();
    const reverter = new ForwardReverter({
      projectRoot: '/tmp/project',
      store,
      policy: restrictedPolicy,
      integrationGate: makePassingGate(),
      allowedRemotes: ['https://github.com/org/*'],
      repoRoots: { 'repo-a': '/tmp/repo-a' },
      _execGit: stubs.execGit,
      _execGh: stubs.execGh,
    });

    await assert.rejects(
      () => reverter.rollback(attemptId),
      /ForwardReverter: policy blocked/,
    );

    // git revert itself should NOT have been executed.
    const revertCalls = stubs.log.filter(c => c.type === 'git' && c.args.includes('revert'));
    assert.equal(revertCalls.length, 0, 'git revert must not execute when policy blocks it');
    db.close();
  });
});
