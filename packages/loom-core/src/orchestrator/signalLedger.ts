import { minimatch } from 'minimatch';
import { gitSafe } from './git.js';
import { resolveCostTier, tierSteps } from './tier.js';
import type { HeuristicSignals, SelfAssessment, StorySignals, TriageSignal } from '../types.js';

export interface HeuristicInput {
  worktreePath: string;
  baseSha: string;
  riskyPaths: string[];
  /** Pass null this release — no first-try test source exists (ADR-3). */
  testsGreenFirstTry: boolean | null;
}

/**
 * Computes free, state-derived heuristics for a story's completed branch.
 * Uses `git diff --numstat` and `--name-only` over `baseSha..HEAD` — the same
 * range that BaseCliWorker.changedFiles uses.
 */
export function computeHeuristics(input: HeuristicInput): HeuristicSignals {
  const range = `${input.baseSha}..HEAD`;

  const numstatRes = gitSafe(input.worktreePath, ['diff', '--numstat', range]);
  const nameOnlyRes = gitSafe(input.worktreePath, ['diff', '--name-only', range]);

  let diff_lines = 0;
  let diff_files = 0;

  if (numstatRes.ok && numstatRes.output.length > 0) {
    for (const line of numstatRes.output.split('\n').filter((l) => l.trim().length > 0)) {
      diff_files++;
      // Binary files show as "-\t-\t<file>"; parseInt('-') === NaN — skip gracefully.
      const [addedStr, deletedStr] = line.split('\t');
      const added = parseInt(addedStr, 10);
      const deleted = parseInt(deletedStr, 10);
      if (!isNaN(added)) diff_lines += added;
      if (!isNaN(deleted)) diff_lines += deleted;
    }
  }

  const changedFiles: string[] =
    nameOnlyRes.ok && nameOnlyRes.output.length > 0
      ? nameOnlyRes.output
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
      : [];

  const risky_paths_touched = changedFiles.filter((file) =>
    input.riskyPaths.some((pattern) => minimatch(file, pattern))
  );

  return {
    diff_lines,
    diff_files,
    tests_green_first_try: input.testsGreenFirstTry,
    risky_paths_touched,
  };
}

/**
 * Assembles a StorySignals record from computed heuristics and optional upstream
 * signals. This is the ONLY place the camelCase tierSteps output (verifyPhase,
 * skillGen) is mapped to snake_case StorySignals.steps fields (ADR-5).
 */
export function buildStorySignals(
  heuristics: HeuristicSignals,
  opts?: { triage?: TriageSignal; selfAssessment?: SelfAssessment }
): StorySignals {
  const tier = resolveCostTier({
    triage: opts?.triage,
    selfAssessment: opts?.selfAssessment,
    heuristics,
  });
  const rawSteps = tierSteps(tier);

  return {
    triage: opts?.triage,
    self_assessment: opts?.selfAssessment,
    heuristics,
    tier,
    steps: {
      reviewers: rawSteps.reviewers,
      verify_phase: rawSteps.verifyPhase,
      skill_gen: rawSteps.skillGen,
    },
  };
}
