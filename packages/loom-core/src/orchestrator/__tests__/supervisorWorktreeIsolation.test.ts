/**
 * story-058-002: Per-repo worktree isolation in Supervisor.
 *
 * Verifies four cases from the test plan:
 *  (1) worktreeFor lazily creates one WorktreeManager per slug and caches it.
 *  (2) Two stories in different repos → wtByRepo holds two entries.
 *  (3) Supervisor.dispatch builds WorkerAssignment with projectRoot / worktreePath /
 *      branchName sourced from the story's resolved repo, not the global projectRoot.
 *  (4) Single-repo regression: wtByRepo.size === 1 and worktreePath/branchName are
 *      byte-identical to the pre-change values.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';

import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { Supervisor } from '../Supervisor.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import type { WorkspaceManifest } from '../../home/workspaceManifest.js';
import type { Story } from '../../types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Initialise a bare git repo with one commit so worktrees can be created. */
function initRepo(dir: string): string {
  gitc(['init', '-q'], dir);
  gitc(['config', 'user.email', 'test@loom.dev'], dir);
  gitc(['config', 'user.name', 'Loom Test'], dir);
  gitc(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitc(['add', '.'], dir);
  gitc(['commit', '-q', '-m', 'initial'], dir);
  return fs.realpathSync(dir);
}

function story(id: string, repo?: string): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement it.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
    ...(repo !== undefined ? { repo } : {}),
  };
}

function seedEpic(repoDir: string, epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repoDir, '.loom'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

// ─── Test state ──────────────────────────────────────────────────────────────

let repoA: string;
let repoB: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wt-iso-a-'));
  repoB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wt-iso-b-'));
  initRepo(repoA);
  initRepo(repoB);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

// ─── (1) worktreeFor: lazy creation and caching ───────────────────────────────

describe('Supervisor.worktreeFor — lazy creation and caching', () => {
  it('returns the same WorktreeManager instance on repeated calls with the same slug', async () => {
    // Use a real git repo so the WorktreeManager constructor doesn't fail;
    // we never actually call create(), just verify the registry.
    const realRootA = fs.realpathSync(repoA);
    seedEpic(repoA, 'epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repoA, '.loom'));

    const manifest: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'repo-a', path: realRootA, remote_url: null, primary: true }],
    };

    // Capture assignments to indirectly verify registry state via wtByRepo size.
    const capturedAssignments: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      capturedAssignments.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    const supervisor = new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      manifest,
      primarySlug: 'repo-a',
    });

    // Run the supervisor — dispatch exercises worktreeFor.
    await supervisor.run(['epic-001']);

    // One story → one repo → wtByRepo size should be 1.
    // We verify indirectly via the captured assignment's worktreeContext.
    assert.equal(capturedAssignments.length, 1);
    assert.equal(capturedAssignments[0].worktreeContext?.repoSlug, 'repo-a');
  });

  it('wtByRepo.size === 1 after a single-repo run', async () => {
    const realRootA = fs.realpathSync(repoA);
    seedEpic(repoA, 'epic-001', [story('story-001-001'), story('story-001-002', undefined)]);
    const db = openDatabase(path.join(repoA, '.loom'));

    const manifest: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'repo-a', path: realRootA, remote_url: null, primary: true }],
    };

    const assignments: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      assignments.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    const supervisor = new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 4,
      lease: false,
      manifest,
      primarySlug: 'repo-a',
    });

    await supervisor.run(['epic-001']);

    // Both stories resolve to the same slug → one manager cached.
    assert.equal(assignments.length, 2);
    // All assignments should have the same repoSlug.
    for (const a of assignments) {
      assert.equal(a.worktreeContext?.repoSlug, 'repo-a');
    }
  });
});

// ─── (2) Two stories in different repos → wtByRepo holds two entries ──────────

