import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createDatabase, runMigrations, SCHEMA_VERSION } from '../Database.js';
import { LandingStore, makeAnchoringMerger } from '../LandingStore.js';
import type { RepoStage } from '../../orchestrator/CrossRepoCoordinator.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-landingstore-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(name: string): Database.Database {
  return createDatabase(path.join(tmpDir, name));
}

function seedEpic(db: Database.Database, epicId = 'epic-test'): void {
  db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES (?, ?, 'planned')").run(
    epicId,
    'Test epic',
  );
}

function makeStage(repoSlug: string, repoRoot: string, dependsOn: string[] = []): RepoStage {
  return {
    repoSlug,
    repoRoot,
    storyIds: [`story-${repoSlug}-001`],
    dependsOnRepos: dependsOn,
    status: 'pending',
    prUrl: `https://github.com/org/repo/pull/1`,
  };
}

/** Initialises a minimal git repo with one commit; returns its HEAD SHA. */
function initGitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', dir]);
  execFileSync('git', [
    '-C', dir,
    '-c', 'user.email=test@loom.test',
    '-c', 'user.name=Test',
    'commit', '--allow-empty', '-m', 'init',
  ]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// ─── Migration tests ──────────────────────────────────────────────────────────

describe('schema v27 migration', () => {
  it('creates landing_attempts, repo_merges, index, and UNIQUE constraint on a fresh DB', () => {
    const db = makeDb('v27-fresh.db');

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name);
    assert.ok(tables.includes('landing_attempts'), 'landing_attempts table exists');
    assert.ok(tables.includes('repo_merges'), 'repo_merges table exists');

    // Index exists
    const indices = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
      .map(r => r.name);
    assert.ok(indices.includes('idx_repo_merges_attempt'), 'idx_repo_merges_attempt index exists');

    // UNIQUE constraint is enforced — inserting a duplicate (attempt_id, repo_slug) throws
    db.prepare("INSERT OR IGNORE INTO epics (id, title, status) VALUES ('e1', 't', 'planned')").run();
    db.prepare("INSERT INTO landing_attempts (id, epic_id, status) VALUES ('a1', 'e1', 'staging')").run();
    db.prepare("INSERT INTO repo_merges (attempt_id, repo_slug, merge_state) VALUES ('a1', 'r1', 'pending')").run();
    assert.throws(() => {
      db.prepare("INSERT INTO repo_merges (attempt_id, repo_slug, merge_state) VALUES ('a1', 'r1', 'pending')").run();
    }, 'duplicate (attempt_id, repo_slug) must throw');

    assert.equal(SCHEMA_VERSION, 27);
    db.close();
  });

  it('bumps schema_version to 27', () => {
    const db = makeDb('v27-version.db');
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    assert.equal(row.version, 27);
    db.close();
  });

  it('migrates idempotently — running migrations twice does not throw or duplicate tables', () => {
    const dbPath = path.join(tmpDir, 'v27-idempotent.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    assert.doesNotThrow(() => runMigrations(db), 'second runMigrations must not throw');
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number };
    assert.equal(row.version, 27);
    db.close();
  });
});

// ─── LandingStore.beginAttempt tests ─────────────────────────────────────────

