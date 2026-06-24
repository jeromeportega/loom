import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type Database from 'better-sqlite3';
import { EpicStore } from '../state/index.js';
import { EpicYamlSchema, type Story } from '../types.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';
import { resolveStoryRepo } from './resolveStoryRepo.js';
import { buildRepoDag } from './crossRepoReadiness.js';
import type { FinalizeResult } from './EpicFinalizer.js';
import type { SupervisorResult } from './Supervisor.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RepoStage {
  repoSlug: string;
  repoRoot: string;
  storyIds: string[];
  /** Repo slugs whose PRs must land before this stage can execute (producer repos). */
  dependsOnRepos: string[];
  prUrl?: string;
  status:
    | 'pending'
    | 'running'
    | 'finalizing'
    | 'awaiting_merge'
    | 'landed'
    | 'gated'
    | 'partial_landing'
    | 'failed';
}

/** Minimal interface the coordinator calls on the Supervisor (injectable for tests). */
export interface SupervisorLike {
  run(opts: { epicId?: string; repoFilter?: string }): Promise<SupervisorResult>;
}

/** Minimal interface the coordinator calls on an EpicFinalizer (injectable for tests). */
export interface FinalizerHandle {
  finalize(epicId: string): Promise<FinalizeResult>;
}

export interface CrossRepoCoordinatorOptions {
  /** Primary repo root — where the epic YAML lives. */
  projectRoot: string;
  supervisor: SupervisorLike;
  /**
   * Factory that builds a FinalizerHandle scoped to a specific repo root.
   * Called once per stage; injectable so tests can stub without real git/GitHub.
   */
  finalizerFactory: (repoRoot: string) => FinalizerHandle;
  db: Database.Database;
  manifest: WorkspaceManifest;
  primarySlug: string;
  /**
   * Injectable merge-gate for tests. Defaults to polling `gh pr view` until
   * the PR reaches MERGED state. Only called for stages that have consumers
   * (single-repo epics skip it entirely — AC: identical to today).
   */
  waitForMergeFn?: (stage: RepoStage) => Promise<void>;
  /**
   * story-058-006 seam: runs a cross-repo gate after the producer stage lands
   * and before the consumer stage finalizes. Defaults to a no-op until
   * story-058-006 is implemented.
   */
  runConsumerGateFn?: (producerStage: RepoStage, consumerStage: RepoStage) => Promise<void>;
}

// ─── Pure partition helpers ────────────────────────────────────────────────────

/**
 * Partitions the epic's stories into `RepoStage`s — one per resolved repo.
 * Stories with no `repo` field land in the primary repo's stage.
 */
export function buildRepoStages(
  stories: Story[],
  m: WorkspaceManifest,
  primarySlug: string,
): RepoStage[] {
  const bySlug = new Map<string, { storyIds: string[]; repoRoot: string }>();

  for (const story of stories) {
    const { slug, root } = resolveStoryRepo(story, m, primarySlug);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { storyIds: [], repoRoot: root });
    }
    bySlug.get(slug)!.storyIds.push(story.id);
  }

  const repoDag = buildRepoDag(stories, m, primarySlug);

  const stages: RepoStage[] = [];
  for (const [slug, { storyIds, repoRoot }] of bySlug) {
    stages.push({
      repoSlug: slug,
      repoRoot,
      storyIds,
      dependsOnRepos: repoDag.get(slug) ?? [],
      status: 'pending',
    });
  }
  return stages;
}

/**
 * Topologically orders `RepoStage`s so every producer stage appears before
 * its consumer stages. Uses Kahn's algorithm; falls back to input order on
 * a cycle (validated separately by `validateCrossRepoEdges`).
 */
export function topoSortRepos(stages: RepoStage[]): RepoStage[] {
  const bySlug = new Map<string, RepoStage>(stages.map(s => [s.repoSlug, s]));
  const inDegree = new Map<string, number>(stages.map(s => [s.repoSlug, 0]));

  for (const s of stages) {
    for (const dep of s.dependsOnRepos) {
      // dep must land before s → s's in-degree increases.
      inDegree.set(s.repoSlug, (inDegree.get(s.repoSlug) ?? 0) + 1);
    }
  }

  const queue: RepoStage[] = stages.filter(s => inDegree.get(s.repoSlug) === 0);
  const result: RepoStage[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const s of stages) {
      if (!s.dependsOnRepos.includes(current.repoSlug)) continue;
      const newDeg = (inDegree.get(s.repoSlug) ?? 0) - 1;
      inDegree.set(s.repoSlug, newDeg);
      if (newDeg === 0) queue.push(bySlug.get(s.repoSlug)!);
    }
  }

  // Cycle guard: return input order if topo sort couldn't place every stage.
  return result.length === stages.length ? result : [...stages];
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