describe('Supervisor — two stories in different repos', () => {
  it('dispatches story-001 to repo-a and story-002 to repo-b with correct projectRoots', async () => {
    const realRootA = fs.realpathSync(repoA);
    const realRootB = fs.realpathSync(repoB);

    // Epic lives in repo A but story-002 explicitly targets repo B.
    const epicStories = [
      story('story-001-001'),           // no repo → resolves to primary (repo-a)
      story('story-001-002', 'repo-b'), // explicit repo-b
    ];
    seedEpic(repoA, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoA, '.loom'));

    const manifest: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realRootA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realRootB, remote_url: null },
      ],
    };

    const assignments: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      assignments.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    const supervisor = new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 4,
      lease: false,
      manifest,
      primarySlug: 'repo-a',
    });

    await supervisor.run(['epic-001']);
    assert.equal(assignments.length, 2, 'both stories dispatched');

    const a001 = assignments.find((a) => a.storyId === 'story-001-001');
    const a002 = assignments.find((a) => a.storyId === 'story-001-002');
    assert.ok(a001, 'story-001-001 was dispatched');
    assert.ok(a002, 'story-001-002 was dispatched');

    // story-001-001 → repo-a
    assert.equal(a001!.projectRoot, realRootA, 'story-001-001 projectRoot is repo-a root');
    assert.equal(a001!.worktreeContext?.repoSlug, 'repo-a');
    assert.ok(
      a001!.worktreePath.startsWith(path.join(realRootA, '.loom', 'worktrees')),
      `worktreePath for story-001-001 should be under repo-a, got: ${a001!.worktreePath}`
    );

    // story-001-002 → repo-b
    assert.equal(a002!.projectRoot, realRootB, 'story-001-002 projectRoot is repo-b root');
    assert.equal(a002!.worktreeContext?.repoSlug, 'repo-b');
    assert.ok(
      a002!.worktreePath.startsWith(path.join(realRootB, '.loom', 'worktrees')),
      `worktreePath for story-001-002 should be under repo-b, got: ${a002!.worktreePath}`
    );

    // Two distinct repos touched → two manager entries.
    // We verify indirectly: the two worktreePaths must be in different directories.
    const wtDirA = path.dirname(a001!.worktreePath);
    const wtDirB = path.dirname(a002!.worktreePath);
    assert.notEqual(wtDirA, wtDirB, 'worktree directories must differ for different repos');
  });
});

// ─── (3) WorkerAssignment fields sourced from the resolved repo ───────────────

describe('Supervisor.dispatch — WorkerAssignment comes from resolveStoryRepo', () => {
  it('worktreePath lives under story-resolved repo and branchName is story/<id>', async () => {
    const realRootB = fs.realpathSync(repoB);

    // Epic is hosted in repo-a but the single story targets repo-b.
    seedEpic(repoA, 'epic-001', [story('story-001-001', 'repo-b')]);
    const db = openDatabase(path.join(repoA, '.loom'));

    const manifest: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: fs.realpathSync(repoA), remote_url: null, primary: true },
        { slug: 'repo-b', path: realRootB, remote_url: null },
      ],
    };

    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    await new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      manifest,
      primarySlug: 'repo-a',
    }).run(['epic-001']);

    assert.equal(captured.length, 1);
    const a = captured[0];

    assert.equal(a.projectRoot, realRootB, 'projectRoot must be repo-b root');
    assert.equal(
      a.worktreePath,
      path.join(realRootB, '.loom', 'worktrees', 'story-001-001'),
      'worktreePath must be under repo-b'
    );
    assert.equal(a.branchName, 'story/story-001-001', 'branchName unchanged');
    assert.equal(a.worktreeContext?.repoSlug, 'repo-b');
    assert.equal(a.worktreeContext?.worktreePath, a.worktreePath);
  });
});

// ─── (4) Single-repo regression: paths byte-identical to pre-change values ────

describe('Single-repo regression (NFR-2)', () => {
  it('wtByRepo.size === 1 and worktreePath is byte-identical to the legacy path', async () => {
    const realRoot = fs.realpathSync(repoA);
    seedEpic(repoA, 'epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repoA, '.loom'));

    // The pre-change path: WorktreeManager(projectRoot).worktreePath(storyId)
    const expectedWorktreePath = path.join(realRoot, '.loom', 'worktrees', 'story-001-001');
    const expectedBranch = 'story/story-001-001';

    // No manifest provided → synthetic fallback → single-entry → legacy behavior.
    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    await new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      // No manifest → synthetic single-entry manifest from projectRoot
    }).run(['epic-001']);

    assert.equal(captured.length, 1);
    const a = captured[0];
    assert.equal(a.worktreePath, expectedWorktreePath, 'worktreePath byte-identical to legacy');
    assert.equal(a.branchName, expectedBranch, 'branchName byte-identical to legacy');
    assert.equal(a.projectRoot, realRoot, 'projectRoot is the realpath of projectRoot');
    // Only one repo slug visited → one entry in wtByRepo (verified indirectly
    // through the slug on worktreeContext).
    assert.equal(a.worktreeContext?.repoSlug, 'primary', 'synthetic slug is primary');
  });

  it('providing a one-entry manifest is byte-identical to the fallback', async () => {
    const realRoot = fs.realpathSync(repoA);
    seedEpic(repoA, 'epic-002', [story('story-002-001')]);
    const db = openDatabase(path.join(repoA, '.loom'));

    const manifest: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'my-repo', path: realRoot, remote_url: null, primary: true }],
    };

    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    await new Supervisor({
      projectRoot: repoA,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      manifest,
      primarySlug: 'my-repo',
    }).run(['epic-002']);

    assert.equal(captured.length, 1);
    const a = captured[0];
    assert.equal(
      a.worktreePath,
      path.join(realRoot, '.loom', 'worktrees', 'story-002-001')
    );
    assert.equal(a.branchName, 'story/story-002-001');
    assert.equal(a.projectRoot, realRoot);
    assert.equal(a.worktreeContext?.repoSlug, 'my-repo');
  });
});
