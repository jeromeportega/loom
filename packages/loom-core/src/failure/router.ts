import type { Investigation } from '../findings/investigation.js';

/**
 * The payload handed to the failure-investigator skill (and therefore to
 * {@link investigateAndRoute}) when a story's test or gate fails: the name of
 * the failing test/gate, the tail of its stderr, the story diff, and the story
 * id. Mirrors the epic-wide shared contract exactly.
 */
export interface FailurePayload {
  failing_test_or_gate: string;
  stderr_tail: string;
  diff: string;
  story_id: string;
}

/**
 * The deterministic decision the router emits for a graded investigation
 * (ADR-004). A tagged union so the call site can `switch` on `kind` and the
 * `retry-with-hint` arm is the only one that carries a `hint` to thread into
 * the next worker attempt.
 */
export type RouteDecision =
  | { kind: 'retry-with-hint'; hint: string }
  | { kind: 'surface-to-operator'; reason: string }
  | { kind: 'stop-epic'; reason: string };

/**
 * Pure, deterministic router: maps an evidence grade onto a dispatch decision.
 * No LLM, no I/O, no async — the same Investigation always yields the same
 * RouteDecision, which is what makes the retry behavior auditable and testable.
 *
 *   - strong        → retry-with-hint (the schema guarantees a non-empty hint)
 *   - weak          → surface-to-operator (the deliberate cost of an LLM-free
 *                     router: a misgraded weak that was really strong won't
 *                     auto-retry — an operator decides)
 *   - contradictory → stop-epic (the evidence undercuts itself; retrying would
 *                     burn the per-story budget chasing a phantom)
 *
 * The router adds NO retry ceiling of its own — it is stateless. Bounding the
 * strong → retry loop is the caller's existing per-story retry ceiling.
 */
export function routeByGrade(inv: Investigation): RouteDecision {
  switch (inv.grade) {
    case 'strong':
      // The Investigation schema's `.refine` guarantees a non-empty `hint`
      // whenever the grade is strong, so this is a type narrowing, not a
      // runtime risk: investigateAndRoute only ever passes schema-validated
      // investigations here.
      return { kind: 'retry-with-hint', hint: inv.hint as string };
    case 'weak':
      return { kind: 'surface-to-operator', reason: inv.hypothesis };
    case 'contradictory':
      return { kind: 'stop-epic', reason: inv.hypothesis };
    default: {
      // Exhaustiveness guard: adding a fourth grade without a route here is a
      // compile error, not a silent fall-through.
      const _exhaustive: never = inv.grade;
      return _exhaustive;
    }
  }
}
