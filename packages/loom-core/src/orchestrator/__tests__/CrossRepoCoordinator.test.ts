/**
 * story-058-005: One PR per repo, landed in dependency order.
 *
 * Test plan:
 *  (1) Partition: stories split into RepoStage keyed by resolved repo; a story
 *      with no `repo` lands in the primary's stage.
 *  (2) topoSortRepos: producer repo's stage before the consumer repo's stage.
 *  (3) EpicFinalizer.finalize(epicId) invoked exactly once per repoRoot → one PR
 *      per repo; no finalize call spans two repo roots.
 *  (4) Consumer stage stays in `awaiting_merge` and does not finalize until
 *      waitForMerge resolves — assert producer PR merges before consumer starts.
 *  (5) Single-repo regression: one RepoStage, one finalize, no waitForMerge.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';

import { openDatabase, createDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import {
  buildRepoStages,
  topoSortRepos,
  CrossRepoCoordinator,
  type RepoStage,
  type SupervisorLike,
  type FinalizerHandle,
} from '../CrossRepoCoordinator.js';
import type { WorkspaceManifest, ManifestEntry } from '../../home/workspaceManifest.js';
import type { Story } from '../../types.js';
import type { SupervisorResult } from '../Supervisor.js';
import type { FinalizeResult } from '../EpicFinalizer.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function entry(slug: string, opts: { primary?: boolean } = {}): ManifestEntry {
  return { slug, path: `/repos/${slug}`, remote_url: null, ...opts };
}

function manifest(repos: ManifestEntry[]): WorkspaceManifest {
  return { version: 1, repos };
}

function story(id: string, deps: string[] = [], repo?: string): Story {
  return {
    id,
    title: `Story ${id} title`,
    description: 'description',
    acceptance_criteria: ['AC1'],
    estimated_complexity: 'medium',
    dependencies: deps,
    ...(repo !== undefined ? { repo } : {}),
  };
}

const TWO_REPO_MANIFEST = manifest([entry('repo-api', { primary: true }), entry('repo-frontend')]);
const TWO_REPO_PRIMARY = 'repo-api';
const SINGLE_REPO_MANIFEST = manifest([entry('repo-mono', { primary: true })]);
const SINGLE_REPO_PRIMARY = 'repo-mono';

// Minimal SupervisorResult for stubs.
function okResult(): SupervisorResult {
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

// Minimal FinalizeResult for stubs.
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

// ─── (1) buildRepoStages — partition ─────────────────────────────────────────

describe('buildRepoStages — partition', () => {
  it('groups stories by resolved repo slug', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', [], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);

    assert.equal(stages.length, 2);
    const api = stages.find(s => s.repoSlug === 'repo-api');
    const fe = stages.find(s => s.repoSlug === 'repo-frontend');
    assert.ok(api);
    assert.ok(fe);
    assert.deepEqual(api!.storyIds, ['story-001-001']);
    assert.deepEqual(fe!.storyIds, ['story-001-002']);
  });

  it('stories with no repo land in the primary stage', () => {
    const stories = [
      story('story-001-001'),           // no repo → primary (repo-api)
      story('story-001-002', [], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);

    const api = stages.find(s => s.repoSlug === 'repo-api');
    assert.ok(api);
    assert.ok(api!.storyIds.includes('story-001-001'), 'no-repo story must land in primary stage');
  });

  it('multiple stories for the same repo land in the same stage', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', [], 'repo-api'),
      story('story-001-003', [], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);

    assert.equal(stages.length, 2);
    const api = stages.find(s => s.repoSlug === 'repo-api');
    assert.equal(api!.storyIds.length, 2);
  });

  it('sets dependsOnRepos from the cross-repo DAG', () => {
    // story-001-002 (frontend) depends on story-001-001 (api) → cross-repo edge.
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);

    const fe = stages.find(s => s.repoSlug === 'repo-frontend');
    assert.deepEqual(fe!.dependsOnRepos, ['repo-api']);

    const api = stages.find(s => s.repoSlug === 'repo-api');
    assert.deepEqual(api!.dependsOnRepos, []);
  });

  it('same-repo deps do NOT appear in dependsOnRepos', () => {
    // Both stories default to the single repo — intra-repo dep must not create a cross-repo edge.
    const stories = [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ];
    const stages = buildRepoStages(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);

    assert.equal(stages.length, 1);
    assert.deepEqual(stages[0].dependsOnRepos, []);
  });

  it('single-repo epic produces exactly one stage', () => {
    const stories = [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ];
    const stages = buildRepoStages(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);

    assert.equal(stages.length, 1);
    assert.equal(stages[0].repoSlug, 'repo-mono');
    assert.equal(stages[0].storyIds.length, 2);
  });

  it('all stages start with status pending', () => {
    const stories = [story('story-001-001')];
    const stages = buildRepoStages(stories, SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);

    for (const s of stages) {
      assert.equal(s.status, 'pending');
    }
  });
});

// ─── (2) topoSortRepos ────────────────────────────────────────────────────────

describe('topoSortRepos — producer before consumer', () => {
  it('places the producer stage before the consumer stage', () => {
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', ['story-001-001'], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    const sorted = topoSortRepos(stages);

    assert.equal(sorted.length, 2);
    const apiIdx = sorted.findIndex(s => s.repoSlug === 'repo-api');
    const feIdx = sorted.findIndex(s => s.repoSlug === 'repo-frontend');
    assert.ok(apiIdx < feIdx, 'producer (repo-api) must come before consumer (repo-frontend)');
  });

  it('handles three repos in a chain — A→B→C', () => {
    const mf = manifest([
      entry('repo-a', { primary: true }),
      entry('repo-b'),
      entry('repo-c'),
    ]);
    const stories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
      story('story-001-003', ['story-001-002'], 'repo-c'),
    ];
    const stages = buildRepoStages(stories, mf, 'repo-a');
    const sorted = topoSortRepos(stages);

    const aIdx = sorted.findIndex(s => s.repoSlug === 'repo-a');
    const bIdx = sorted.findIndex(s => s.repoSlug === 'repo-b');
    const cIdx = sorted.findIndex(s => s.repoSlug === 'repo-c');
    assert.ok(aIdx < bIdx, 'repo-a before repo-b');
    assert.ok(bIdx < cIdx, 'repo-b before repo-c');
  });

  it('single stage sorted list equals input', () => {
    const stages = buildRepoStages([story('story-001-001')], SINGLE_REPO_MANIFEST, SINGLE_REPO_PRIMARY);
    const sorted = topoSortRepos(stages);
    assert.equal(sorted.length, 1);
    assert.equal(sorted[0].repoSlug, 'repo-mono');
  });

  it('independent repos (no cross-repo edges) are both included', () => {
    // Two repos with no dependency between them.
    const stories = [
      story('story-001-001', [], 'repo-api'),
      story('story-001-002', [], 'repo-frontend'),
    ];
    const stages = buildRepoStages(stories, TWO_REPO_MANIFEST, TWO_REPO_PRIMARY);
    const sorted = topoSortRepos(stages);

    assert.equal(sorted.length, 2);
    const slugs = sorted.map(s => s.repoSlug).sort();
    assert.deepEqual(slugs, ['repo-api', 'repo-frontend']);
  });

  it('handles duplicate entries in dependsOnRepos without false cycle detection', () => {
    // If buildRepoDag emitted the same slug twice in dependsOnRepos, the
    // in-degree would be over-counted and the stage would never reach 0.
    // topoSortRepos must deduplicate before computing in-degree.
    const dupStages: RepoStage[] = [
      {
        repoSlug: 'repo-a',
        repoRoot: '/repos/repo-a',
        storyIds: ['s1'],
        dependsOnRepos: [],
        status: 'pending',
      },
      {
        repoSlug: 'repo-b',
        repoRoot: '/repos/repo-b',
        storyIds: ['s2'],
        // Intentional duplicate — must not trigger false cycle error.
        dependsOnRepos: ['repo-a', 'repo-a'],
        status: 'pending',
      },
    ];
    const sorted = topoSortRepos(dupStages);
    assert.equal(sorted.length, 2);
    const aIdx = sorted.findIndex(s => s.repoSlug === 'repo-a');
    const bIdx = sorted.findIndex(s => s.repoSlug === 'repo-b');
    assert.ok(aIdx < bIdx, 'producer must still come before consumer with duplicate deps');
  });

  it('throws when a cycle is detected instead of silently returning input order', () => {
    // Manually construct a cyclic stage graph (A depends on B, B depends on A).
    const cycleStages: RepoStage[] = [
      {
        repoSlug: 'repo-a',
        repoRoot: '/repos/repo-a',
        storyIds: ['s1'],
        dependsOnRepos: ['repo-b'],
        status: 'pending',
      },
      {
        repoSlug: 'repo-b',
        repoRoot: '/repos/repo-b',
        storyIds: ['s2'],
        dependsOnRepos: ['repo-a'],
        status: 'pending',
      },
    ];
    assert.throws(
      () => topoSortRepos(cycleStages),
      /cycle detected among repo stages/,
    );
  });
});

// ─── Integration: CrossRepoCoordinator.run ────────────────────────────────────

// Helpers for integration tests that need a real DB + YAML on disk.

function gitc(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'ignore' });
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

function seedEpicOnDisk(repoDir: string, epicId: string, stories: Story[]): void {
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

  // Use createDatabase (non-singleton) so we can safely close it here without
  // poisoning the module-level singleton that openDatabase() returns.
  const db = createDatabase(path.join(repoDir, '.loom', 'loom.db'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
  db.close();
}

// ─── Test state ───────────────────────────────────────────────────────────────

let repoDir: string;
let repoDirB: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-crc-a-'));
  repoDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-crc-b-'));
  initRepo(repoDir);
  initRepo(repoDirB);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(repoDirB, { recursive: true, force: true });
});

// ─── (3) Exactly one finalize call per repoRoot ───────────────────────────────

describe('CrossRepoCoordinator.run — one PR per repo', () => {
  it('(3) calls finalizerFactory exactly once per repoRoot, never spanning two roots', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    const supervisorCalls: Array<{ epicId?: string; repoFilter?: string }> = [];
    const stubSupervisor: SupervisorLike = {
      run: async (opts) => { supervisorCalls.push(opts); return okResult(); },
    };

    // Track which repoRoots finalize was called for.
    const finalizeCalls: string[] = [];
    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async (_epicId) => {
        finalizeCalls.push(repoRoot);
        return okFinalizeResult(`https://github.com/org/repo-${repoRoot}/pull/1`);
      },
    });

    // waitForMerge resolves immediately for tests.
    const waitForMergeCalls: string[] = [];
    const waitForMergeFn = async (stage: RepoStage) => {
      waitForMergeCalls.push(stage.repoSlug);
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: stubSupervisor,
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: 'repo-a',
      waitForMergeFn,
    });

    const { stages } = await coordinator.run('epic-001');

    // Exactly one finalize per repo root.
    assert.equal(finalizeCalls.length, 2, 'must call finalize exactly once per repo');
    // Roots must be distinct — no single call spans two repos.
    const uniqueRoots = new Set(finalizeCalls);
    assert.equal(uniqueRoots.size, 2, 'each finalize call must target a distinct repo root');
    // The roots should be the registered repo paths.
    assert.ok(uniqueRoots.has(realA), 'repo-a root must be finalized');
    assert.ok(uniqueRoots.has(realB), 'repo-b root must be finalized');

    // Two stages produced.
    assert.equal(stages.length, 2);
  });
});

// ─── (4) story-060-001: STAGE→MERGE phasing ──────────────────────────────────
// These tests replace the old "consumer waits for producer merge" suite.
// The new behavior: STAGE all repos first (no merge during staging), then
// MERGE all in topo order only when allReady. If any repo is not ready,
// no repo merges (all-or-none gate, ADR-002).

describe('CrossRepoCoordinator.run — STAGE→MERGE phasing (story-060-001)', () => {
  it('(4a) STAGE phase runs all repos before any mergeRepo call', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    const callOrder: string[] = [];

    const stubSupervisor: SupervisorLike = {
      run: async (opts) => {
        callOrder.push(`supervisor:${opts.repoFilter}`);
        return okResult();
      },
    };

    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async (_epicId) => {
        const slug = repoRoot === realA ? 'repo-a' : 'repo-b';
        callOrder.push(`finalize:${slug}`);
        return okFinalizeResult(`https://github.com/org/${slug}/pull/1`);
      },
    });

    const mergeRepoCalls: string[] = [];
    const mergeRepo = async (stage: RepoStage) => {
      mergeRepoCalls.push(stage.repoSlug);
      return {
        attemptId: 'attempt-001',
        repoSlug: stage.repoSlug,
        dependsOn: stage.dependsOnRepos,
        prNumber: 1,
        prUrl: stage.prUrl ?? null,
        mergeCommitSha: 'abc123',
        mergeState: 'merged' as const,
        revertPrUrl: null,
        revertMergeSha: null,
        mergedAt: new Date().toISOString(),
        revertedAt: null,
      };
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: stubSupervisor,
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: 'repo-a',
      mergeRepo,
    });

    await coordinator.run('epic-001');

    // STAGE phase: producer supervisor + finalize, then consumer supervisor + finalize
    // (no waitForMerge, no mergeRepo calls during STAGE).
    const stageEvents = callOrder;
    assert.deepEqual(stageEvents, [
      'supervisor:repo-a',
      'finalize:repo-a',
      'supervisor:repo-b',
      'finalize:repo-b',
    ]);

    // MERGE phase: mergeRepo called AFTER all staging, in topo order.
    assert.deepEqual(mergeRepoCalls, ['repo-a', 'repo-b']);
  });

  it('(4b) mergeRepo NOT called during STAGE; called once per repo after allReady', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    // Track when each event fires.
    const events: string[] = [];

    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async () => {
        const slug = repoRoot === realA ? 'repo-a' : 'repo-b';
        events.push(`stage:${slug}`);
        return okFinalizeResult(`https://github.com/org/${slug}/pull/1`);
      },
    });

    const mergeRepo = async (stage: RepoStage) => {
      events.push(`merge:${stage.repoSlug}`);
      return {
        attemptId: 'attempt-001',
        repoSlug: stage.repoSlug,
        dependsOn: stage.dependsOnRepos,
        prNumber: 1,
        prUrl: stage.prUrl ?? null,
        mergeCommitSha: 'sha',
        mergeState: 'merged' as const,
        revertPrUrl: null,
        revertMergeSha: null,
        mergedAt: new Date().toISOString(),
        revertedAt: null,
      };
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: 'repo-a',
      mergeRepo,
    });

    await coordinator.run('epic-001');

    // All STAGE events must precede all MERGE events.
    const firstMergeIdx = events.findIndex(e => e.startsWith('merge:'));
    const lastStageIdx = events.reduce((acc, e, i) => e.startsWith('stage:') ? i : acc, -1);
    assert.ok(lastStageIdx < firstMergeIdx, 'all staging must complete before any merge');

    // mergeRepo called exactly once per repo.
    const mergeCalls = events.filter(e => e.startsWith('merge:'));
    assert.equal(mergeCalls.length, 2);
    assert.deepEqual(new Set(mergeCalls), new Set(['merge:repo-a', 'merge:repo-b']));
  });

  it('(4c) merge order is producer-before-consumer (AC3)', async () => {
    const realA = fs.realpathSync(repoDir);
    const realB = fs.realpathSync(repoDirB);

    const epicStories = [
      story('story-001-001', [], 'repo-a'),
      story('story-001-002', ['story-001-001'], 'repo-b'),
    ];
    seedEpicOnDisk(repoDir, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [
        { slug: 'repo-a', path: realA, remote_url: null, primary: true },
        { slug: 'repo-b', path: realB, remote_url: null },
      ],
    };

    const mergeOrder: string[] = [];
    const mergeRepo = async (stage: RepoStage) => {
      mergeOrder.push(stage.repoSlug);
      return {
        attemptId: 'a', repoSlug: stage.repoSlug, dependsOn: stage.dependsOnRepos,
        prNumber: 1, prUrl: null, mergeCommitSha: 'sha', mergeState: 'merged' as const,
        revertPrUrl: null, revertMergeSha: null, mergedAt: null, revertedAt: null,
      };
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({
        finalize: async () => okFinalizeResult('https://github.com/org/repo/pull/1'),
      }),
      db,
      manifest: mf,
      primarySlug: 'repo-a',
      mergeRepo,
    });

    await coordinator.run('epic-001');

    // Producer (repo-a) must merge before consumer (repo-b).
    assert.deepEqual(mergeOrder, ['repo-a', 'repo-b'],
      'producer must merge before consumer (AC3)');
  });
});

// ─── (5) Single-repo regression ───────────────────────────────────────────────

describe('CrossRepoCoordinator.run — single-repo regression', () => {
  it('(5) produces exactly one stage and one finalize call with no waitForMerge', async () => {
    const realA = fs.realpathSync(repoDir);

    const epicStories = [
      story('story-001-001'),
      story('story-001-002', ['story-001-001']),
    ];
    seedEpicOnDisk(repoDir, 'epic-001', epicStories);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'repo-mono', path: realA, remote_url: null, primary: true }],
    };

    const finalizeCalls: string[] = [];
    const finalizerFactory = (repoRoot: string): FinalizerHandle => ({
      finalize: async (_epicId) => {
        finalizeCalls.push(repoRoot);
        return okFinalizeResult('https://github.com/org/mono/pull/1');
      },
    });

    const waitForMergeCalls: string[] = [];
    const waitForMergeFn = async (stage: RepoStage) => {
      waitForMergeCalls.push(stage.repoSlug);
    };

    const stubSupervisor: SupervisorLike = {
      run: async () => okResult(),
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: stubSupervisor,
      finalizerFactory,
      db,
      manifest: mf,
      primarySlug: 'repo-mono',
      waitForMergeFn,
    });

    const { stages } = await coordinator.run('epic-001');

    // Exactly one stage.
    assert.equal(stages.length, 1);
    // Exactly one finalize call.
    assert.equal(finalizeCalls.length, 1);
    assert.equal(finalizeCalls[0], realA);
    // No waitForMerge — single-repo is identical to today.
    assert.equal(waitForMergeCalls.length, 0, 'single-repo must not call waitForMerge');
    // Stage lands successfully.
    assert.equal(stages[0].status, 'landed');
  });

  it('(5) single-repo stage ends with status=landed', async () => {
    const realA = fs.realpathSync(repoDir);
    seedEpicOnDisk(repoDir, 'epic-001', [story('story-001-001')]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const mf: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'repo-mono', path: realA, remote_url: null, primary: true }],
    };

    const coordinator = new CrossRepoCoordinator({
      projectRoot: repoDir,
      supervisor: { run: async () => okResult() },
      finalizerFactory: () => ({ finalize: async () => okFinalizeResult() }),
      db,
      manifest: mf,
      primarySlug: 'repo-mono',
    });

    const { stages } = await coordinator.run('epic-001');
    assert.equal(stages[0].status, 'landed');
  });
});
