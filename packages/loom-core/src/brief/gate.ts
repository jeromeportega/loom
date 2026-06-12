import type { BriefRefinement } from './types.js';

/**
 * Outcome of the brief-quality gate. `pass` is the decision; the remaining
 * fields echo the inputs so entry points can report the verdict (CLI output,
 * MCP rejection payloads, audit rows) without re-deriving anything.
 */
export interface GateVerdict {
  /** ready === true && quality_score >= threshold */
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
 * Invariant: pass === (refinement.ready === true && refinement.quality_score >= minScore).
 * `ready` is always consulted — at minScore = 0 a ready: false brief still
 * fails, so the model's judgment can never be bypassed by lowering the
 * threshold alone.
 */
export function evaluateBriefGate(
  refinement: Pick<BriefRefinement, 'ready' | 'quality_score'>,
  minScore: number
): GateVerdict {
  return {
    pass: refinement.ready === true && refinement.quality_score >= minScore,
    ready: refinement.ready,
    quality_score: refinement.quality_score,
    threshold: minScore,
  };
}
