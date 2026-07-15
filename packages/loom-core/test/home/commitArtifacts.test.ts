/**
 * Unit tests for commitArtifacts (story-050-004).
 *
 * Uses real gitSafe, real EpicStore on temp SQLite files, and real temp dirs —
 * no mocks — so the two-repo cwd separation is actually exercised.
 *
 * Test cases per the test plan:
 *   1. HAPPY — staged relDir committed with cwd=loomHomePath; returns
 *      {status:'committed', sha}; commit message has ALL trailers;
 *      EpicStore has loom_home_status='committed' and loom_home_sha=sha.
 *   2. FAILURE/ROLLBACK — loom-home not a git repo → returns
 *      {status:'pending', reason}; sets loom_home_status='pending'; DOES NOT
 *      throw; DOES NOT touch epic_pr_url (target PR intact).
 *   3. RETRY/IDEMPOTENCY — from pending, second call succeeds.
 *   4. IDEMPOTENCY (already committed) — second call when nothing to stage
 *      returns committed with existing sha, no duplicate commit.
 *   5. ORDERING (ADR-5) — commitArtifacts failure leaves epic_pr_url intact.
 *   6. ISOLATION/GUARD — loom-home commit lands on loom-home's own default
 *      branch; target repo index/branches untouched after the commit.
 *   7. MIGRATION — EpicStore schema gains loom_home_status and loom_home_sha.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitArtifacts } from '../../src/home/commitArtifacts.js';
import type { CommitArtifactsResult } from '../../src/home/commitArtifacts.js';
import { EpicStore } from '../../src/state/EpicStore.js';
import { createDatabase, SCHEMA_VERSION } from '../../src/state/Database.js';
import { gitSafe } from '../../src/orchestrator/git.js';
import type { Provenance } from '../../src/home/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-commit-'));
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

function gitInitialCommit(dir: string): void {
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
  const readme = path.join(dir, 'README.md');
  fs.writeFileSync(readme, '# loom-home\n', 'utf8');
  gitSafe(dir, ['add', 'README.md']);
  gitSafe(dir, ['commit', '-m', 'initial']);
}

/** Writes some files under relDir so there's something to stage. */
function seedRelDir(loomHomePath: string, relDir: string): void {
  const dir = path.join(loomHomePath, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-brief.md'), '# Brief\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'prd.md'), '# PRD\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify({ loom_home_schema: 1 }), 'utf8');
}

function makeProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    loom_home_schema: 1,
    target_repo: {
      name: 'my-app',
      path: '/home/user/repos/my-app',
      remote_url: null,
      slug: 'my-app-a1b2c3d4',
    },
    epic_id: 'epic-001',
    run_id: 'epic-001',
    target_head_sha: 'deadbeef1234567890abcdef',
    created_at: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

function makeStore(dbPath: string, epicId: string): EpicStore {
  const db = createDatabase(dbPath);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  return store;
}

// ── Case 1: HAPPY ─────────────────────────────────────────────────────────────

describe('commitArtifacts — case 1: happy path', () => {
  let tmp: string;
  let loomHomePath: string;
  let relDir: string;
  let store: EpicStore;
  let result: CommitArtifactsResult;
  const epicId = 'epic-001';
  const provenance = makeProvenance();

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    fs.mkdirSync(loomHomePath, { recursive: true });
    gitInit(loomHomePath);
    gitInitialCommit(loomHomePath);

    relDir = `repos/${provenance.target_repo.slug}/${epicId}`;
    seedRelDir(loomHomePath, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);
    result = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns status committed', () => {
    assert.equal(result.status, 'committed');
  });

  it('returns a non-empty sha', () => {
    assert.ok(result.status === 'committed' && result.sha.length > 0);
  });

  it('EpicStore has loom_home_status=committed', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(status, 'committed');
  });

  it('EpicStore has loom_home_sha matching returned sha', () => {
    assert.ok(result.status === 'committed');
    const { sha } = store.getLoomHomeStatus(epicId);
    assert.equal(sha, result.sha);
  });

  it('commit message contains Target-Repo trailer', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%B', '-1']);
    assert.ok(logRes.ok, `git log failed: ${logRes.output}`);
    assert.ok(logRes.output.includes('Target-Repo: my-app'), `missing Target-Repo trailer: ${logRes.output}`);
  });

  it('commit message contains Target-Path trailer', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%B', '-1']);
    assert.ok(logRes.output.includes('Target-Path: /home/user/repos/my-app'), `missing Target-Path: ${logRes.output}`);
  });

  it('commit message contains Target-Head trailer', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%B', '-1']);
    assert.ok(logRes.output.includes('Target-Head: deadbeef'), `missing Target-Head: ${logRes.output}`);
  });

  it('commit message contains Epic trailer', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%B', '-1']);
    assert.ok(logRes.output.includes('Epic: epic-001'), `missing Epic: ${logRes.output}`);
  });

  it('commit message contains Run-Id trailer', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%B', '-1']);
    assert.ok(logRes.output.includes('Run-Id: epic-001'), `missing Run-Id: ${logRes.output}`);
  });

  it('commit message subject names the slug and epic-id', () => {
    const logRes = gitSafe(loomHomePath, ['log', '--format=%s', '-1']);
    assert.ok(
      logRes.output.includes('my-app-a1b2c3d4/epic-001'),
      `subject missing slug/epic-id: ${logRes.output}`,
    );
  });

  it('committed files appear under relDir on loom-home HEAD', () => {
    const lsRes = gitSafe(loomHomePath, ['ls-tree', '--name-only', '-r', 'HEAD']);
    assert.ok(lsRes.output.includes(`${relDir}/project-brief.md`), `project-brief.md not committed: ${lsRes.output}`);
  });

  it('cwd for the commit is loomHomePath (not the target repo)', () => {
    // Verify: the sha is in loom-home's history, not the target repo's.
    assert.ok(result.status === 'committed');
    const revRes = gitSafe(loomHomePath, ['rev-parse', 'HEAD']);
    assert.equal(revRes.output.trim(), result.sha);
  });
});

