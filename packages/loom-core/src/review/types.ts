/** A single reviewable issue surfaced by the CodeReviewAgent. */
export interface ReviewFinding {
  severity: 'blocker' | 'should-fix' | 'nit';
  file: string;
  /** 1-indexed line in the new file, when the agent can pin it. */
  line?: number;
  /** A short, concrete statement of the issue. */
  issue: string;
  /** Optional follow-up suggestion. */
  suggestion?: string;
}

/** Structured output from the CodeReviewAgent. */
export interface ReviewReport {
  findings: ReviewFinding[];
  /** Free-form summary of the review outcome. */
  summary: string;
}

/** Per-story context the agents use to write better output. */
export interface ReviewStoryContext {
  storyId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}
