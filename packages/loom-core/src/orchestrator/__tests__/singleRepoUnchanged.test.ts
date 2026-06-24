/**
 * story-058-008: Single-repo behavior-unchanged proof (NFR-2, permanent obligation).
 *
 * This is the regression test that proves the cross-repo generalizations
 * introduced by epic-058 leave single-repo epics byte-identical in every
 * observable dimension — worktree paths, branch names, SharedContract
 * injection content, and the one-PR-per-epic model.
 *
 * Three seams are exercised explicitly:
 *   (A) primary-resolution-without-declaration — resolvePrimaryRepo with ONE
 *       registered repo and no `primary: true` flag → resolves to that slug.
 *   (B) wtByRepo-of-one — Supervisor with a single-repo epic populates
 *       wtByRepo with exactly one slug; paths and branches are byte-identical
 *       to the pre-generalisation values.
 *   (C) single-RepoStage — buildRepoStages / CrossRepoCoordinator.run() with
 *       a single-repo epic returns exactly one stage with empty dependsOnRepos
 *       and never calls waitForMerge.
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
import {
  buildRepoStages,
  topoSortRepos,
  CrossRepoCoordinator,
  type RepoStage,
  type SupervisorLike,
  type FinalizerHandle,
} from '../CrossRepoCoordinator.js';
import { SharedContract } from '../SharedContract.js';
import { resolvePrimaryRepo } from '../../home/primaryRepo.js';
import { resolveStoryRepo } from '../resolveStoryRepo.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';
import type { Story } from '../../types.js';
import type { SupervisorResult } from '../Supervisor.js';
import type { FinalizeResult } from '../EpicFinalizer.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

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

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function okSupervisorResult(): SupervisorResult {
  return {
    epicsProcessed: [],
    epicsSkipped: [],
    storiesTotal: 0,
    storiesDone: 0,
    storiesFailed: 0,
    storiesBlocked: 0,
    storiesPending: 0,
    halted: false,
  };
}

function okFinalizeResult(url?: string): FinalizeResult {
  return {
    url,
    status: 'merged',
    conflicted: [],
    merged: [],
    cleaned: [],
    note: 'ok',
  };
}

// ─── Test state ───────────────────────────────────────────────────────────────

let repoDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nfr2-'));
  initRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

// ─── (A) primary-resolution-without-declaration ───────────────────────────────
//
// resolvePrimaryRepo takes the single-entry, no-primary-flag path (resolution
// rule 2: "exactly one repo → that slug"). This is the path exercised when a
// workspace has one repo registered and no `primary: true` annotation.

describe('resolvePrimaryRepo — single-entry, no primary flag (path: primary-resolution-without-declaration)', () => {
  it('resolves to the single slug when no entry is flagged primary', () => {
    const m = manifest([entry('my-repo')]);   // primary field absent
    assert.equal(resolvePrimaryRepo(m), 'my-repo');
  });

  it('produces the same slug whether the flag is set or absent (single-entry idempotency)', () => {
    const withFlag    = manifest([entry('my-repo', { primary: true })]);
    const withoutFlag = manifest([entry('my-repo')]);
    assert.equal(resolvePrimaryRepo(withFlag), resolvePrimaryRepo(withoutFlag));
  });

  it('resolveStoryRepo with no story.repo follows the no-declaration path to the primary slug', () => {
    const m = manifest([entry('my-repo')]);
    const primarySlug = resolvePrimaryRepo(m);  // 'my-repo'
    const s = story('story-001-001');           // no repo field
    const { slug, root } = resolveStoryRepo(s, m, primarySlug);
    assert.equal(slug, 'my-repo', 'slug must equal the primary slug resolved without a declaration');
    assert.equal(root, '/repos/my-repo');
  });
});

// ─── (B) wtByRepo-of-one — Supervisor byte-identical paths ───────────────────
//
// A single-repo epic dispatched through the generalized Supervisor produces
// worktree paths and branch names byte-identical to the pre-generalization
// values. This covers the wtByRepo-of-one code path.

describe('Supervisor single-repo (NFR-2) — byte-identical paths', () => {
  it('worktreePath is byte-identical to the pre-change canonical path', async () => {
    const realRoot = fs.realpathSync(repoDir);
    seedEpic(repoDir, 'epic-099', [story('story-099-001')]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Expected path: same as WorktreeManager(projectRoot).create(storyId).path
    const expectedWorktreePath = path.join(realRoot, '.loom', 'worktrees', 'story-099-001');
    const expectedBranch = 'story/story-099-001';

    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    // No manifest → synthetic single-entry fallback → same legacy path.
    await new Supervisor({ projectRoot: repoDir, db, worker, maxConcurrent: 1, lease: false })
      .run(['epic-099']);

    assert.equal(captured.length, 1, 'exactly one story dispatched');
    const a = captured[0];
    assert.equal(a.worktreePath, expectedWorktreePath, 'worktreePath must be byte-identical to legacy');
    assert.equal(a.branchName, expectedBranch, 'branchName must be byte-identical to legacy');
    assert.equal(a.projectRoot, realRoot, 'projectRoot must be the realpath of repoDir');
  });

  it('providing a one-entry manifest is byte-identical to the no-manifest fallback', async () => {
    const realRoot = fs.realpathSync(repoDir);
    seedEpic(repoDir, 'epic-099', [story('story-099-001')]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Explicit single-entry manifest with no primary flag — same no-declaration path.
    const m: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'my-repo', path: realRoot, remote_url: null }],
    };

    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    await new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      manifest: m,
      primarySlug: 'my-repo',
    }).run(['epic-099']);

    assert.equal(captured.length, 1);
    const a = captured[0];
    assert.equal(a.worktreePath, path.join(realRoot, '.loom', 'worktrees', 'story-099-001'));
    assert.equal(a.branchName, 'story/story-099-001');
    assert.equal(a.projectRoot, realRoot);
    assert.equal(a.worktreeContext?.repoSlug, 'my-repo');
  });

  it('wtByRepo-of-one: all dispatched assignments carry the same repoSlug', async () => {
    const realRoot = fs.realpathSync(repoDir);
    seedEpic(repoDir, 'epic-099', [story('story-099-001'), story('story-099-002')]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const m: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'my-repo', path: realRoot, remote_url: null, primary: true }],
    };

    const captured: import('../WorkerRunner.js').WorkerAssignment[] = [];
    const worker = new MockWorkerRunner((a) => {
      captured.push(a);
      return Promise.resolve({ status: 'done' as const, commitCount: 0, summary: 'ok', logTail: '' });
    });

    await new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 2,
      lease: false,
      manifest: m,
      primarySlug: 'my-repo',
    }).run(['epic-099']);

    assert.equal(captured.length, 2, 'both stories dispatched');
    for (const a of captured) {
      assert.equal(a.worktreeContext?.repoSlug, 'my-repo', 'all stories route to the single repo slug');
    }

    // wtByRepo-of-one: verified via uniform slug — both stories share the same manager entry.
    const slugs = new Set(captured.map(a => a.worktreeContext?.repoSlug));
    assert.equal(slugs.size, 1, 'wtByRepo holds exactly one slug for a single-repo epic');
  });
});

// ─── (C) single-RepoStage — buildRepoStages and CrossRepoCoordinator ─────────
//
// buildRepoStages with a single-repo epic returns exactly one stage with empty
// dependsOnRepos; topoSortRepos is a no-op; CrossRepoCoordinator.run() calls
// the finalizer exactly once and never calls waitForMerge.

describe('buildRepoStages — single-RepoStage path', () => {
  it('returns exactly one stage for a single-repo epic', () => {
    const m = manifest([entry('mono', { primary: true })]);
    const stories = [story('story-099-001'), story('story-099-002')];
    const stages = buildRepoStages(stories, m, 'mono');

    assert.equal(stages.length, 1, 'exactly one stage for a single-repo epic');
    assert.equal(stages[0].repoSlug, 'mono');
    assert.deepEqual(
      [...stages[0].storyIds].sort(),
      ['story-099-001', 'story-099-002'].sort(),
      'all stories land in the single stage',
    );
    assert.deepEqual(stages[0].dependsOnRepos, [], 'single stage has no repo-level dependencies');
  });

  it('topoSortRepos is a no-op for a single stage', () => {
    const m = manifest([entry('mono', { primary: true })]);
    const stages = buildRepoStages([story('story-099-001')], m, 'mono');
    const sorted = topoSortRepos(stages);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].repoSlug, stages[0].repoSlug);
  });

  it('status starts as pending, ends as landed after run()', async () => {
    const m = manifest([entry('mono', { primary: true })]);
    const stages = buildRepoStages([story('story-001-001')], m, 'mono');
    assert.equal(stages[0].status, 'pending');

    // CrossRepoCoordinator drives status → landed
    const db = openDatabase(path.join(repoDir, '.loom'));
    seedEpic(repoDir, 'epic-099', [story('story-099-001')]);

    const supervisor: SupervisorLike = {
      run: async () => okSupervisorResult(),
    };
    const finalizerCalls: string[] = [];
    const finalizerFactory = (root: string): FinalizerHandle => ({
      finalize: async (epicId: string) => {
        finalizerCalls.push(root);
        return okFinalizeResult('https://github.com/test/repo/pull/1');
      },
    });
    const waitForMergeCalls: string[] = [];

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor,
      finalizerFactory,
      db,
      manifest: m,
      primarySlug: 'mono',
      waitForMergeFn: async (stage) => { waitForMergeCalls.push(stage.repoSlug); },
    });

    const result = await coordinator.run('epic-099');

    assert.equal(result.stages.length, 1, 'exactly one RepoStage');
    assert.equal(result.stages[0].status, 'landed', 'single stage ends as landed');
    assert.equal(finalizerCalls.length, 1, 'finalizer called exactly once (one PR per repo)');
    assert.equal(waitForMergeCalls.length, 0, 'waitForMerge never called for single-repo epic');
  });
});

// ─── SharedContract injection content — byte-identical for single-repo ────────
//
// SharedContract.read returns null for an epic with no contract written.
// When a contract is written it round-trips verbatim. The path and the
// write/read API are unchanged for single-repo epics.

describe('SharedContract — byte-identical injection content for single-repo epic', () => {
  it('returns null for a single-repo epic with no contract on disk (no injection)', () => {
    const body = SharedContract.read(repoDir, 'epic-099');
    assert.equal(body, null, 'absent contract must return null — no injection, byte-identical to pre-change');
  });

  it('written contract round-trips verbatim regardless of repo count', () => {
    const content = '# Contract\n\nNo cross-repo columns — single-repo epic.\n';
    SharedContract.write(repoDir, 'epic-099', content);
    const body = SharedContract.read(repoDir, 'epic-099');
    assert.equal(body, content, 'contract body must round-trip byte-identical');
  });

  it('pathFor returns the same canonical path regardless of repo topology', () => {
    const expected = path.join(repoDir, '.loom', 'contract', 'epic-099.md');
    assert.equal(SharedContract.pathFor(repoDir, 'epic-099'), expected);
  });
});
