import type { RepoStage } from './CrossRepoCoordinator.js';
import type { FinalizeResult } from './EpicFinalizer.js';
import type { GateRunner } from './crossRepoGate.js';
import type {
  LandingReadiness,
  LandingStorePort,
  LandingBlocker,
  RepoReadiness,
} from './landingTypes.js';
import type { GateOutcome } from './IntegrationGate.js';

export type { GateRunner };

// ─── Injectable finalizer seam ────────────────────────────────────────────────

/**
 * Minimal interface for the finalizer used in assessLandingReadiness.
 * EpicFinalizer satisfies this structurally via stageForLanding().
 * Tests stub it with a plain object.
 *
 * The repoRoot param lets a single finalizer instance know which repo to stage
 * when called for multiple stages without per-stage context. In normal coordinator
 * usage, prUrl is pre-populated by the STAGE loop so this is never called.
 */
export interface FinalizerStageDep {
  stageForLanding(epicId: string, repoRoot: string): Promise<FinalizeResult>;
}

// ─── assessLandingReadiness ───────────────────────────────────────────────────

/**
 * Assesses whether all repos in a cross-repo epic are ready to land.
 * Implements the all-or-none gate: returns allReady:true only when EVERY repo's
 * PR is open AND its integration gate is green AND (for consumers) the cross-repo
 * gate against the producer's staged change is green.
 *
 * For each stage:
 *   1. If stage.prUrl is not yet set, calls finalizer.stageForLanding(epicId, repoRoot) to
 *      open the PR and run the per-repo gate (unit-test path).
 *   2. Runs deps.integrationGate.run() on the stage's repo root — the per-repo
 *      integration gate (covers amputation + test-suite regression).
 *   3. consumerGateGreen is a forward stub (always true for now). The real cross-repo
 *      compatibility check — consumer compiled + tested against producer's staged branch —
 *      is wired by story-058-006 via assessLandingReadiness's deps. Until then, a consumer
 *      that fails its own integration gate is reported as check:'integration_gate', not
 *      check:'consumer_gate'. 'consumer_gate' is reserved for the cross-repo check.
 *   4. Builds a RepoReadiness record per stage and determines allReady.
 *
 * Gate assessment runs in parallel across stages (independent checks; no data dependency).
 * Results are returned in the original stage order.
 *
 * No merge is performed here — the MERGE phase is exclusively owned by
 * CrossRepoCoordinator._runCrossRepo after this function returns allReady:true.
 *
 * ADR-002: a repo ready early sits idle waiting for its partner — higher latency
 * in exchange for a clean "blocked, nothing merged" state on any failure.
 */
export async function assessLandingReadiness(
  epicId: string,
  stages: RepoStage[],
  deps: {
    integrationGate: GateRunner;
    finalizer: FinalizerStageDep;
    store: LandingStorePort;
  },
): Promise<LandingReadiness> {
  const attemptId = deps.store.beginAttempt(epicId, stages);

  // Edge case: no stages → trivially ready (nothing to land).
  if (stages.length === 0) {
    deps.store.setStatus(attemptId, 'merging');
    return { epicId, attemptId, allReady: true, repos: [] };
  }

  // Run all stages in parallel — gate checks are independent per-repo.
  // Results are collected in the original stage order via Promise.all index.
  const repos: RepoReadiness[] = await Promise.all(stages.map(async (stage) => {
    // If the STAGE phase hasn't opened the PR yet, open it now.
    // In normal coordinator usage, prUrl is already set by _runCrossRepo's STAGE loop.
    // In unit tests of assessLandingReadiness itself, stages have no prUrl yet.
    if (!stage.prUrl) {
      try {
        const result = await deps.finalizer.stageForLanding(epicId, stage.repoRoot);
        if (result.url) stage.prUrl = result.url;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return blockedRecord(stage, `stageForLanding failed: ${reason}`, 'pr_open');
      }
    }

    const prOpen = stage.prUrl !== undefined;

    // Per-repo integration gate (amputation + test-suite regression).
    let gate: GateOutcome;
    if (!prOpen) {
      gate = failedGateOutcome(stage.repoSlug, 'PR not open — cannot run gate');
    } else {
      try {
        gate = await deps.integrationGate.run({ projectRoot: stage.repoRoot });
      } catch (err) {
        gate = failedGateOutcome(
          stage.repoSlug,
          `Integration gate threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // consumerGateGreen is a forward stub for the cross-repo compatibility check
    // (consumer compiled + tested against producer's staged branch, story-058-006).
    // It is intentionally kept separate from gate.ok so that:
    //   - 'integration_gate' check = consumer's own test suite failed
    //   - 'consumer_gate' check = cross-repo compatibility failed (reserved for 058-006)
    // For non-consumer stages, consumerGateGreen is vacuously true.
    const isConsumer = stage.dependsOnRepos.length > 0;
    const consumerGateGreen = isConsumer
      ? (prOpen ? true : false)  // stub: true when PR is open; real check wired by 058-006
      : true;

    const ready = prOpen && gate.ok && consumerGateGreen;
    const reason = !prOpen
      ? `PR not open for ${stage.repoSlug}`
      : !gate.ok
      ? gate.summary
      : !consumerGateGreen
      ? `Consumer gate failed for ${stage.repoSlug}`
      : undefined;

    const record: RepoReadiness = {
      repoSlug: stage.repoSlug,
      prUrl: stage.prUrl,
      prOpen,
      gate,
      consumerGateGreen,
      ready,
    };
    if (reason !== undefined) record.reason = reason;
    return record;
  }));

  const allReady = repos.every(r => r.ready);
  const blockerRepo = repos.find(r => !r.ready);
  // Blocker check precedence (explicit ordering prevents misclassification):
  //   1. pr_open — the PR was never opened; gate couldn't run at all
  //   2. integration_gate — the repo's own build/test suite failed
  //   3. consumer_gate — cross-repo compatibility check failed (stub; wired by 058-006)
  const blocker: LandingBlocker | undefined = blockerRepo
    ? {
        repoSlug: blockerRepo.repoSlug,
        check: !blockerRepo.prOpen
          ? 'pr_open'
          : !blockerRepo.gate.ok
          ? 'integration_gate'
          : 'consumer_gate',
        reason: blockerRepo.reason ?? `${blockerRepo.repoSlug} is not ready`,
      }
    : undefined;

  deps.store.setStatus(attemptId, allReady ? 'merging' : 'blocked', blocker);

  return {
    epicId,
    attemptId,
    allReady,
    repos,
    ...(blocker !== undefined ? { blocker } : {}),
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function blockedRecord(
  stage: RepoStage,
  reason: string,
  check: LandingBlocker['check'],
): RepoReadiness {
  // Producers have no consumer gate (they don't depend on anyone), so their
  // consumerGateGreen defaults to true. Consumer stages that fail to open a PR
  // can't run the consumer gate either — default to false (unknown/not-run).
  const isConsumer = stage.dependsOnRepos.length > 0;
  return {
    repoSlug: stage.repoSlug,
    prUrl: undefined,
    prOpen: false,
    gate: failedGateOutcome(stage.repoSlug, reason),
    consumerGateGreen: !isConsumer,
    ready: false,
    reason,
  };
}

function failedGateOutcome(repoSlug: string, reason: string): GateOutcome {
  return {
    ok: false,
    ran: false,
    timedOut: false,
    durationMs: 0,
    output: '',
    amputated: [],
    summary: reason,
  };
}