export class CrossRepoCoordinator {
  private readonly projectRoot: string;
  private readonly supervisor: SupervisorLike;
  private readonly finalizerFactory: (repoRoot: string) => FinalizerHandle;
  private readonly db: Database.Database;
  private readonly manifest: WorkspaceManifest;
  private readonly primarySlug: string;
  private readonly _waitForMerge: (stage: RepoStage) => Promise<void>;
  private readonly _runConsumerGate: (
    producerStage: RepoStage,
    consumerStage: RepoStage,
  ) => Promise<void>;

  constructor(opts: CrossRepoCoordinatorOptions) {
    this.projectRoot = opts.projectRoot;
    this.supervisor = opts.supervisor;
    this.finalizerFactory = opts.finalizerFactory;
    this.db = opts.db;
    this.manifest = opts.manifest;
    this.primarySlug = opts.primarySlug;
    this._waitForMerge = opts.waitForMergeFn ?? defaultWaitForMerge;
    this._runConsumerGate = opts.runConsumerGateFn ?? noopConsumerGate;
  }

  /**
   * Runs the full cross-repo landing sequence:
   * 1. Partition the epic's stories into per-repo stages.
   * 2. Topo-sort so producers execute before consumers.
   * 3. For each stage:
   *    a. Dispatch stories via `supervisor.run({ epicId, repoFilter })`.
   *    b. Finalize → one PR per repo.
   *    c. For producer stages (those with consumers): wait for the PR to merge
   *       before advancing to the next stage. Single-repo epics skip this step
   *       entirely — behaviour is identical to today.
   */
  async run(epicId: string): Promise<{ stages: RepoStage[] }> {
    const stories = this.loadStories(epicId);
    const stages = buildRepoStages(stories, this.manifest, this.primarySlug);
    const sorted = topoSortRepos(stages);

    // Pre-compute the consumer relationship so waitForMerge is only called
    // for stages that actually gate something. Single-repo → no consumers →
    // no waitForMerge, preserving today's behaviour (AC: identical to today).
    const hasConsumers = (slug: string): boolean =>
      sorted.some(s => s.dependsOnRepos.includes(slug));

    const landed = new Set<string>();

    for (const stage of sorted) {
      // Run this repo's stories via the repoFilter seam (story-058-002).
      stage.status = 'running';
      await this.supervisor.run({ epicId, repoFilter: stage.repoSlug });

      // Finalize: build one PR scoped to this repo (EpicFinalizer unchanged).
      stage.status = 'finalizing';
      const result = await this.finalizerFactory(stage.repoRoot).finalize(epicId);
      if (result.url) stage.prUrl = result.url;

      if (hasConsumers(stage.repoSlug)) {
        // story-058-006 seam: run consumer gate before blocking on merge.
        // Currently a no-op; story-058-006 will wire `runConsumerGateFn`.
        for (const consumer of sorted.filter(s => s.dependsOnRepos.includes(stage.repoSlug))) {
          await this._runConsumerGate(stage, consumer);
        }

        // Block subsequent consumer stages until this PR is merged.
        stage.status = 'awaiting_merge';
        await this._waitForMerge(stage);
      }

      stage.status = 'landed';
      landed.add(stage.repoSlug);
    }

    return { stages: sorted };
  }

  private loadStories(epicId: string): Story[] {
    const epicStore = new EpicStore(this.db);
    const epic = epicStore.get(epicId);
    if (!epic?.yaml_path) {
      throw new Error(`CrossRepoCoordinator: epic "${epicId}" has no yaml_path`);
    }
    const file = path.join(this.projectRoot, epic.yaml_path);
    if (!fs.existsSync(file)) {
      throw new Error(`CrossRepoCoordinator: epic YAML not found at ${file}`);
    }
    return EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8'))).stories;
  }
}

// ─── Default implementations ──────────────────────────────────────────────────

async function defaultWaitForMerge(stage: RepoStage): Promise<void> {
  if (!stage.prUrl) return;
  const { execFileSync } = await import('node:child_process');
  const pollMs = 30_000;
  for (;;) {
    let state: string;
    try {
      state = execFileSync(
        'gh',
        ['pr', 'view', stage.prUrl, '--json', 'state', '--jq', '.state'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch (err) {
      throw new Error(
        `CrossRepoCoordinator.waitForMerge: gh poll failed for ${stage.prUrl}: ${(err as Error).message}`,
      );
    }
    if (state === 'MERGED') return;
    if (state === 'CLOSED') {
      throw new Error(
        `CrossRepoCoordinator.waitForMerge: PR ${stage.prUrl} was closed without merging`,
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, pollMs));
  }
}

async function noopConsumerGate(
  _producerStage: RepoStage,
  _consumerStage: RepoStage,
): Promise<void> {
  // Placeholder for the story-058-006 cross-repo gate seam.
}