describe('LandingStore.beginAttempt', () => {
  it('returns an attemptId with the correct format (landing-<epicId>-<seq>)', () => {
    const db = makeDb('begin-format.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp/no-git-here')]);
    assert.equal(id, 'landing-epic-test-0');
    db.close();
  });

  it('increments the sequence for subsequent attempts on the same epic', () => {
    const db = makeDb('begin-seq.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const stage = makeStage('repo-a', '/tmp/no-git-here');
    const id0 = store.beginAttempt('epic-test', [stage]);
    const id1 = store.beginAttempt('epic-test', [stage]);
    assert.equal(id0, 'landing-epic-test-0');
    assert.equal(id1, 'landing-epic-test-1');
    db.close();
  });

  it('persists status = staging', () => {
    const db = makeDb('begin-status.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp/no-git-here')]);
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.status, 'staging');
    db.close();
  });

  it('persists a repo_merges row per stage with merge_state = pending', () => {
    const db = makeDb('begin-rows.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const stages = [makeStage('repo-a', '/tmp'), makeStage('repo-b', '/tmp', ['repo-a'])];
    const id = store.beginAttempt('epic-test', stages);
    const { merges } = store.getAttempt(id);
    assert.equal(merges.length, 2);
    assert.ok(merges.every(m => m.mergeState === 'pending'));
    assert.ok(merges.some(m => m.repoSlug === 'repo-a'));
    assert.ok(merges.some(m => m.repoSlug === 'repo-b'));
    db.close();
  });

  it('persists dependsOn for each stage', () => {
    const db = makeDb('begin-deps.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const stages = [makeStage('repo-a', '/tmp'), makeStage('repo-b', '/tmp', ['repo-a'])];
    const id = store.beginAttempt('epic-test', stages);
    const { merges } = store.getAttempt(id);
    const b = merges.find(m => m.repoSlug === 'repo-b')!;
    assert.deepEqual(b.dependsOn, ['repo-a']);
    db.close();
  });

  it('captures the pre-landing HEAD SHA for a real git repo (AC2)', () => {
    const db = makeDb('begin-sha.db');
    seedEpic(db);
    const store = new LandingStore(db);

    const gitDir = path.join(tmpDir, 'git-repo-sha');
    const expectedSha = initGitRepo(gitDir);

    const id = store.beginAttempt('epic-test', [makeStage('repo-a', gitDir)]);
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.baseShas['repo-a'], expectedSha, 'baseSha matches HEAD of git repo');
    db.close();
  });

  it('stores empty string for baseSha when repoRoot is not a git repo', () => {
    const db = makeDb('begin-sha-empty.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const nonGitDir = path.join(tmpDir, 'not-a-git-dir');
    fs.mkdirSync(nonGitDir, { recursive: true });
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', nonGitDir)]);
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.baseShas['repo-a'], '');
    db.close();
  });
});

// ─── LandingStore.recordMerge tests ──────────────────────────────────────────

describe('LandingStore.recordMerge', () => {
  it('persists merge_commit_sha, pr_number, pr_url and flips merge_state to merged (AC1)', () => {
    const db = makeDb('record-merge-happy.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const stage = makeStage('repo-a', '/tmp');
    const id = store.beginAttempt('epic-test', [stage]);

    store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
      mergeCommitSha: 'abc123def456',
    });

    const { merges } = store.getAttempt(id);
    const m = merges.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(m.mergeCommitSha, 'abc123def456');
    assert.equal(m.prNumber, 42);
    assert.equal(m.prUrl, 'https://github.com/org/repo/pull/42');
    assert.equal(m.mergeState, 'merged');
    assert.ok(m.mergedAt !== null, 'merged_at is populated');
    db.close();
  });

  it('is retrievable via getAttempt scoped to that attempt only (AC2)', () => {
    const db = makeDb('record-merge-scoped.db');
    seedEpic(db, 'epic-x');
    seedEpic(db, 'epic-y');
    const store = new LandingStore(db);

    const idX = store.beginAttempt('epic-x', [makeStage('repo-a', '/tmp')]);
    const idY = store.beginAttempt('epic-y', [makeStage('repo-a', '/tmp')]);

    store.recordMerge(idX, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha-for-x',
    });

    const { merges: mergesX } = store.getAttempt(idX);
    const { merges: mergesY } = store.getAttempt(idY);

    assert.equal(mergesX.find(m => m.repoSlug === 'repo-a')?.mergeCommitSha, 'sha-for-x');
    assert.equal(mergesY.find(m => m.repoSlug === 'repo-a')?.mergeState, 'pending',
      'attempt Y must not see attempt X merge record');
    db.close();
  });
});

// ─── recordMerge error cases ──────────────────────────────────────────────────

describe('LandingStore.recordMerge — error paths', () => {
  it('throws when (attempt_id, repo_slug) row does not exist (changes !== 1)', () => {
    const db = makeDb('record-merge-missing.db');
    seedEpic(db);
    const store = new LandingStore(db);
    // beginAttempt NOT called for 'nonexistent-repo'
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    assert.throws(
      () => store.recordMerge(id, {
        repoSlug: 'nonexistent-repo',
        prNumber: 99,
        prUrl: 'https://github.com/org/repo/pull/99',
        mergeCommitSha: 'sha-xyz',
      }),
      /no row found.*nonexistent-repo/,
      'must throw when no matching repo_merges row exists',
    );
    db.close();
  });
});

