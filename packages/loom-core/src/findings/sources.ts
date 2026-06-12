/**
 * Reviewer source identifiers. A reviewer MUST set `finding.source` to one of
 * these exact strings — the orchestrator dedupe and per-reviewer status keying
 * both compare against these literals, so they are part of the frozen contract.
 */
export const SOURCE = {
  ADVERSARIAL: 'adversarial-review',
  EDGE_CASE: 'edge-case-hunter',
  CODE_REVIEW: 'code-review-agent',
} as const;

export type SourceId = (typeof SOURCE)[keyof typeof SOURCE];
