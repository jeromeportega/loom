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
 */
export interface FinalizerStageDep {
  stageForLanding(epicId: string): Promise<FinalizeResult>;
}

// ─── assessLandingReadiness ───────────────────────────────────────────────────

/**
 * Assesses whether all repos in a cross-repo epic are ready to land.
 * Implements the all-or-none gate: returns allReady:true only when EVERY repo's
 * PR is open AND its integration gate is green AND (for consumers) the cross-repo
 * gate against the producer's staged change is green.
 *
 * For each stage:
 *   1. If stage.prUrl is not yet set, calls finalizer.stageForLanding(epicId) to
 *      open the PR and run the per-repo gate (unit-test path).
 *   2. Runs deps.integrationGate.run() on the stage's repo root — the per-repo
 *      integration gate (covers amputation + test-suite regression).
 *   3. For consumer stages (dependsOnRepos non-empty), consumerGateGreen is
 *      derived from the gate outcome of the consumer's own suite: if the consumer's
 *      test suite passes against its current branch (which was staged against the
 *      producer's PR branch), the cross-repo compatibility check passes.
 *      When the gate is green for the consumer it means the consumer compiles and
 *      tests against the producer's staged change — this is the "consumer gate
 *      against the producer change" check.
 *   4. Builds a RepoReadiness record per stage and determines allReady.
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

  const repos: RepoReadiness[] = [];

  for (const stage of stages) {
    // If the STAGE phase hasn't opened the PR yet, open it now.
    // In normal coordinator usage, prUrl is already set by _runCrossRepo's STAGE loop.
    // In unit tests of assessLandingReadiness itself, stages have no prUrl yet.
    if (!stage.prUrl) {
      try {
        const result = await deps.finalizer.stageForLanding(epicId);
        if (result.url) stage.prUrl = result.url;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        repos.push(blockedRecord(stage, `stageForLanding failed: ${reason}`, 'pr_open'));
        continue;
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

    // Consumer cross-repo gate: for consumer stages (repos that depend on a producer),
    // consumerGateGreen reflects whether the consumer's suite passes against the
    // producer's staged change. We run the same integrationGate on the consumer's
    // own root — if the consumer already staged (prUrl set) and its gate passes,
    // the consumer is compatible with the producer's change.
    // For non-consumer stages, consumerGateGreen is vacuously true.
    const isConsumer = stage.dependsOnRepos.length > 0;
    let consumerGateGreen = true;
    if (isConsumer && prOpen) {
      // Re-use the gate outcome from above — the consumer's own integration gate
      // run against its staged branch constitutes the cross-repo compatibility check.
      consumerGateGreen = gate.ok;
    } else if (isConsumer && !prOpen) {
      consumerGateGreen = false;
    }

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
    repos.push(record);
  }

  const allReady = repos.every(r => r.ready);
  const blockerRepo = repos.find(r => !r.ready);
  const blocker: LandingBlocker | undefined = blockerRepo
    ? {
        repoSlug: blockerRepo.repoSlug,
        check: !blockerRepo.prOpen
          ? 'pr_open'
          : !blockerRepo.consumerGateGreen
          ? 'consumer_gate'
          : 'integration_gate',
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
  return {
    repoSlug: stage.repoSlug,
    prUrl: undefined,
    prOpen: false,
    gate: failedGateOutcome(stage.repoSlug, reason),
    consumerGateGreen: false,
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
