import type { BriefRefinement } from './types.js';

/** Discriminant for the three-way brief-quality gate decision. */
export type GateOutcome =
  | 'pass-clean'               // quality_score >= threshold && ready === true
  | 'pass-with-clarifications' // quality_score >= threshold && ready === false
  | 'below-threshold';         // quality_score <  threshold

/**
 * Outcome of the brief-quality gate. `pass` is the decision; the remaining
 * fields echo the inputs so entry points can report the verdict (CLI output,
 * MCP rejection payloads, audit rows) without re-deriving anything.
 */
export interface GateVerdict {
  /** Three-way discriminant — the definitive routing signal for callers. */
  outcome: GateOutcome;
  /** Back-compat: equals (outcome === 'pass-clean'). */
  pass: boolean;
  /** Echoed for reporting. */
  ready: boolean;
  /** Echoed for reporting. */
  quality_score: number;
  /** The min_brief_quality_score that was applied. */
  threshold: number;
}

/**
 * The single brief-quality gate decision used by every entry point
 * (`loom epic`, `loom_start_epic`). Pure: no policy lookup, no I/O.
 *
 * Invariants:
 *   outcome === 'pass-clean'               iff quality_score >= minScore && ready === true
 *   outcome === 'pass-with-clarifications' iff quality_score >= minScore && ready !== true
 *   outcome === 'below-threshold'          iff quality_score <  minScore
 *   pass === (outcome === 'pass-clean')    always
 */
export function evaluateBriefGate(
  refinement: Pick<BriefRefinement, 'ready' | 'quality_score'>,
  minScore: number
): GateVerdict {
  let outcome: GateOutcome;
  if (refinement.quality_score < minScore) {
    outcome = 'below-threshold';
  } else if (refinement.ready === true) {
    outcome = 'pass-clean';
  } else {
    outcome = 'pass-with-clarifications';
  }
  return {
    outcome,
    pass: outcome === 'pass-clean',
    ready: refinement.ready,
    quality_score: refinement.quality_score,
    threshold: minScore,
  };
}