// ─── Uniqueness boundary test ─────────────────────────────────────────────────

describe('repo_merges uniqueness boundary', () => {
  it('a second recordMerge for the same (attempt_id, repo_slug) is a no-op — the anchor SHA is preserved', () => {
    const db = makeDb('uniqueness.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);

    store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha-first',
    });
    // Second call — same slug, different SHA. With the merge_state='pending' guard,
    // the row is already 'merged' so the UPDATE is a no-op (anchor SHA is preserved).
    assert.doesNotThrow(() => store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha-second',
    }), 'second recordMerge must not throw — idempotent no-op');

    const count = (db.prepare(
      "SELECT COUNT(*) as cnt FROM repo_merges WHERE attempt_id = ? AND repo_slug = 'repo-a'",
    ).get(id) as { cnt: number }).cnt;
    assert.equal(count, 1, 'only one row must exist (no duplicate)');

    const { merges } = store.getAttempt(id);
    assert.equal(merges[0].mergeCommitSha, 'sha-first', 'first SHA is anchored — second call cannot overwrite it');
    db.close();
  });
});

// ─── Anchoring / pendingReverts test (AC3) ────────────────────────────────────

describe('LandingStore.pendingReverts — anchoring boundary (AC3)', () => {
  it('a repo with no recordMerge call produces no row in pendingReverts', () => {
    const db = makeDb('anchoring.db');
    seedEpic(db);
    const store = new LandingStore(db);
    // Two repos; only record a merge for repo-a
    const id = store.beginAttempt('epic-test', [
      makeStage('repo-a', '/tmp'),
      makeStage('repo-b', '/tmp', ['repo-a']),
    ]);

    store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha-a',
    });
    // repo-b is NOT merged (simulates a concurrent human merge or unfinished run)

    const pending = store.pendingReverts(id);
    assert.equal(pending.length, 1, 'only the loom-merged repo appears in pendingReverts');
    assert.equal(pending[0].repoSlug, 'repo-a');
    assert.ok(
      !pending.some(r => r.repoSlug === 'repo-b'),
      'repo-b (not merged by loom) is absent from pendingReverts',
    );
    db.close();
  });

  it('returns records in reverse dependency order (consumer before producer)', () => {
    const db = makeDb('anchoring-order.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [
      makeStage('producer', '/tmp'),
      makeStage('consumer', '/tmp', ['producer']),
    ]);

    // Merge both repos
    for (const slug of ['producer', 'consumer']) {
      store.recordMerge(id, {
        repoSlug: slug,
        prNumber: 1,
        prUrl: `https://github.com/org/repo/pull/1`,
        mergeCommitSha: `sha-${slug}`,
      });
    }

    const pending = store.pendingReverts(id);
    assert.equal(pending.length, 2);
    // Consumer must come before producer on rollback
    assert.equal(pending[0].repoSlug, 'consumer', 'consumer reverted first');
    assert.equal(pending[1].repoSlug, 'producer', 'producer reverted second');
    db.close();
  });

  it('correctly orders a 3-node chain (A→B→C) — topological sort, not pairwise (C first, then B, then A)', () => {
    const db = makeDb('anchoring-order-3node.db');
    seedEpic(db);
    const store = new LandingStore(db);
    // A is the root producer, B depends on A, C depends on B
    const id = store.beginAttempt('epic-test', [
      makeStage('repo-a', '/tmp'),
      makeStage('repo-b', '/tmp', ['repo-a']),
      makeStage('repo-c', '/tmp', ['repo-b']),
    ]);

    for (const slug of ['repo-a', 'repo-b', 'repo-c']) {
      store.recordMerge(id, {
        repoSlug: slug,
        prNumber: 1,
        prUrl: 'https://github.com/org/repo/pull/1',
        mergeCommitSha: `sha-${slug}`,
      });
    }

    const pending = store.pendingReverts(id);
    assert.equal(pending.length, 3);
    // Rollback must be C → B → A (leaf consumer first, root producer last)
    assert.equal(pending[0].repoSlug, 'repo-c', 'repo-c (leaf consumer) reverted first');
    assert.equal(pending[1].repoSlug, 'repo-b', 'repo-b (mid node) reverted second');
    assert.equal(pending[2].repoSlug, 'repo-a', 'repo-a (root producer) reverted last');
    db.close();
  });
});

