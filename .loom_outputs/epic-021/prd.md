# Classifier Evaluation Harness — Phase 0.5 Go/No-Go Gate for `loom weave`

## Overview

Phase 0 shipped an observe-only `IntakeClassifier` that labels each brief with `{ type, size, confidence, rationale }`, and `loom weave` records the verdict without acting on it. Recording tells us *what* the classifier decided but never whether it decided *well* — and Phases 1–2 progressively let that verdict influence planning depth and routing. This PRD specifies an **offline evaluation harness** that grades the Phase 0 classifier against two independent signals (a small human-labeled set and a stronger-tier LLM-as-judge), validates the judge itself against the human labels, and emits a report whose load-bearing output is a per-axis confusion matrix and a plain proceed/don't-proceed verdict for Phase 1. The harness only measures the classifier; it never modifies it, and it surfaces no operator-facing command. Design of record: `docs/architecture/intake-classification.md`.

## Goals

| Goal | Success metric |
|------|----------------|
| Produce an evidence-based Phase 1 go/no-go verdict | Report emits a per-axis (type, size) confusion matrix and a plain-language proceed/don't-proceed statement defined in terms of dangerous confusions, not a single headline accuracy number |
| Measure correctness, not planner consistency | Classifier verdict is scored against a human-labeled set and an independent stronger-tier judge — never against the planner's decomposition |
| Establish judge trustworthiness | Report includes judge-vs-human agreement per axis, so the judge signal is never relied on via judge-vs-classifier agreement alone |
| Stay cheap and non-invasive | Exactly one classifier call + one judge call per case; zero changes to classifier behavior, planning/execution paths, or operator CLI surface |

## User Stories

- **As a loom maintainer deciding go/no-go on Phase 1**, I want confusion matrices and a plain proceed/don't-proceed verdict, so that I can authorize (or block) Phase 1 on evidence rather than intuition. *(Must)*
- **As the future Phase 2 author**, I want to read which categories the classifier confuses, so that I can calibrate how conservative the default-to-richer confidence threshold must be from P0 data instead of guessing. *(Should)*
- **As a loom maintainer**, I want missing/unavailable judge results recorded as inconclusive, so that judge non-determinism or outage never silently inflates agreement. *(Must)*
- **As an operator running `loom weave` in production** (anti-persona), I want this harness to remain fully offline, so that no planning or execution path changes and no new operator command appears. *(Must)*

## Functional Requirements

- **FR-1** — The harness reads a **labeled eval set fixture**: cases bootstrapped from loom's 19 delivered epics (`epics/epic-0NN.yaml`) plus a few hand-curated anchor cases pinning the extremes (an obvious single-story change, an obvious bug, an obviously large multi-story epic). Each case stores brief text, a human `type` label, a human `size` label, and a short rationale.
- **FR-2** — For each bootstrapped epic, the harness **locates the actual brief text** (from the epic YAML or a sibling planning artifact) to feed the classifier; the fixture-build step must confirm brief text is recoverable for all included cases.
- **FR-3** — **Size labels are anchored on the human-curated anchors.** Historical story counts are treated as evidence, not absolute truth (the planner over-decomposes), and never used as the size ground truth on their own.
- **FR-4** — The harness passes **every brief through the Phase 0 `IntakeClassifier`** and collects `type`, `size`, `confidence`, and `rationale` — **exactly one classifier call per case**.
- **FR-5** — The harness computes **exact-match accuracy of classifier verdict vs human label, reported separately for `type` and for `size`**.
- **FR-6** — For each brief, the harness makes **one call to a stronger/different-tier LLM judge** (planning-tier, not the cheap triage model) that independently classifies the brief and grades the classifier's verdict + rationale as agree / disagree-with-reason — **exactly one judge call per case**.
- **FR-7** — The harness cross-checks the judge against the human labels and reports **judge-vs-human agreement** per axis.
- **FR-8** — The harness emits a **report artifact** that, per axis (`type`, `size`), shows: overall accuracy; a **confusion matrix** of predicted vs labeled (accommodating `type` values `feature`/`bug`/`chore`, even if `chore` cases are few); judge-vs-classifier agreement; judge-vs-human agreement; the full list of disagreements with rationales; and a **plain-language statement** of whether the classifier clears the bar for Phase 1.
- **FR-9** — A **missing or unavailable judge result is recorded as `inconclusive`** and excluded from agreement counts — never silently counted as agreement (this overrides `SkillJudge`'s default permissive-accept degradation for evaluation purposes).
- **FR-10** — The report **honors small-sample honesty**: per-cell confusion counts are presented as raw counts, and the Phase 1 bar is expressed in terms of the dangerous confusions (e.g. epic→story under-sizing) consistent with the asymmetric-cost rule, not a single accuracy threshold.
- **FR-11** — The harness follows the repository's evaluation convention — the `loom-bench` binary and `scripts/eval.mjs` — and reuses the `SkillJudge` LLM-judge pattern (zod-validated `{score, reason}`, bundled prompt); it adds **no operator CLI command**.
- **FR-12** `[ASSUMPTION]` — Phase 0.5 **registers itself as the named go/no-go gate** in `docs/architecture/intake-classification.md`, which currently folds the measurement into P0's "Measures:" bullet with no explicit Phase 0.5 entry.

## Non-Functional Requirements

- **NFR-1 (Cost)** — Exactly one classifier call and one judge call per case; the labeled set is kept small.
- **NFR-2 (Judge independence)** — The judge runs on a strictly stronger/different model tier than the cheap classifier model, so it does not share the classifier's blind spots.
- **NFR-3 (Observe-only invariant)** — The harness does not modify Phase 0 classifier behavior and does not wire into any planning or execution path; it reads the classifier and never changes what consumes the verdict.
- **NFR-4 (Guardrails)** — No guardrail is weakened.
- **NFR-5 (Build health)** — The full build and entire test suite pass.

## Epics

- **Epic 1 — Classifier Evaluation Harness (Phase 0.5 go/no-go gate).** A single cohesive deliverable: the labeled fixture, the classifier+judge evaluation run, the report artifact, and the doc registration. This is one epic.

## Out of Scope

- Any operator-facing CLI command or MCP tool for the harness.
- Any change to Phase 0 `IntakeClassifier` behavior or output.
- Wiring classifier verdicts into planning depth, routing, or execution (the Phase 1–2 work this gate informs).
- Setting the exact pass thresholds in stone — `[ASSUMPTION]` the precise per-axis and per-cell pass criteria are a planning decision; the harness encodes and reports against them, and recommends stating them explicitly, but defining their final values is not in this deliverable.
- Enforcing a minimum sample size — `[ASSUMPTION]` no minimum-N requirement is specified; the report presents counts honestly rather than blocking on sample size.
- Net-new judge infrastructure parallel to `SkillJudge`.