// ── Case 2: FAILURE / ROLLBACK (FR-10) ───────────────────────────────────────

describe('commitArtifacts — case 2: failure → pending, no throw, target PR intact', () => {
  let tmp: string;
  let notARepo: string;
  let relDir: string;
  let store: EpicStore;
  let result: CommitArtifactsResult;
  const epicId = 'epic-002';
  const provenance = makeProvenance({ epic_id: epicId, run_id: epicId });

  before(() => {
    tmp = makeTmp();
    // notARepo is a plain directory with no git repo — commits will fail.
    notARepo = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(notARepo, { recursive: true });

    relDir = `repos/some-repo-abc12345/${epicId}`;
    seedRelDir(notARepo, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);
    // Pre-record a fake target PR URL to verify it survives the failure.
    store.recordPrUrl(epicId, 'https://github.com/example/repo/pull/42');

    // Should not throw:
    result = commitArtifacts({ loomHomePath: notARepo, relDir, epicId, provenance, store });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns status pending', () => {
    assert.equal(result.status, 'pending');
  });

  it('returns a non-empty reason', () => {
    assert.ok(result.status === 'pending' && result.reason.length > 0);
  });

  it('EpicStore has loom_home_status=pending', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(status, 'pending');
  });

  it('EpicStore loom_home_sha is null on failure', () => {
    const { sha } = store.getLoomHomeStatus(epicId);
    assert.equal(sha, null);
  });

  it('does not throw (no exception escapes commitArtifacts)', () => {
    // The fact that we reached this test body means no exception escaped.
    assert.ok(true);
  });

  it('does not roll back the target PR URL (ADR-5)', () => {
    const epic = store.get(epicId);
    assert.equal(epic?.epic_pr_url, 'https://github.com/example/repo/pull/42');
  });
});

// ── Case 3: RETRY — from pending, second call commits ────────────────────────

describe('commitArtifacts — case 3: retry from pending reconciles to committed', () => {
  let tmp: string;
  let loomHomePath: string;
  let relDir: string;
  let store: EpicStore;
  let firstResult: CommitArtifactsResult;
  let retryResult: CommitArtifactsResult;
  const epicId = 'epic-003';
  const provenance = makeProvenance({ epic_id: epicId, run_id: epicId });

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    fs.mkdirSync(loomHomePath, { recursive: true });
    // Do NOT git init yet — first call will fail.

    relDir = `repos/some-repo-abc12345/${epicId}`;
    seedRelDir(loomHomePath, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);

    // First attempt: fails because loom-home is not a git repo.
    firstResult = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });

    // Fix: initialise loom-home as a git repo.
    gitInit(loomHomePath);
    gitInitialCommit(loomHomePath);

    // Retry: should now succeed.
    retryResult = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('first attempt returns pending', () => {
    assert.equal(firstResult.status, 'pending');
  });

  it('retry returns committed', () => {
    assert.equal(retryResult.status, 'committed');
  });

  it('EpicStore is updated to committed after retry', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(status, 'committed');
  });

  it('only one commit in loom-home git log (no duplicates)', () => {
    const logRes = gitSafe(loomHomePath, ['rev-list', '--count', 'HEAD']);
    // initial commit + the artifact commit = 2 total
    assert.equal(parseInt(logRes.output.trim(), 10), 2);
  });
});

