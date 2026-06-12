import type { Finding } from '../findings/schema.js';
import { dedupeFindings, dedupeKey, normalize } from './dedupe.js';
import type { ReviewerInput, ReviewerRunner } from './reviewer.js';

export { dedupeKey, normalize };
export type { ReviewerInput, ReviewerRunner };

/** A sink for the audit_log rows the review pass must write (CLAUDE.md #5). */
export interface AuditSink {
  record(action: string, detail: Record<string, unknown>): void;
}

/** Per-reviewer outcome for one pass. */
export type ReviewerStatus = 'ok' | 'repaired' | 'warn_and_continue';

/** The result of a single review pass — the contract shape every caller reads. */
export interface ReviewPassResult {
  /** Post-dedupe, severity-merged findings unioned across all reviewers. */
  findings: Finding[];
  /** True iff any post-dedupe finding is `blocker` or `high`. */
  triggers_revision: boolean;
  per_reviewer_status: Array<{ source: string; status: ReviewerStatus }>;
}

/** Runtime dependencies a pass needs beyond its identity. */
export interface ReviewPassDeps {
  /** The reviewers to fan out to — code-review adapter + ported reviewers. */
  reviewers: ReviewerRunner[];
  /** Optional audit sink; when present, the three review actions are recorded. */
  audit?: AuditSink;
  /** Optional warn logger for the warn-and-continue path. */
  warn?: (message: string, detail?: Record<string, unknown>) => void;
}

/** Identity of a pass — the frozen contract fields. */
export interface ReviewPassContext {
  story_id: string;
  epic_id: string;
  revision_index: number;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isBlockerOrHigh(f: Finding): boolean {
  return f.severity === 'blocker' || f.severity === 'high';
}

/**
 * Run one reviewer with the FR-6 / ADR-002 failure policy: try once; on any
 * throw (a zod-validation failure on malformed output, or a self-failure) do
 * exactly one repair re-prompt; if that also throws, log
 * `review.reviewer.warn_and_continue` and skip the reviewer (empty findings)
 * so the pass continues on the survivors.
 */
async function runReviewer(
  reviewer: ReviewerRunner,
  input: ReviewerInput,
  ctx: ReviewPassContext,
  deps: Pick<ReviewPassDeps, 'audit' | 'warn'>,
): Promise<{ source: string; status: ReviewerStatus; findings: Finding[] }> {
  try {
    const out = await reviewer.run(input);
    return { source: reviewer.source, status: 'ok', findings: out.findings };
  } catch (firstError) {
    try {
      // Exactly one repair re-prompt.
      const out = await reviewer.run(input);
      return { source: reviewer.source, status: 'repaired', findings: out.findings };
    } catch (repairError) {
      deps.audit?.record('review.reviewer.warn_and_continue', {
        source: reviewer.source,
        story_id: ctx.story_id,
        epic_id: ctx.epic_id,
        revision_index: ctx.revision_index,
        first_error: errMessage(firstError),
        repair_error: errMessage(repairError),
      });
      deps.warn?.(
        `reviewer ${reviewer.source} failed after one repair attempt; continuing without it`,
        { source: reviewer.source, story_id: ctx.story_id },
      );
      return { source: reviewer.source, status: 'warn_and_continue', findings: [] };
    }
  }
}

/**
 * Run a single review pass: invoke every reviewer in parallel (ADR-002), union
 * their findings, dedupe by (file, line, normalized-description), and decide
 * whether another worker revision is warranted (any `blocker`/`high` survives).
 *
 * Writes `review.findings.deduped` always, and `review.revision.triggered` when
 * the pass warrants a revision. Per-reviewer schema failures never abort the
 * pass — see {@link runReviewer}.
 */
export async function runReviewPass(
  input: ReviewerInput,
  ctx: ReviewPassContext & ReviewPassDeps,
): Promise<ReviewPassResult> {
  const { reviewers, audit, warn, ...identity } = ctx;
  const passCtx: ReviewPassContext = identity;

  const results = await Promise.all(
    reviewers.map((reviewer) => runReviewer(reviewer, input, passCtx, { audit, warn })),
  );

  const union = results.flatMap((r) => r.findings);
  const findings = dedupeFindings(union);
  const triggers = findings.some(isBlockerOrHigh);

  audit?.record('review.findings.deduped', {
    story_id: passCtx.story_id,
    epic_id: passCtx.epic_id,
    revision_index: passCtx.revision_index,
    union_count: union.length,
    deduped_count: findings.length,
  });

  if (triggers) {
    audit?.record('review.revision.triggered', {
      story_id: passCtx.story_id,
      epic_id: passCtx.epic_id,
      revision_index: passCtx.revision_index,
      blocker_high_count: findings.filter(isBlockerOrHigh).length,
    });
  }

  return {
    findings,
    triggers_revision: triggers,
    per_reviewer_status: results.map((r) => ({ source: r.source, status: r.status })),
  };
}

/** Hooks the revision loop drives — one source of truth for the cap behavior. */
export interface ReviewLoopHooks {
  /** Existing `maxReviewRevisions` cap — no new ceiling is introduced. */
  maxRevisions: number;
  /** Only `block-and-revise` actually re-prompts; `comment` reviews once. */
  blockAndRevise: boolean;
  /** Run pass N (0 = initial). Reads the fresh diff each time. */
  runPass: (revisionIndex: number) => Promise<ReviewPassResult>;
  /** Re-prompt the worker with the pass; return false to abort (spawn error). */
  revise: (pass: ReviewPassResult, revisionIndex: number) => Promise<boolean>;
}

/** The outcome of the bounded revision loop. */
export interface ReviewLoopResult {
  finalPass: ReviewPassResult;
  revisions: number;
}

/**
 * Drive the review/revise loop: review, then while the pass warrants a revision
 * and the `maxRevisions` cap is not reached, re-prompt the worker and re-review.
 * The cap is the sole termination ceiling — a reviewer that never stops finding
 * blockers can only ever cause `maxRevisions` re-prompts.
 */
export async function runReviewLoop(hooks: ReviewLoopHooks): Promise<ReviewLoopResult> {
  let pass = await hooks.runPass(0);
  let revisions = 0;
  while (
    hooks.blockAndRevise &&
    revisions < hooks.maxRevisions &&
    pass.triggers_revision
  ) {
    revisions += 1;
    const proceeded = await hooks.revise(pass, revisions);
    if (!proceeded) break;
    pass = await hooks.runPass(revisions);
  }
  return { finalPass: pass, revisions };
}
