import type { LandingReport, LandingStorePort } from './landingTypes.js';

/**
 * Derives a LandingReport purely from the landing_attempts + repo_merges ledger.
 * All data comes from the injected store — no external I/O, no separate reporting channel.
 *
 * cleanState is true when every repo is at 'pending' (never touched) or 'reverted'
 * (forward-revert completed), meaning the operator can retry without manual git repair.
 */
export function landingReport(attemptId: string, store: LandingStorePort): LandingReport {
  const { attempt, merges } = store.getAttempt(attemptId);

  const cleanState = merges.every(
    (m) => m.mergeState === 'pending' || m.mergeState === 'reverted',
  );

  const report: LandingReport = {
    attemptId: attempt.id,
    epicId: attempt.epicId,
    status: attempt.status,
    repos: merges.map((m) => ({
      repoSlug: m.repoSlug,
      mergeState: m.mergeState,
      prUrl: m.prUrl,
    })),
    cleanState,
  };

  if (attempt.blocker) {
    report.blocker = attempt.blocker;
  }

  return report;
}
