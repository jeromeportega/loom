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
   *
   * Known limitation: the default implementation polls indefinitely with no
   * built-in deadline. Pass `abortSignal` on this options object to cancel it,
   * or set a process-level timeout before calling `coordinator.run()`.
   */
  waitForMergeFn?: (stage: RepoStage, signal?: AbortSignal) => Promise<void>;
  /**
   * Optional AbortSignal that cancels any in-progress `waitForMerge` poll.
   * Useful for integration tests and callers that need a hard wall-clock limit.
   */
  abortSignal?: AbortSignal;
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
 * its consumer stages. Uses Kahn's algorithm; throws on a cycle (cycles are
 * validated upstream by `validateCrossRepoEdges` — this is a defence-in-depth
 * guard so a bypassed or diverged DAG fails loudly rather than silently).
 */
export function topoSortRepos(stages: RepoStage[]): RepoStage[] {
  const bySlug = new Map<string, RepoStage>(stages.map(s => [s.repoSlug, s]));
  const inDegree = new Map<string, number>(stages.map(s => [s.repoSlug, 0]));

  for (const s of stages) {
    // Deduplicate to avoid over-counting in-degree when a slug appears twice.
    const deps = [...new Set(s.dependsOnRepos)];
    inDegree.set(s.repoSlug, (inDegree.get(s.repoSlug) ?? 0) + deps.length);
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

  if (result.length < stages.length) {
    const inCycle = stages.filter(s => !result.includes(s)).map(s => s.repoSlug);
    throw new Error(
      `CrossRepoCoordinator: cycle detected among repo stages: ${inCycle.join(', ')}`,
    );
  }
  return result;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

export class CrossRepoCoordinator {
  private readonly projectRoot: string;
  private readonly supervisor: SupervisorLike;
  private readonly finalizerFactory: (repoRoot: string) => FinalizerHandle;
  private readonly db: Database.Database;
  private readonly manifest: WorkspaceManifest;
  private readonly primarySlug: string;
  private readonly _waitForMerge: (stage: RepoStage, signal?: AbortSignal) => Promise<void>;
  private readonly abortSignal?: AbortSignal;
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
    this.abortSignal = opts.abortSignal;
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
      // Runtime topo-sort invariant: all declared producer deps must be landed
      // before this stage executes. topoSortRepos guarantees this; this
      // assertion catches any future regression at the call site.
      if (!stage.dependsOnRepos.every(dep => landed.has(dep))) {
        throw new Error(
          `CrossRepoCoordinator: topo-sort invariant violated — deps not yet landed for ${stage.repoSlug}`,
        );
      }

      try {
        // Run this repo's stories via the repoFilter seam (story-058-002).
        stage.status = 'running';
        await this.supervisor.run({ epicId, repoFilter: stage.repoSlug });

        // Finalize: build one PR scoped to this repo (EpicFinalizer unchanged).
        stage.status = 'finalizing';
        const result = await this.finalizerFactory(stage.repoRoot).finalize(epicId);
        if (result.url) stage.prUrl = result.url;

        if (hasConsumers(stage.repoSlug)) {
          // Set status before calling _runConsumerGate so story-058-006 sees
          // the correct state when it reads producerStage.status.
          stage.status = 'awaiting_merge';

          // story-058-006 seam: run consumer gate before blocking on merge.
          // `producerStage.status` is `'awaiting_merge'` at invocation time.
          // Currently a no-op; story-058-006 will wire `runConsumerGateFn`.
          for (const consumer of sorted.filter(s => s.dependsOnRepos.includes(stage.repoSlug))) {
            await this._runConsumerGate(stage, consumer);
          }

          // Block subsequent consumer stages until this PR is merged.
          await this._waitForMerge(stage, this.abortSignal);
        }

        stage.status = 'landed';
        landed.add(stage.repoSlug);
      } catch (err) {
        stage.status = 'failed';
        throw err;
      }
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
    // Prevent path traversal: yaml_path must not escape the project root.
    const resolvedFile = path.resolve(file);
    const resolvedRoot = path.resolve(this.projectRoot);
    if (!resolvedFile.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`CrossRepoCoordinator: yaml_path escapes project root`);
    }
    if (!fs.existsSync(resolvedFile)) {
      throw new Error(`CrossRepoCoordinator: epic YAML not found at ${resolvedFile}`);
    }
    return EpicYamlSchema.parse(yaml.load(fs.readFileSync(resolvedFile, 'utf8'))).stories;
  }
}

// ─── Default implementations ──────────────────────────────────────────────────

async function defaultWaitForMerge(stage: RepoStage, signal?: AbortSignal): Promise<void> {
  if (!stage.prUrl) {
    throw new Error(
      `CrossRepoCoordinator: producer stage '${stage.repoSlug}' has no prUrl — cannot wait for merge`,
    );
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const pollMs = 30_000;
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) {
      throw new Error(
        `CrossRepoCoordinator.waitForMerge: aborted while waiting for ${stage.prUrl}`,
      );
    }
    let state: string;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', stage.prUrl, '--json', 'state', '--jq', '.state'],
        { encoding: 'utf8' },
      );
      state = stdout.trim();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new Error(
          `CrossRepoCoordinator.waitForMerge: gh poll failed 3 consecutive times for ${stage.prUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await abortableSleep(pollMs, signal);
      continue;
    }
    if (state === 'MERGED') return;
    if (state === 'CLOSED') {
      throw new Error(
        `CrossRepoCoordinator.waitForMerge: PR ${stage.prUrl} was closed without merging`,
      );
    }
    await abortableSleep(pollMs, signal);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('CrossRepoCoordinator.waitForMerge: aborted during sleep'));
      },
      { once: true },
    );
  });
}

async function noopConsumerGate(
  _producerStage: RepoStage,
  _consumerStage: RepoStage,
): Promise<void> {
  // Placeholder for the story-058-006 cross-repo gate seam.
}