// ─── LandingStore.setStatus tests ─────────────────────────────────────────────

describe('LandingStore.setStatus', () => {
  it('transitions staging → merging after beginAttempt', () => {
    const db = makeDb('set-status.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    store.setStatus(id, 'merging');
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.status, 'merging');
    db.close();
  });

  it('persists a blocker when status = blocked', () => {
    const db = makeDb('set-status-blocked.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    store.setStatus(id, 'blocked', {
      repoSlug: 'repo-a',
      check: 'integration_gate',
      reason: 'tests failed',
    });
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.status, 'blocked');
    assert.ok(attempt.blocker !== null);
    assert.equal(attempt.blocker!.check, 'integration_gate');
    db.close();
  });

  it('clears a blocker when called again without one', () => {
    const db = makeDb('set-status-clear-blocker.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    store.setStatus(id, 'blocked', { repoSlug: 'repo-a', check: 'pr_open', reason: 'no PR' });
    store.setStatus(id, 'staging');
    const { attempt } = store.getAttempt(id);
    assert.equal(attempt.blocker, null, 'blocker cleared when omitted');
    db.close();
  });
});

// ─── markRevertPending / markReverted tests ───────────────────────────────────

describe('LandingStore.markRevertPending / markReverted', () => {
  it('markRevertPending flips state to revert_pending and stores revert_pr_url', () => {
    const db = makeDb('revert-pending.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha1',
    });
    store.markRevertPending(id, 'repo-a', 'https://github.com/org/repo/pull/99');
    const { merges } = store.getAttempt(id);
    const m = merges.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(m.mergeState, 'revert_pending');
    assert.equal(m.revertPrUrl, 'https://github.com/org/repo/pull/99');
    db.close();
  });

  it('markReverted flips state to reverted and stores revert_merge_sha', () => {
    const db = makeDb('reverted.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    store.recordMerge(id, {
      repoSlug: 'repo-a',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
      mergeCommitSha: 'sha1',
    });
    store.markReverted(id, 'repo-a', 'revert-sha-999');
    const { merges } = store.getAttempt(id);
    const m = merges.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(m.mergeState, 'reverted');
    assert.equal(m.revertMergeSha, 'revert-sha-999');
    assert.ok(m.revertedAt !== null, 'reverted_at is populated');
    db.close();
  });
});

// ─── markRevertPending / markReverted error paths ─────────────────────────────

describe('LandingStore.markRevertPending — error path', () => {
  it('throws when (attempt_id, repo_slug) row does not exist', () => {
    const db = makeDb('revert-pending-missing.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    assert.throws(
      () => store.markRevertPending(id, 'nonexistent-repo', 'https://github.com/org/repo/pull/99'),
      /no row found.*nonexistent-repo/,
      'must throw when no matching repo_merges row exists',
    );
    db.close();
  });
});

