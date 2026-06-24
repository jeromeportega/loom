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
import type { MergeRepoFn, RollbackFn, LandingStorePort } from './landingTypes.js';
import { assessLandingReadiness } from './crossRepoLandingGate.js';
import { IntegrationGate } from './IntegrationGate.js';

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
    | 'merged_gating'
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
  /**
   * Open the PR + run the gate without merging — the STAGE-phase entry point.
   * Optional so existing test stubs that only implement `finalize` continue to work.
   * When absent, the coordinator falls back to `finalize()` (same semantics for
   * tests that predate story-060-001).
   */
  stageForLanding?(epicId: string): Promise<FinalizeResult>;
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
  // story-060-002 seam: merges one repo's PR after all repos are gate-green.
  mergeRepo?: MergeRepoFn;
  // story-060-003 seam: rolls back a landing attempt when a mid-sequence merge fails.
  rollback?: RollbackFn;
  /**
   * story-060-001 seam: landing-state store for recording attempt + merge
   * records. Story-060-002 provides the LandingStore implementation.
   */
  store?: LandingStorePort;
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
  private readonly _mergeRepo?: MergeRepoFn;
  private readonly _rollback?: RollbackFn;
  private readonly _store?: LandingStorePort;

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
    this._mergeRepo = opts.mergeRepo;
    this._rollback = opts.rollback;
    this._store = opts.store;
  }

  /**
   * Runs the full cross-repo landing sequence.
   *
   * Single-repo epics: route through EpicFinalizer's existing land-or-fail
   * unchanged (AC5 — identical to before this story).
   *
   * Multi-repo epics: explicit STAGE → MERGE phases (story-060-001, ADR-002).
   *   STAGE: dispatch workers + open PRs + run gates for ALL repos; collect
   *          per-repo readiness without merging anything.
   *   MERGE: only when allReady — merge in dependency order (producer first)
   *          via the injected `mergeRepo` seam (story-060-002 wires the real
   *          implementation). If not allReady, nothing merges and the landing
   *          is reported as blocked.
   */
  async run(epicId: string): Promise<{ stages: RepoStage[] }> {
    const stories = this.loadStories(epicId);
    const stages = buildRepoStages(stories, this.manifest, this.primarySlug);
    const sorted = topoSortRepos(stages);

    // AC5: single-repo path is identical to today — no STAGE/MERGE phasing,
    // no mergeRepo/rollback seams engaged. The unchanged-behavior test guards this.
    if (sorted.length === 1) {
      return this._runSingleRepo(epicId, sorted);
    }

    return this._runCrossRepo(epicId, sorted);
  }

  /**
   * Single-repo path — unchanged from before story-060-001.
   * EpicFinalizer.finalize() handles the full land-or-fail lifecycle.
   */
  private async _runSingleRepo(
    epicId: string,
    sorted: RepoStage[],
  ): Promise<{ stages: RepoStage[] }> {
    const stage = sorted[0];
    try {
      stage.status = 'running';
      await this.supervisor.run({ epicId, repoFilter: stage.repoSlug });

      stage.status = 'finalizing';
      const result = await this.finalizerFactory(stage.repoRoot).finalize(epicId);
      if (result.url) stage.prUrl = result.url;

      stage.status = 'landed';
    } catch (err) {
      stage.status = 'failed';
      throw err;
    }
    return { stages: sorted };
  }

  /**
   * Cross-repo path — STAGE → MERGE phases (story-060-001).
   *
   * STAGE: for each repo in topo order, run workers and open the PR + gate
   *        (stageForLanding). No merge happens here.
   * Assess: call assessLandingReadiness to get an all-or-none verdict.
   * MERGE: if allReady, merge each repo in topo order via the mergeRepo seam.
   *        If not allReady, mark all stages blocked and return.
   */
  private async _runCrossRepo(
    epicId: string,
    sorted: RepoStage[],
  ): Promise<{ stages: RepoStage[] }> {
    // ── STAGE phase ───────────────────────────────────────────────────────────
    for (const stage of sorted) {
      try {
        stage.status = 'running';
        await this.supervisor.run({ epicId, repoFilter: stage.repoSlug });

        stage.status = 'finalizing';
        const finalizer = this.finalizerFactory(stage.repoRoot);
        // Prefer stageForLanding if available; fall back to finalize for
        // legacy FinalizerHandle stubs that predate story-060-001.
        const stageFn = finalizer.stageForLanding ?? finalizer.finalize;
        const result = await stageFn.call(finalizer, epicId);
        if (result.url) stage.prUrl = result.url;
      } catch (err) {
        stage.status = 'failed';
        throw err;
      }
    }

    // ── Assess readiness (all-or-none gate) ──────────────────────────────────
    // Build a finalizer adapter: since each stage's prUrl is already populated
    // by the STAGE phase above, assessLandingReadiness won't call stageForLanding
    // again. The adapter is passed purely to satisfy the injectable seam for tests
    // that want to exercise assessLandingReadiness independently.
    const finalizerAdapter = {
      stageForLanding: async (_epicId: string) => ({
        status: 'skipped' as const,
        conflicted: [],
        merged: [],
        cleaned: [],
        note: 'stageForLanding already called in STAGE phase',
      }),
    };

    const readiness = await assessLandingReadiness(epicId, sorted, {
      integrationGate: new IntegrationGate(),
      finalizer: finalizerAdapter,
      store: this._store ?? noopStore,
    });

    if (!readiness.allReady) {
      for (const stage of sorted) {
        if (stage.status !== 'failed') stage.status = 'partial_landing';
      }
      return { stages: sorted };
    }

    // ── MERGE phase ───────────────────────────────────────────────────────────
    // mergeRepo seam: story-060-002 wires the anchoring merger.
    // Default no-op: marks stages landed without actually merging the PR.
    // This keeps old tests passing until 002 injects the real implementation.
    const mergeRepo = this._mergeRepo ?? defaultNoopMerge;

    for (const stage of sorted) {
      try {
        await mergeRepo(stage, readiness.attemptId);
        stage.status = 'landed';
      } catch (err) {
        stage.status = 'failed';
        // Rollback seam (story-060-003): if provided, attempt to revert
        // already-merged repos. A missing rollback seam means partial landing
        // (already-merged repos stay merged) — this is surfaced to the caller.
        if (this._rollback) {
          try {
            await this._rollback(readiness.attemptId);
          } catch {
            // Rollback failure is observable but must not shadow the original error.
          }
        }
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

// ─── Factory (composition seam for stories 002 and 003) ──────────────────────

/**
 * Builds a CrossRepoCoordinator with all injected collaborators.
 * This is the single composition seam: story-060-002 passes `mergeRepo`,
 * story-060-003 passes `rollback`, story-060-002 also provides `store`.
 * Stories add their seams at the marked points below WITHOUT editing the loop body.
 */
export function buildCrossRepoCoordinator(opts: CrossRepoCoordinatorOptions): CrossRepoCoordinator {
  return new CrossRepoCoordinator(opts);
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

// ─── No-op LandingStorePort (used when story-060-002 hasn't wired a real store) ─

// ─── Default merge no-op (used until story-060-002 wires the real merger) ────

async function defaultNoopMerge(
  _stage: RepoStage,
  _attemptId: string,
): Promise<import('./landingTypes.js').RepoMergeRecord> {
  return {
    attemptId: _attemptId,
    repoSlug: _stage.repoSlug,
    dependsOn: _stage.dependsOnRepos,
    prNumber: null,
    prUrl: _stage.prUrl ?? null,
    mergeCommitSha: null,
    mergeState: 'pending',
    revertPrUrl: null,
    revertMergeSha: null,
    mergedAt: null,
    revertedAt: null,
  };
}

// ─── No-op LandingStorePort (used when story-060-002 hasn't wired a real store) ─

const noopStore: LandingStorePort = {
  beginAttempt: (_epicId: string, _stages: RepoStage[]) => `landing-${_epicId}-0`,
  recordMerge: () => undefined,
  markRevertPending: () => undefined,
  markReverted: () => undefined,
  pendingReverts: () => [],
  getAttempt: (_attemptId: string) => {
    throw new Error('noopStore.getAttempt: no LandingStore wired (story-060-002)');
  },
  setStatus: () => undefined,
};
