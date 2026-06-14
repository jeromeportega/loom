import type { CostTier, HeuristicSignals, SelfAssessment, TriageSignal } from '../types.js';

export interface TierInputs {
  triage?: TriageSignal;
  selfAssessment?: SelfAssessment;
  heuristics?: HeuristicSignals;
}

// Diff-size thresholds for the light/heavy edges. Engine constants, not policy
// knobs — the policy surface stays small; tune here if real runs justify it.
const SMALL_DIFF_LINES = 80;
const SMALL_DIFF_FILES = 3;
const LARGE_DIFF_LINES = 400;
const LARGE_DIFF_FILES = 15;

/**
 * Deterministic per-story cost tier from the three signals. No LLM in the
 * decision — given the same signals it always returns the same tier, so the
 * ledger fully explains every call. Encodes the confirmed decisions:
 *
 *  - a touched risky path forces `heavy` (hard safety floor);
 *  - heuristics win on conflict: a first-try test failure or a large diff
 *    forces `heavy` even if the worker self-reported high confidence;
 *  - missing self-assessment → confidence `low` → tends `heavy` (fail safe);
 *  - `light` requires every positive signal to line up.
 *
 * The tier→steps mapping ({@link tierSteps}) still keeps ≥1 reviewer on `light`;
 * the ceiling rule (never exceed the static policy flags) is applied by the
 * consumers, not here.
 */
export function resolveCostTier(inputs: TierInputs): CostTier {
  const { triage, selfAssessment, heuristics } = inputs;

  if (heuristics && heuristics.risky_paths_touched.length > 0) return 'heavy';
  if (heuristics && heuristics.tests_green_first_try === false) return 'heavy';
  if (heuristics && (heuristics.diff_lines > LARGE_DIFF_LINES || heuristics.diff_files > LARGE_DIFF_FILES)) {
    return 'heavy';
  }

  const confidence = selfAssessment?.confidence ?? 'low';
  if (confidence === 'low') return 'heavy';
  if (triage?.risk === 'high') return 'heavy';

  const triageLow = triage?.risk === 'low';
  const smallDiff =
    !!heuristics &&
    heuristics.diff_lines <= SMALL_DIFF_LINES &&
    heuristics.diff_files <= SMALL_DIFF_FILES;
  const testsGreen = heuristics?.tests_green_first_try === true;
  if (confidence === 'high' && triageLow && smallDiff && testsGreen) return 'light';

  return 'standard';
}

export interface TierSteps {
  /** Number of reviewers to fan out in the review pass (always ≥1). */
  reviewers: number;
  /** Whether to run the separate verify-phase spawn (when phases:on). */
  verifyPhase: boolean;
  /** Whether to run post-story skill generation (when skill_generation enabled). */
  skillGen: boolean;
}

/**
 * The expensive steps each tier requests. These are a CEILING REQUEST: the
 * consumer clamps them against the static policy flags (e.g. `phases:off` means
 * no verify spawn regardless; `review_strategy:comment` means no revise loop).
 * `light` still keeps one reviewer — no tier ever opens a PR with zero review.
 */
export function tierSteps(tier: CostTier): TierSteps {
  switch (tier) {
    case 'light':
      return { reviewers: 1, verifyPhase: false, skillGen: false };
    case 'standard':
      return { reviewers: 2, verifyPhase: true, skillGen: true };
    case 'heavy':
      return { reviewers: 3, verifyPhase: true, skillGen: true };
  }
}