// ── Case 4: IDEMPOTENCY — already committed ───────────────────────────────────

describe('commitArtifacts — case 4: idempotency when artifacts already committed', () => {
  let tmp: string;
  let loomHomePath: string;
  let relDir: string;
  let store: EpicStore;
  let firstResult: CommitArtifactsResult;
  let secondResult: CommitArtifactsResult;
  const epicId = 'epic-004';
  const provenance = makeProvenance({ epic_id: epicId, run_id: epicId });

  before(() => {
    tmp = makeTmp();
    loomHomePath = path.join(tmp, 'loom-home');
    fs.mkdirSync(loomHomePath, { recursive: true });
    gitInit(loomHomePath);
    gitInitialCommit(loomHomePath);

    relDir = `repos/some-repo-abc12345/${epicId}`;
    seedRelDir(loomHomePath, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);

    // First call: succeeds and commits the files.
    firstResult = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });
    // Second call: files already committed → nothing to stage → should still
    // return committed (not pending) using the existing HEAD sha.
    secondResult = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('first call returns committed', () => {
    assert.equal(firstResult.status, 'committed');
  });

  it('second call returns committed (idempotent)', () => {
    assert.equal(secondResult.status, 'committed');
  });

  it('second call sha equals first call sha (no new commit)', () => {
    assert.ok(firstResult.status === 'committed');
    assert.ok(secondResult.status === 'committed');
    assert.equal(secondResult.sha, firstResult.sha);
  });

  it('only two commits in loom-home (initial + one artifact commit)', () => {
    const logRes = gitSafe(loomHomePath, ['rev-list', '--count', 'HEAD']);
    assert.equal(parseInt(logRes.output.trim(), 10), 2);
  });
});

// ── Case 5: ORDERING (ADR-5) — target PR intact on loom-home failure ─────────

describe('commitArtifacts — case 5: ADR-5 ordering — loom-home failure leaves target PR intact', () => {
  let tmp: string;
  let store: EpicStore;
  let result: CommitArtifactsResult;
  const epicId = 'epic-005';
  const provenance = makeProvenance({ epic_id: epicId, run_id: epicId });
  const TARGET_PR_URL = 'https://github.com/example/repo/pull/99';

  before(() => {
    tmp = makeTmp();
    // Use a non-git directory as loom-home to force a failure.
    const notARepo = path.join(tmp, 'not-a-repo');
    fs.mkdirSync(notARepo, { recursive: true });
    const relDir = `repos/some-repo-abc12345/${epicId}`;
    seedRelDir(notARepo, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);
    // Simulate: target PR was already opened and recorded (pre-commitArtifacts).
    store.recordPrUrl(epicId, TARGET_PR_URL);

    result = commitArtifacts({
      loomHomePath: notARepo,
      relDir,
      epicId,
      provenance,
      store,
    });
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loom-home failure returns pending', () => {
    assert.equal(result.status, 'pending');
  });

  it('epic_pr_url is unchanged after loom-home failure', () => {
    const epic = store.get(epicId);
    assert.equal(epic?.epic_pr_url, TARGET_PR_URL);
  });

  it('loom_home_status=pending but finalize is otherwise unaffected', () => {
    const { status } = store.getLoomHomeStatus(epicId);
    assert.equal(status, 'pending');
  });
});

// ── Case 6: ISOLATION / GUARD (NFR-1) ────────────────────────────────────────

