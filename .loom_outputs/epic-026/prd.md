# Intake Classifier Reliability — Bounded Retry, Eval-Set Cleanup, and Honest Go/No-Go

## Overview

The intake classifier's core architectural bug is fixed and shipped: it runs in non-agentic completion mode and classifies real task briefs reliably. But the eval that gates progression to phase one cannot yet render an honest verdict, because the residual failure rate is inflated by two non-representative sources — cheap-model JSON-adherence jitter and a handful of unrepresentative "fragment" briefs (a title plus a comma-separated component list) in the eval set. This is a focused reliability phase that removes both distortions so the existing eval can produce a trustworthy go/no-go, without touching the classifier's verdict logic, its observe-only stance, or any guardrail. It delivers a bounded internal retry on unparseable output, a targeted rewrite of only the fragment briefs (labels preserved), and an operator-run eval that records the honest per-axis decision after merge.

## Goals

1. **Honest gate decision.** Drop the classifier's residual failure rate to a low level so the eval renders a real quality decision across the full case set — measured by the recorded gate verdict explicitly stating whether the bar to proceed to phase one is cleared.
2. **Eliminate JSON-adherence variance, not logic.** A bounded internal retry recovers transient unparseable output without changing verdict logic — measured by a test proving invalid-then-valid yields a verdict and exhausted retries yield a failure.
3. **Clean fixtures without score-chasing.** Only genuinely unrepresentative fragment briefs are rewritten, with original labels preserved and each rewrite documented — measured by zero label changes and a rationale recorded per rewrite.

## User Stories

- **As the operator/maintainer**, I want the eval's failure rate to reflect real classifier performance, not model jitter or bad fixtures, so that I can trust the go/no-go for phase one. (Must)
- **As a caller of the classifier** (the intake path), I want to keep making exactly one logical `classify` call per intake and receive a verdict or a faithful failure, so that retry behavior stays transparent to me. (Must)
- **As the operator**, I want to re-run the cleaned eval after merge and have its per-axis results recorded, so that the decision is documented honestly either way. (Must)

## Functional Requirements

- **FR-1.** When the model returns output that cannot be parsed into a verdict, the classifier retries a small bounded number of additional attempts (1–2) before returning a failure.
- **FR-2.** Retry is scoped to parse failures only: timeouts and genuine errors are returned unchanged, exactly as before.
- **FR-3.** Retry is internal — the caller makes exactly one logical `classify` call per intake regardless of how many internal attempts occur.
- **FR-4.** A test proves that an invalid first response followed by a valid second response yields a successful verdict, and that exhausting the bounded retries returns a failure.
- **FR-5.** The eval briefs phrased as a title plus comma-separated component list (rather than as a task a person would submit) are identified.
- **FR-6.** Each identified fragment is rewritten into a well-formed task brief that preserves the original intent and the **original human type and size labels**; labels are never changed and only the brief text is altered.
- **FR-7.** Well-formed briefs are left untouched — only genuinely unrepresentative fragments are rewritten.
- **FR-8.** Each rewrite is documented with its rationale, in the spirit of the prior relabeling note.
- **FR-9.** The intake eval is prepared to run against the cleaned labeled set but is **not** run inside a worker story; the operator runs it after merge and records per-axis accuracy, the confusion matrix, failure-reason counts, and the gate's honest decision (including whether epic-to-story under-sizing confusions stay at or below two).

## Non-Functional Requirements

- **NFR-1.** The retry bound guarantees cost cannot run away — the number of internal attempts is capped.
- **NFR-2.** The observe-only invariant is preserved: the verdict never influences planning or execution.
- **NFR-3.** No guardrail is weakened, and the non-agentic completion mode and its regression test stay intact and green.
- **NFR-4.** The eval remains an offline developer harness; it is not wired into the worker execution path.

## Epics

This PRD breaks into a single epic: **Intake Classifier Reliability** — bounded retry, eval-set cleanup, and operator-run honest go/no-go. The eval execution itself is an operator action performed after merge, not a worker story within the epic.

## Out of Scope

- Changing the classifier's verdict logic, scoring axes, or observe-only stance.
- Running the long eval as a worker story (exceeds the worker time budget; the operator runs it post-merge).
- Pre-tuning the retry bound beyond 1–2 attempts; raising it to two is confirmed by the eval run, not pre-decided.
- Rewriting, tuning, or relabeling well-formed briefs, or any change to eval-set labels.
- Weakening or modifying any guardrail or the non-agentic completion mode.
