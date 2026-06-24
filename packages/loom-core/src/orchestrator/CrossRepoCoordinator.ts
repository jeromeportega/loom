import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type Database from 'better-sqlite3';
import { EpicStore, AuditLog } from '../state/index.js';
import { EpicYamlSchema, type Story } from '../types.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';
import { resolveStoryRepo } from './resolveStoryRepo.js';
import { buildRepoDag } from './crossRepoReadiness.js';
import type { FinalizeResult } from './EpicFinalizer.js';
import type { SupervisorResult } from './Supervisor.js';
import { CROSS_REPO_ACTIONS } from './landingTypes.js';
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
   * @deprecated No-op in the story-060-001 STAGE→MERGE flow.
   * The consumer gate is now handled inside `assessLandingReadiness` as part of
   * the all-or-none readiness check. story-058-006 should wire the cross-repo
   * compatibility check through `assessLandingReadiness`'s deps instead of this
   * option. This field is kept for API compatibility but is never called.
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
    this.abortSignal = opts.abortSignal;
    this._mergeRepo = opts.mergeRepo;
    this._rollback = opts.rollback;
    this._store = opts.store;
    // runConsumerGateFn is intentionally not stored — it is deprecated and
    // the consumer gate is now handled by assessLandingReadiness (story-060-001).
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
   *        (stageForLanding). No merge happens here. Errors are collected
   *        across all independent stages before aborting — a failure in
   *        repo-a does not prevent independent repo-c from attempting staging.
   *        Stages that depend on a failed producer are skipped (partial_landing).
   * Assess: call assessLandingReadiness to get an all-or-none verdict.
   *         Emits STAGED (success) or BLOCKED (not ready) to the audit log.
   * MERGE: if allReady, merge each repo in topo order via the mergeRepo seam.
   *        If not allReady, mark all stages blocked and return.
   *        On mid-sequence merge failure, remaining un-merged stages are marked
   *        partial_landing before the rollback seam fires.
   */
  private async _runCrossRepo(
    epicId: string,
    sorted: RepoStage[],
  ): Promise<{ stages: RepoStage[] }> {
    const audit = new AuditLog(this.db);

    // ── STAGE phase ───────────────────────────────────────────────────────────
    // Collect errors across all stages rather than aborting on the first failure.
    // Stages whose producer failed are skipped (marked partial_landing) so
    // independent repos still attempt staging even if a sibling fails.
    const stageErrors: Array<{ stage: RepoStage; error: unknown }> = [];
    const failedSlugs = new Set<string>();

    for (const stage of sorted) {
      // Skip if any producer failed — this stage can't succeed without its dep.
      if (stage.dependsOnRepos.some(dep => failedSlugs.has(dep))) {
        stage.status = 'partial_landing';
        continue;
      }
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
        failedSlugs.add(stage.repoSlug);
        stageErrors.push({ stage, error: err });
      }
    }

    if (stageErrors.length > 0) {
      const messages = stageErrors.map(
        e => `${e.stage.repoSlug}: ${e.error instanceof Error ? e.error.message : String(e.error)}`
      );
      throw new Error(
        `CrossRepoCoordinator: STAGE phase failed for ${stageErrors.length} repo(s):\n${messages.join('\n')}`
      );
    }

    // ── Assess readiness (all-or-none gate) ──────────────────────────────────
    // The STAGE loop pre-populated every stage.prUrl. The finalizer adapter below
    // is passed purely to satisfy the injectable seam for assessLandingReadiness;
    // it should never be called since all stages already have prUrls. If it IS
    // called, a stage slipped through without a prUrl — throw to surface the bug
    // rather than silently reporting pr_open:false.
    const finalizerAdapter = {
      stageForLanding: async (_epicId: string, repoRoot: string): Promise<FinalizeResult> => {
        throw new Error(
          `CrossRepoCoordinator: stage for ${repoRoot} has no prUrl after STAGE phase — ` +
          'stageForLanding must not be called during readiness assessment when all stages are pre-staged'
        );
      },
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
      audit.record({
        action: CROSS_REPO_ACTIONS.BLOCKED,
        command: epicId,
        allowed: false,
        detail: {
          attemptId: readiness.attemptId,
          blocker: readiness.blocker,
          repos: sorted.map(s => ({ repoSlug: s.repoSlug, prUrl: s.prUrl ?? null })),
        },
      });
      return { stages: sorted };
    }

    audit.record({
      action: CROSS_REPO_ACTIONS.STAGED,
      command: epicId,
      allowed: true,
      detail: {
        attemptId: readiness.attemptId,
        repos: sorted.map(s => ({ repoSlug: s.repoSlug, prUrl: s.prUrl ?? null })),
      },
    });

    // ── MERGE phase ───────────────────────────────────────────────────────────
    // mergeRepo seam: story-060-002 wires the anchoring merger.
    // Default no-op: marks stages landed without actually merging the PR.
    // This keeps old tests passing until 002 injects the real implementation.
    const mergeRepo = this._mergeRepo ?? defaultNoopMerge;

    // FR-3 fan-in lookup: used in the loop below to assert all deps reached
    // 'landed' before a consumer merges (defence-in-depth — topo sort already
    // guarantees order, but an explicit check catches sort invariant breaks).
    const stageBySlug = new Map(sorted.map(s => [s.repoSlug, s]));

    for (const stage of sorted) {
      // Fan-in gate: every producer repo must be 'landed' before this consumer merges.
      const notLanded = stage.dependsOnRepos.filter(
        dep => stageBySlug.get(dep)?.status !== 'landed',
      );
      if (notLanded.length > 0) {
        throw new Error(
          `CrossRepoCoordinator: fan-in constraint violated for '${stage.repoSlug}' — ` +
          `producer repo(s) not yet landed: ${notLanded.join(', ')}`,
        );
      }
      try {
        await mergeRepo(stage, readiness.attemptId);
        stage.status = 'landed';
      } catch (err) {
        stage.status = 'failed';
        // Mark remaining un-merged stages so callers can distinguish
        // "not yet attempted" from "stuck in staging" or "failed".
        for (const s of sorted) {
          if (s.status === 'finalizing') s.status = 'partial_landing';
        }
        // Rollback seam (story-060-003): if provided, attempt to revert
        // already-merged repos. A missing rollback seam means partial landing
        // (already-merged repos stay merged) — this is surfaced to the caller.
        if (this._rollback) {
          try {
            await this._rollback(readiness.attemptId);
          } catch (rollbackErr) {
            // Rollback failure must not shadow the original merge error,
            // but it must be observable — emit an audit row before rethrowing.
            audit.record({
              action: CROSS_REPO_ACTIONS.ROLLBACK_FAILED,
              command: epicId,
              allowed: false,
              detail: {
                attemptId: readiness.attemptId,
                error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
              },
            });
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
    // 'merged' matches the 'landed' status the coordinator sets immediately
    // after this call, keeping the invariant mergeState:'merged' ↔ stage.status:'landed'.
    mergeState: 'merged',
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
  latestAttemptIdForEpic: () => undefined,
};
