import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeManager } from '../orchestrator/WorktreeManager.js';
import { WorkerLogStore } from '../state/WorkerLogStore.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(name: string, content: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', `add ${name}`]);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wt-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  commitFile('README.md', '# test repo\n');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('WorktreeManager', () => {
  it('creates a worktree on a story branch', () => {
    const wm = new WorktreeManager(repo);
    const info = wm.create('story-001-001');

    assert.ok(fs.existsSync(info.path));
    assert.equal(info.branch, 'story/story-001-001');
    assert.ok(info.baseSha.length > 0);

    const branches = gitc(['branch', '--list', 'story/story-001-001']);
    assert.ok(branches.includes('story/story-001-001'));
  });

  it('is idempotent — a second create returns the same worktree', () => {
    const wm = new WorktreeManager(repo);
    const a = wm.create('story-001-001');
    const b = wm.create('story-001-001');
    assert.equal(a.path, b.path);
    assert.equal(a.branch, b.branch);
  });

  it('lists only loom-managed worktrees', () => {
    const wm = new WorktreeManager(repo);
    wm.create('story-001-001');
    wm.create('story-001-002');
    const list = wm.list();
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((w) => w.storyId).sort(),
      ['story-001-001', 'story-001-002']
    );
  });

  it('removes a worktree', () => {
    const wm = new WorktreeManager(repo);
    const info = wm.create('story-001-001');
    assert.ok(fs.existsSync(info.path));
    wm.remove('story-001-001');
    assert.ok(!fs.existsSync(info.path));
    assert.equal(wm.list().length, 0);
  });

  it('removes the branch when deleteBranch is set', () => {
    const wm = new WorktreeManager(repo);
    wm.create('story-001-001');
    wm.remove('story-001-001', { deleteBranch: true });
    assert.equal(gitc(['branch', '--list', 'story/story-001-001']), '');
  });

  it('branches a dependent worktree from its dependency branch', () => {
    const wm = new WorktreeManager(repo);
    // Story A's worktree, then a commit on its branch.
    const a = wm.create('story-001-001');
    fs.writeFileSync(path.join(a.path, 'a.txt'), 'from A');
    gitc(['add', '.'], a.path);
    gitc(['commit', '-q', '-m', 'A work'], a.path);

    // Story B branches from A — it must see A's file.
    const b = wm.create('story-001-002', { fromBranch: 'story/story-001-001' });
    assert.ok(fs.existsSync(path.join(b.path, 'a.txt')));
    // B's base is A's tip, not the original HEAD.
    assert.equal(b.baseSha, gitc(['rev-parse', 'story/story-001-001']));
  });

  it('falls back to HEAD when fromBranch does not resolve', () => {
    const wm = new WorktreeManager(repo);
    const info = wm.create('story-001-001', { fromBranch: 'story/does-not-exist' });
    assert.equal(info.baseSha, gitc(['rev-parse', 'HEAD']));
  });

  it('throws a clear error in a repo with no commits', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-empty-'));
    execFileSync('git', ['init', '-q'], { cwd: empty });
    try {
      const wm = new WorktreeManager(empty);
      assert.throws(() => wm.create('story-001-001'), /no commits/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('WorktreeManager — workerLogs pruning lifecycle', () => {
  it('removes the log file when workerLogs is injected', () => {
    const loomdir = path.join(repo, '.loom');
    fs.mkdirSync(loomdir, { recursive: true });
    const logs = new WorkerLogStore(loomdir);
    const wm = new WorktreeManager(repo, logs);

    logs.append('story-019-001', 'some output\n');
    const logPath = logs.pathFor('story-019-001');
    assert.ok(fs.existsSync(logPath), 'log file created before remove');

    wm.create('story-019-001');
    wm.remove('story-019-001');

    assert.ok(!fs.existsSync(logPath), 'log file removed after worktree removal');
  });

  it('does not throw when no workerLogs injected (null-safe)', () => {
    const wm = new WorktreeManager(repo);
    wm.create('story-019-001');
    assert.doesNotThrow(() => wm.remove('story-019-001'));
  });

  it('is idempotent when log file already absent', () => {
    const loomdir = path.join(repo, '.loom');
    fs.mkdirSync(loomdir, { recursive: true });
    const logs = new WorkerLogStore(loomdir);
    const wm = new WorktreeManager(repo, logs);
    wm.create('story-019-001');
    wm.remove('story-019-001'); // no log file written — remove is a no-op on ENOENT
    assert.doesNotThrow(() => wm.remove('story-019-001')); // second call also safe
  });

  it('removes the log file even when the worktree directory is already gone', () => {
    const loomdir = path.join(repo, '.loom');
    fs.mkdirSync(loomdir, { recursive: true });
    const logs = new WorkerLogStore(loomdir);
    const wm = new WorktreeManager(repo, logs);

    logs.append('story-019-001', 'output after crash\n');
    const logPath = logs.pathFor('story-019-001');
    assert.ok(fs.existsSync(logPath), 'log file present');

    // Call remove without ever creating the worktree — simulates a crash-cleaned tree.
    wm.remove('story-019-001');
    assert.ok(!fs.existsSync(logPath), 'log file removed even without worktree on disk');
  });
});