describe('commitArtifacts — case 6: isolation — loom-home commit on its own branch, target repo untouched', () => {
  let tmp: string;
  let loomHomePath: string;
  let targetRepo: string;
  let store: EpicStore;
  let result: CommitArtifactsResult;
  let targetHeadBeforeCommit: string;
  let targetHeadAfterCommit: string;
  const epicId = 'epic-006';
  const provenance = makeProvenance({ epic_id: epicId, run_id: epicId });

  before(() => {
    tmp = makeTmp();

    // Set up a real target repo.
    targetRepo = path.join(tmp, 'target');
    fs.mkdirSync(targetRepo, { recursive: true });
    gitInit(targetRepo);
    gitSafe(targetRepo, ['config', 'user.email', 'test@loom.test']);
    gitSafe(targetRepo, ['config', 'user.name', 'Loom Test']);
    fs.writeFileSync(path.join(targetRepo, 'app.ts'), '// app\n', 'utf8');
    gitSafe(targetRepo, ['add', 'app.ts']);
    gitSafe(targetRepo, ['commit', '-m', 'init target']);
    const headRes = gitSafe(targetRepo, ['rev-parse', 'HEAD']);
    targetHeadBeforeCommit = headRes.output.trim();

    // Set up loom-home (separate repo).
    loomHomePath = path.join(tmp, 'loom-home');
    fs.mkdirSync(loomHomePath, { recursive: true });
    gitInit(loomHomePath);
    gitInitialCommit(loomHomePath);

    const relDir = `repos/my-app-a1b2c3d4/${epicId}`;
    seedRelDir(loomHomePath, relDir);

    store = makeStore(path.join(tmp, 'loom.db'), epicId);
    result = commitArtifacts({ loomHomePath, relDir, epicId, provenance, store });

    const afterRes = gitSafe(targetRepo, ['rev-parse', 'HEAD']);
    targetHeadAfterCommit = afterRes.output.trim();
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('loom-home commit succeeds', () => {
    assert.equal(result.status, 'committed');
  });

  it('target repo HEAD is unchanged after loom-home commit', () => {
    assert.equal(targetHeadAfterCommit, targetHeadBeforeCommit);
  });

  it('no .loom_outputs directory created in target repo', () => {
    assert.ok(!fs.existsSync(path.join(targetRepo, '.loom_outputs')));
  });

  it('loom-home commit is not visible in target repo log', () => {
    assert.ok(result.status === 'committed');
    const logRes = gitSafe(targetRepo, ['log', '--oneline']);
    assert.ok(!logRes.output.includes(result.sha.slice(0, 7)), `target repo log should not contain loom-home sha: ${logRes.output}`);
  });

  it('loom-home commit sha appears in loom-home log (not on a target protected branch)', () => {
    assert.ok(result.status === 'committed');
    const logRes = gitSafe(loomHomePath, ['log', '--oneline', '-1']);
    assert.ok(logRes.output.includes(result.sha.slice(0, 7)), `loom-home log must contain sha: ${logRes.output}`);
  });
});

// ── Case 7: MIGRATION — EpicStore schema gains loom_home_status and loom_home_sha ──

describe('commitArtifacts — case 7: migration — new columns present and default to null', () => {
  let tmp: string;

  before(() => {
    tmp = makeTmp();
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('SCHEMA_VERSION is at least 30 (loom-home migration present)', () => {
    assert.ok(SCHEMA_VERSION >= 30, 'SCHEMA_VERSION must be at least 30');
  });

  it('createDatabase adds loom_home_status column', () => {
    const db = createDatabase(path.join(tmp, 'test1.db'));
    const cols = (db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]).map(c => c.name);
    assert.ok(cols.includes('loom_home_status'), `loom_home_status missing from columns: ${cols.join(', ')}`);
  });

  it('createDatabase adds loom_home_sha column', () => {
    const db = createDatabase(path.join(tmp, 'test2.db'));
    const cols = (db.prepare('PRAGMA table_info(epics)').all() as { name: string }[]).map(c => c.name);
    assert.ok(cols.includes('loom_home_sha'), `loom_home_sha missing from columns: ${cols.join(', ')}`);
  });

  it('existing rows get NULL loom_home_status by default', () => {
    const db = createDatabase(path.join(tmp, 'test3.db'));
    const store = new EpicStore(db);
    store.create('epic-xyz', 'Existing epic');
    const { status } = store.getLoomHomeStatus('epic-xyz');
    assert.equal(status, null);
  });

  it('existing rows get NULL loom_home_sha by default', () => {
    const db = createDatabase(path.join(tmp, 'test4.db'));
    const store = new EpicStore(db);
    store.create('epic-xyz', 'Existing epic');
    const { sha } = store.getLoomHomeStatus('epic-xyz');
    assert.equal(sha, null);
  });

  it('setLoomHomeStatus committed writes both status and sha', () => {
    const db = createDatabase(path.join(tmp, 'test5.db'));
    const store = new EpicStore(db);
    store.create('epic-xyz', 'Test epic');
    store.setLoomHomeStatus('epic-xyz', 'committed', 'abc1234def5678');
    const { status, sha } = store.getLoomHomeStatus('epic-xyz');
    assert.equal(status, 'committed');
    assert.equal(sha, 'abc1234def5678');
  });

  it('setLoomHomeStatus pending clears sha', () => {
    const db = createDatabase(path.join(tmp, 'test6.db'));
    const store = new EpicStore(db);
    store.create('epic-xyz', 'Test epic');
    // First: set committed with a sha.
    store.setLoomHomeStatus('epic-xyz', 'committed', 'abc1234def5678');
    // Then: overwrite with pending (no sha).
    store.setLoomHomeStatus('epic-xyz', 'pending');
    const { status, sha } = store.getLoomHomeStatus('epic-xyz');
    assert.equal(status, 'pending');
    assert.equal(sha, null);
  });
});
