import type { Finding, Severity } from '../findings/schema.js';
import { SOURCE } from '../findings/sources.js';
import type { CodeReviewAgent } from './CodeReviewAgent.js';
import type { ReviewFinding, ReviewReport, ReviewStoryContext } from './types.js';
import type { ReviewerRunner } from './reviewer.js';

/**
 * Maps the existing `CodeReviewAgent` severity vocabulary onto the shared
 * findings severities (ADR-001 trade-off — the agent stays unmodified; this
 * adapter is local to story-003). `should-fix`/`nit` land below the
 * blocker/high revision threshold on purpose, so a non-blocking code-review
 * note does not by itself force another worker revision.
 */
const SEVERITY_MAP: Record<ReviewFinding['severity'], Severity> = {
  blocker: 'blocker',
  'should-fix': 'medium',
  nit: 'low',
};

/**
 * Adapt a `CodeReviewAgent` report into the shared `Finding[]` shape with
 * `source = SOURCE.CODE_REVIEW`. Kept deliberately thin — it only reshapes
 * fields and never mutates the agent.
 */
export function adaptCodeReviewReport(report: ReviewReport): Finding[] {
  return report.findings.map((f) => {
    const finding: Finding = {
      severity: SEVERITY_MAP[f.severity],
      category: 'code-review',
      location: f.line ? { file: f.file, line: f.line } : { file: f.file },
      description: f.issue,
      source: SOURCE.CODE_REVIEW,
    };
    if (f.suggestion) finding.suggested_fix = f.suggestion;
    return finding;
  });
}

/**
 * Wrap a `CodeReviewAgent` as a {@link ReviewerRunner} so it joins the same
 * fan-out as the ported reviewers. It is the orchestrator's backstop: if the
 * ported reviewers self-fail, the code-review findings still drive the pass.
 */
export function codeReviewReviewer(
  agent: CodeReviewAgent,
  story: ReviewStoryContext,
): ReviewerRunner {
  return {
    source: SOURCE.CODE_REVIEW,
    run: async (input) => {
      const { report } = await agent.review({ story, diff: input.diff });
      return { findings: adaptCodeReviewReport(report) };
    },
  };
}