describe('LandingStore.markReverted — error path', () => {
  it('throws when (attempt_id, repo_slug) row does not exist', () => {
    const db = makeDb('reverted-missing.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);
    assert.throws(
      () => store.markReverted(id, 'nonexistent-repo', 'sha-xyz'),
      /no row found.*nonexistent-repo/,
      'must throw when no matching repo_merges row exists',
    );
    db.close();
  });
});

// ─── Cycle detection in topoSortReversed ──────────────────────────────────────

describe('LandingStore.pendingReverts — cycle detection', () => {
  it('throws when repo dependency graph contains a cycle', () => {
    const db = makeDb('cycle-detect.db');
    seedEpic(db);
    const store = new LandingStore(db);

    // Manually insert a cyclic dependency: repo-a depends on repo-b, repo-b depends on repo-a.
    // We cannot do this via beginAttempt (which uses RepoStage), so insert raw.
    const id = store.beginAttempt('epic-test', []);
    db.prepare("INSERT INTO repo_merges (attempt_id, repo_slug, depends_on, merge_state) VALUES (?, 'repo-a', ?, 'merged')").run(id, JSON.stringify(['repo-b']));
    db.prepare("INSERT INTO repo_merges (attempt_id, repo_slug, depends_on, merge_state) VALUES (?, 'repo-b', ?, 'merged')").run(id, JSON.stringify(['repo-a']));

    assert.throws(
      () => store.pendingReverts(id),
      /cycle detected/,
      'cyclic dependency must throw rather than silently return a partial list',
    );
    db.close();
  });
});

// ─── makeAnchoringMerger tests (ADR-004) ──────────────────────────────────────

describe('makeAnchoringMerger — ADR-004: active gh pr merge with SHA capture', () => {
  it('calls _ghMerge with the stage prUrl and records the result via store.recordMerge', async () => {
    const db = makeDb('anchoring-merger.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);

    const capturedUrls: string[] = [];

    const merger = makeAnchoringMerger(store, {
      _ghMerge: (prUrl) => {
        capturedUrls.push(prUrl);
        return { number: 77, mergeCommitSha: 'squash-sha-abc' };
      },
    });

    const stage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/tmp',
      storyIds: ['story-001'],
      dependsOnRepos: [],
      status: 'finalizing',
      prUrl: 'https://github.com/org/repo/pull/77',
    };

    const record = await merger(stage, id);

    // Verifies ADR-004: SHA is captured from the merge result, not polled
    assert.equal(record.mergeCommitSha, 'squash-sha-abc');
    assert.equal(record.prNumber, 77);
    assert.equal(record.prUrl, 'https://github.com/org/repo/pull/77');
    assert.equal(record.mergeState, 'merged');

    // Verifies the result was durably persisted in the store
    const { merges } = store.getAttempt(id);
    const m = merges.find(r => r.repoSlug === 'repo-a')!;
    assert.equal(m.mergeCommitSha, 'squash-sha-abc', 'SHA persisted in landing ledger');
    assert.equal(m.mergeState, 'merged', 'merge_state persisted as merged');

    // Verifies _ghMerge was called with the correct prUrl (not a poller)
    assert.deepEqual(capturedUrls, ['https://github.com/org/repo/pull/77']);
    db.close();
  });

  it('throws when stage has no prUrl', async () => {
    const db = makeDb('anchoring-merger-no-url.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);

    const merger = makeAnchoringMerger(store, {
      _ghMerge: () => ({ number: 1, mergeCommitSha: 'sha' }),
    });

    const stage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/tmp',
      storyIds: ['story-001'],
      dependsOnRepos: [],
      status: 'finalizing',
      // no prUrl
    };

    await assert.rejects(
      () => merger(stage, id),
      /has no prUrl/,
      'missing prUrl must reject',
    );
    db.close();
  });

  it('throws when prUrl is not a valid GitHub PR URL (argument-confusion guard)', async () => {
    const db = makeDb('anchoring-merger-bad-url.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);

    const merger = makeAnchoringMerger(store, {
      _ghMerge: () => ({ number: 1, mergeCommitSha: 'sha' }),
    });

    const stage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/tmp',
      storyIds: ['story-001'],
      dependsOnRepos: [],
      status: 'finalizing',
      prUrl: '--some-flag',  // argument confusion injection attempt
    };

    await assert.rejects(
      () => merger(stage, id),
      /not a valid GitHub PR URL/,
      'invalid prUrl must reject before execFileSync is called',
    );
    db.close();
  });

  it('mergedAt in returned record matches the DB persisted value (no JS/SQLite clock mismatch)', async () => {
    const db = makeDb('anchoring-merger-mergedat.db');
    seedEpic(db);
    const store = new LandingStore(db);
    const id = store.beginAttempt('epic-test', [makeStage('repo-a', '/tmp')]);

    const merger = makeAnchoringMerger(store, {
      _ghMerge: () => ({ number: 7, mergeCommitSha: 'sha-clock-test' }),
    });

    const stage: RepoStage = {
      repoSlug: 'repo-a',
      repoRoot: '/tmp',
      storyIds: ['story-001'],
      dependsOnRepos: [],
      status: 'finalizing',
      prUrl: 'https://github.com/org/repo/pull/7',
    };

    const record = await merger(stage, id);

    // The returned record comes from the DB — its mergedAt must equal the persisted value
    const { merges } = store.getAttempt(id);
    const stored = merges.find(m => m.repoSlug === 'repo-a')!;
    assert.equal(record.mergedAt, stored.mergedAt, 'returned mergedAt matches DB-persisted mergedAt');
    assert.ok(record.mergedAt !== null, 'mergedAt is populated');
    db.close();
  });
});
