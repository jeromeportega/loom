/**
 * story-075-002 — loom sync CLI integration tests.
 *
 * Uses a real git repository (tmpDir) with a real integration worktree so
 * the IntegrationBranch git operations are exercised end-to-end. The database
 * is seeded via the openDatabase singleton trick (resetDatabaseForTest +
 * openDatabase on first call) — the same pattern used by finalize.test.ts and
 * reconcile.test.ts.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest, EpicStore, IntegrationBranch } from '@loom-ai/core';
import { runSync } from '../commands/sync.js';
import { capture } from './testUtils.js';
import { buildProgram } from '../index.js';

// ─── Shared setup ────────────────────────────────────────────────────────────

let tmpDir: string;
let loomDir: string;
let remote: string;
let base: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const MINIMAL_POLICY =
  'git:\n  allowed_remotes: []\nagents:\n  min_brief_quality_score: 6\n  max_concurrent: 5\n  review_strategy: "comment"\n  skill_generation: "on"\n';

function gitc(args: string[], cwd = tmpDir): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** True when MERGE_HEAD exists in `cwd` (a merge is in progress). */
function mergeInProgress(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Seed an epic record using the DB singleton set by the test setUp. */
function seedEpic(epicId: string): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'in_progress');
}

beforeEach(() => {
  resetDatabaseForTest();

  // LOOM_HOME isolation — prepareRepoState writes here.
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sync-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  // Create a real git repo in tmpDir.
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sync-cli-')));
  loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });

  execFileSync('git', ['init', '-q'], { cwd: tmpDir, encoding: 'utf8' });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: tmpDir });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: tmpDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
  base = gitc(['rev-parse', 'HEAD']);

  // Create a bare remote and seed it with the initial commit.
  remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sync-remote-')));
  execFileSync('git', ['init', '--bare', '-q'], { cwd: remote, encoding: 'utf8' });
  gitc(['remote', 'add', 'origin', remote]);
  gitc(['push', '-q', 'origin', `${base}:refs/heads/main`]);

  // Write a minimal policy so runSync doesn't bail out early.
  fs.writeFileSync(path.join(loomDir, 'policy.yaml'), MINIMAL_POLICY);
});

afterEach(() => {
  resetDatabaseForTest();
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('loom sync CLI — unknown epic', () => {
  it('exits non-zero with an "epic not found" error when the epic does not exist', async () => {
    const ib = new IntegrationBranch(tmpDir);
    ib.ensure('epic-001', base);
    // No epic in the database.
    const { exitCode, errors } = await capture(() =>
      runSync('epic-missing', { projectRoot: tmpDir })
    );
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => e.includes('epic-missing') && e.includes('not found')),
      `expected "epic-missing" not found in errors: ${JSON.stringify(errors)}`
    );
  });
});

describe('loom sync CLI — already current', () => {
  it('exits 0 when the integration branch is already a descendant of main', async () => {
    seedEpic('epic-001');
    const ib = new IntegrationBranch(tmpDir);
    ib.ensure('epic-001', base);

    const { exitCode, logs } = await capture(() =>
      runSync('epic-001', { projectRoot: tmpDir })
    );
    assert.equal(exitCode, null, 'should exit without calling process.exit (i.e. exit 0)');
    assert.ok(
      logs.some((l) => l.includes('already up to date')),
      `expected "already up to date" in logs: ${JSON.stringify(logs)}`
    );
  });
});

describe('loom sync CLI — branch behind main', () => {
  it('exits 0 and integration branch HEAD is a descendant of main HEAD after the call', async () => {
    seedEpic('epic-001');
    const ib = new IntegrationBranch(tmpDir);
    ib.ensure('epic-001', base);

    // Push 2 new commits to origin/main.
    fs.writeFileSync(path.join(tmpDir, 'feature1.txt'), 'f1\n');
    gitc(['add', 'feature1.txt']);
    gitc(['commit', '-q', '-m', 'main: feature 1']);
    fs.writeFileSync(path.join(tmpDir, 'feature2.txt'), 'f2\n');
    gitc(['add', 'feature2.txt']);
    gitc(['commit', '-q', '-m', 'main: feature 2']);
    gitc(['push', '-q', 'origin', 'HEAD:refs/heads/main']);

    const { exitCode, logs } = await capture(() =>
      runSync('epic-001', { projectRoot: tmpDir })
    );
    assert.equal(exitCode, null, 'should exit 0');
    assert.ok(
      logs.some((l) => l.includes('merged 2 commit')),
      `expected "merged 2 commit" in logs: ${JSON.stringify(logs)}`
    );

    // Verify via git that the integration branch is now a descendant of main HEAD.
    const mainHead = gitc(['rev-parse', 'refs/remotes/origin/main'], ib.path('epic-001'));
    const isAncestor = execFileSync(
      'git',
      ['merge-base', '--is-ancestor', mainHead, 'HEAD'],
      { cwd: ib.path('epic-001'), stdio: 'ignore' }
    );
    // execFileSync exits 0 → is-ancestor check passed → no assertion needed (throws on failure)
    assert.ok(true, 'integration branch HEAD is a descendant of main HEAD');
  });
});

describe('loom sync CLI — merge conflict', () => {
  it('exits non-zero, prints diagnostic on stderr, and leaves the integration branch clean', async () => {
    seedEpic('epic-001');
    const ib = new IntegrationBranch(tmpDir);
    const info = ib.ensure('epic-001', base);

    // Commit a conflicting change in the integration worktree.
    fs.writeFileSync(path.join(info.path, 'shared.txt'), 'from integration\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: info.path, encoding: 'utf8' });
    execFileSync('git', ['commit', '-q', '-m', 'integration: shared'], {
      cwd: info.path,
      encoding: 'utf8',
    });

    // Commit the same file with different content on main and push it.
    fs.writeFileSync(path.join(tmpDir, 'shared.txt'), 'from main\n');
    gitc(['add', 'shared.txt']);
    gitc(['commit', '-q', '-m', 'main: shared']);
    gitc(['push', '-q', 'origin', 'HEAD:refs/heads/main']);

    const { exitCode, errors } = await capture(() =>
      runSync('epic-001', { projectRoot: tmpDir })
    );
    assert.equal(exitCode, 1);
    assert.ok(
      errors.some((e) => e.includes('sync failed') || e.includes('merge') || e.includes('conflict')),
      `expected conflict/sync-failed in errors: ${JSON.stringify(errors)}`
    );
    // Branch must be clean — no MERGE_HEAD, no unmerged paths.
    assert.ok(!mergeInProgress(info.path), 'no MERGE_HEAD — merge was aborted');
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: info.path,
      encoding: 'utf8',
    }).trim();
    assert.equal(status, '', 'integration worktree is clean after aborted merge');
  });
});

describe('loom sync CLI — help registration', () => {
  it('lists "sync" in loom --help output', () => {
    const program = buildProgram();
    const helpText = program.helpInformation();
    assert.ok(
      helpText.includes('sync'),
      `expected "sync" in help output: ${helpText.slice(0, 500)}`
    );
  });
});
