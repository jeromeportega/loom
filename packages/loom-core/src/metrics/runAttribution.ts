import type { RunMetricsInput, RunOutcome, RunScope } from './types.js';

/**
 * State the orchestrator assembles at the run's terminal region and passes to
 * buildRunAttribution, which maps it to the RunMetricsInput attribution fields
 * that the collector merges before withRunMetrics.finally fires build() + recordRun().
 *
 * Stable run identifier: epicId (epic path) / storyId (standalone path) + startedAt.
 * Per ADR-005 there is no DB-level uniqueness constraint — the exactly-once guarantee
 * is structural (withRunMetrics calls recordRun exactly once per invocation).
 * A fresh-process resume legitimately produces one new, correctly-attributed row;
 * the prior run's row is correlated by the same epicId/storyId with an earlier startedAt.
 */
export interface RunAttributionState {
  scope: RunScope;
  epicId?: string;
  storyId?: string;
  intakeVerdict?: 'story' | 'epic';
  intakeKind?: string;
  storyCount: number;
  /** Prior runs for this epic/story (0 for first run; N for the Nth retry). */
  retryCount: number;
  /** Stall auto-recoveries that used a clean worktree within this run. */
  cleanRetryCount: number;
  /** Stall-triggered auto-recoveries within this run (== cleanRetryCount in the
      current implementation where every auto-recovery uses the clean path). */
  autoRecoveryCount: number;
  outcome?: RunOutcome;
  startedAt?: string;
  endedAt?: string;
}

/**
 * Maps orchestrator run state to the RunMetricsInput attribution slice.
 * Called at the terminal region inside withRunMetrics fn (story-065-004).
 * The result is passed to collector.setAttribution(), which merges it with
 * any prior attribution (scope is already set by withRunMetrics init).
 */
export function buildRunAttribution(state: RunAttributionState): Partial<RunMetricsInput> {
  const attr: Partial<RunMetricsInput> = {
    scope: state.scope,
    storyCount: state.storyCount,
    retryCount: state.retryCount,
    cleanRetryCount: state.cleanRetryCount,
    autoRecoveryCount: state.autoRecoveryCount,
  };
  if (state.epicId !== undefined) attr.epicId = state.epicId;
  if (state.storyId !== undefined) attr.storyId = state.storyId;
  if (state.intakeVerdict !== undefined) attr.intakeVerdict = state.intakeVerdict;
  if (state.intakeKind !== undefined) attr.intakeKind = state.intakeKind;
  if (state.outcome !== undefined) attr.outcome = state.outcome;
  if (state.startedAt !== undefined) attr.startedAt = state.startedAt;
  if (state.endedAt !== undefined) attr.endedAt = state.endedAt;
  return attr;
}
