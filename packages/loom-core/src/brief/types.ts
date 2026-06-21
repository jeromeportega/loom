/**
 * Structured output from BriefRefiner.refine(). One LLM call against the
 * loom-brief-builder skill, returning everything the chat client needs to
 * walk the user through a refinement loop without making more model calls
 * than necessary.
 *
 * The shape is delta-flavored deliberately: the client can render either
 * "just show me the refined brief" or "show me what changed and let me
 * learn the discipline" from the same response.
 */
export interface BriefRefinement {
  /**
   * True when the refiner judged the brief is concrete and complete enough
   * to hand off to loom_plan_epic. False when there are open questions
   * the user should answer first.
   */
  ready: boolean;
  /** The user's original brief, returned verbatim for client convenience. */
  original: string;
  /**
   * The refined brief in markdown — present when `ready` is true OR when the
   * refiner can produce a best-effort draft with assumptions tagged. Absent
   * when the input was so underspecified that any draft would be invention.
   */
  refined_brief?: string;
  /**
   * Per-category critique of the original brief. Empty arrays mean
   * "nothing in this category" — they're not omitted so clients can render
   * sections consistently.
   */
  critique: {
    /** Parts of the original that were clear and shouldn't change. */
    strong_points: string[];
    /** Ambiguous phrasings that need clarification. */
    ambiguities: string[];
    /** Scope that's missing entirely (error handling, edge cases, etc.). */
    missing_scope: string[];
    /** Claims that are not directly observable / testable. */
    untestable_claims: string[];
    /** Things that look simple in the brief but conceal real work. */
    hidden_complexity: string[];
  };
  /**
   * Clarifying questions the chat client should ask the user — empty when
   * `ready` is true. Ordered by importance (highest-leverage first).
   */
  questions: string[];
  /**
   * MODEL-EMITTED holistic 0-10 quality score, parsed from the same JSON
   * response as `blocking_gaps`. It is the refiner's judgment of how ready the
   * brief is for autonomous planning as a whole — NOT a count of critique
   * items, and never derived from critique-array lengths. normalize()
   * clamps it to [0,10]; a missing or non-numeric value maps to 0
   * (fail closed).
   */
  quality_score: number;
  /**
   * Gaps so severe that a planner would have to invent requirements to proceed.
   * Parsed from the model's `blocking_gaps` output via asStringArray — absent
   * or malformed input defaults to []. Semantically distinct from
   * critique.ambiguities, critique.missing_scope, and questions: those capture
   * minor/optional gaps; this captures only planning-blocking ones.
   * `ready` is derived in code as (quality_score >= READY_BAND_MIN) AND
   * (blocking_gaps.length === 0).
   */
  blocking_gaps: string[];
  /**
   * What changed between original and refined. Lets the client render a
   * "here's what we tightened, do you agree?" view rather than just
   * replacing the user's words silently.
   */
  delta: {
    /** Section headings loom added that the user didn't include. */
    added_sections: string[];
    /** Ambiguous → resolved phrasings. */
    clarifications: Array<{ from: string; to: string }>;
    /** Things loom had to assume; should be reviewed by the user. */
    flagged_assumptions: string[];
  };
}
