# Intake Classifier Reliability — Bounded Retry, Eval-Set Cleanup, and Honest Go/No-Go

## The Problem

The intake classifier's core architectural bug is fixed and shipped: it now uses a non-agentic completion mode and classifies real task briefs reliably (direct tests on realistic briefs show zero failures). But the eval that decides whether to proceed to phase one cannot yet render an honest verdict, because the residual failure rate is inflated by two non-representative sources rather than by genuine classifier weakness:

1. **Cheap-model JSON-adherence variance.** Even in non-agentic mode, the cheap model occasionally returns prose instead of parseable JSON. This is variance, not a logic fault, and a single retry would largely eliminate it.
2. **Unrepresentative fragment briefs in the eval set.** A handful of eval briefs are phrased as a title plus a comma-separated component list (e.g. *"Core Engine: loom init, policy engine, SQLite state"* and *"MCP Server: loom-mcp with seven tools"*) rather than as a task a person would actually submit. These terse fragments push the model into prose answers and **dominate the residual failure count**.

Until both are addressed, the gate reports a failure rate that reflects model jitter and bad test fixtures — not the classifier's real performance on real intake — so no one can trust the go/no-go.

## Target Users

- **Primary — the operator/maintainer** deciding whether the classifier is reliable enough to proceed to phase one. They need a clean, honest quality decision from the eval, not a number muddied by variance and bad fixtures.
- **Secondary — callers of the classifier** (the intake path), who must continue to make exactly one logical `classify` call per intake and receive a verdict or a faithful failure.
- **Anti-persona — the score-chaser.** This work must not tune briefs to inflate the score. We rewrite only genuinely unrepresentative fragments; well-formed briefs are left untouched, and labels never change.

## Proposed Solution

A focused reliability phase in three parts that lets the existing eval render a trustworthy decision — without touching the classifier's verdict logic, its observe-only stance, or any guardrail:

1. **Bounded internal retry** on unparseable output, transparent to callers.
2. **Targeted eval-set cleanup** — rewrite only the fragment briefs into representative task briefs, preserving their labels.
3. **A separate, operator-run eval** that records the honest per-axis decision.

## Key Capabilities

1. **Bounded retry on unparseable output.** When the model returns output that cannot be parsed into a verdict, the classifier retries a small bounded number of additional attempts (e.g. 1–2) before returning a failure. Retry is **internal** — the caller still makes one logical classify call per intake.
2. **Retry scoped to parse failures only.** Timeouts and genuine errors are returned as before; only unparseable output triggers a retry. The bound guarantees cost cannot run away.
3. **Retry test coverage.** A test proving that an invalid first response followed by a valid second response yields a successful verdict, and that exhausting the bounded retries returns a failure.
4. **Fragment-brief identification.** Identify the eval briefs phrased as a title plus comma-separated component list rather than as a task.
5. **Faithful rewrite, labels preserved.** Rewrite each fragment into a well-formed task brief that preserves the original intent and the **original human type and size labels** (labels are never changed — only the brief text).
6. **Documented rewrites.** Each rewrite is documented with its rationale, in the spirit of the prior relabeling note.
7. **Operator-run eval and recorded decision.** Re-run the intake eval against the cleaned labeled set and record per-axis accuracy, the confusion matrix, failure-reason counts, and the gate's honest decision.

## Constraints

- **Observe-only invariant preserved** — the verdict must never influence planning or execution.
- **No guardrail weakened.**
- **One logical classify call per intake** — the retry is internal and only on unparseable output.
- **Eval-set labels are immutable** — only unrepresentative brief *text* may be rewritten; well-formed briefs stay untouched.
- **Non-agentic completion mode and its regression test stay intact.**
- **The eval remains an offline developer harness.**
- **The epic must not run the long eval as a worker story** — running the full eval inside a worker exceeds the worker time budget. The epic prepares everything; the **operator runs the eval after merge**.

## Risks and Open Questions

- **Retry bound vs. residual variance.** A 1–2 attempt bound should largely eliminate JSON-adherence misses, but cannot guarantee zero. `[ASSUMPTION]` One additional attempt is sufficient to clear the bar; if not, the bound may need to rise to two — to be confirmed by the eval run, not pre-tuned.
- **Which briefs qualify as fragments.** The two named examples are clear; the full set is described as "a handful." `[ASSUMPTION]` The fragment set is small and unambiguously identifiable by the title-plus-comma-list shape; borderline well-formed briefs are left untouched to avoid score-chasing.
- **Rewrite fidelity.** Rewrites must preserve intent *and* the original type/size labels. Risk: a rewrite drifts enough that the preserved label no longer fits — mitigated by documenting each rewrite's rationale for review.
- **Will the cleaned eval clear the bar?** `[ASSUMPTION]` With reliable output, the classifier clears the bar to proceed to phase one — but this is the decision the eval exists to make, and it is recorded honestly either way.
- **Epic-to-story under-sizing confusions.** Open question to be answered by the run: do these stay **at or below two**?
- **Operator dependency.** The honest decision depends on a manual, post-merge eval run. `[ASSUMPTION]` The operator runs it promptly; until then the gate decision is pending, not passing.

## Success Criteria

- The classifier retries a bounded number of times on unparseable output and returns a verdict when a retry succeeds — **proven by a test** — and still returns a failure when retries are exhausted.
- Timeouts and genuine errors are returned unchanged; only unparseable output triggers a retry.
- The retry is internal: callers make exactly one logical classify call per intake.
- The artificial fragment briefs are rewritten into representative task briefs with their **original labels preserved**, and **each rewrite is documented** with rationale.
- Well-formed briefs are left untouched; no label is changed.
- Non-agentic completion mode and the observe-only invariant remain intact, with their tests green.
- The **full build and test suite pass.**
- The epic does **not** run the long eval as a worker story.
- After the operator runs the eval, the recorded results include per-axis accuracy, the confusion matrix, failure-reason counts, and the gate's honest decision — with the classifier failure rate dropped to a low level so the gate renders a real quality decision across the full case set, and an explicit record of whether the bar to proceed to phase one is cleared, including whether epic-to-story under-sizing confusions stay **at or below two**.
