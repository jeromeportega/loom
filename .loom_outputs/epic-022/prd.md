# PRD — Phase 0.5: Wire and Harden the Intake Classifier

## Overview

Phase 0 shipped the `IntakeClassifier` (in `loom-core`) and the `loom weave` command, both green in CI. The first live run against the real session-based (`claude-cli`) backend revealed that the classifier does not work end to end and that the evaluation harness was reporting a false green. Four defects compound: `loom weave` never calls the classifier; every classification exceeds the hardcoded 20s timeout against the backend's ~100s real latency; the cheap model returns prose rather than parseable JSON; and the eval go/no-go gate fails *open*, printing `PROCEED` while all 22 classifier calls failed. This phase hardens the existing Phase 0 machinery — it does not rebuild it — to make a real `loom weave` produce and persist a real verdict, make the gate fail closed and report honest counts, and validate the result with real per-axis numbers. The verdict remains strictly observe-only. Reference: `docs/architecture/intake-classification.md`.

## Goals

1. **Classifier works end to end.** A real `loom weave` run calls the classifier and persists a non-null verdict to the database, audit log, and status surface — proven by an end-to-end test (the test absent in Phase 0).
2. **The eval gate is trustworthy.** The gate fails closed: `PROCEED` is impossible without a minimum number of successfully scored cases, and high failure/inconclusive rates yield `DO NOT PROCEED` or `INCONCLUSIVE`. Success metric: a run where all classifier calls fail produces a non-`PROCEED` decision with failure-reason counts surfaced.
3. **Observe-only is preserved.** Planning and execution outputs are byte-identical regardless of the verdict. Success metric: a diff test shows identical planning/execution output with the verdict present vs. absent.
4. **Validated honest result recorded.** A re-run against the labeled set produces parseable verdicts and records real per-axis accuracy plus the gate's honest decision (which may legitimately be `DO NOT PROCEED`).

## User Stories

- **As a loom maintainer running the intake pipeline,** I want `loom weave` to actually call the classifier and persist a verdict so that a real invocation records a real signal. *(Must)*
- **As a loom maintainer,** I want the eval gate to fail closed and report honest counts so that I can trust its go/no-go decision instead of being misled by a false green. *(Must)*
- **As a loom operator,** I want to inspect verdicts via the database, audit log, and status surface so that I have observability into intake — never to drive a decision. *(Should)*

## Functional Requirements

- **FR-1** — `loom weave` calls the classifier before invoking the epic planner.
- **FR-2** — The resulting verdict is persisted against the epic that `weave` creates, in all three sinks: database column, audit log, and status surface.
- **FR-3** — Classification is best-effort: a classifier failure (timeout, parse failure, or other error) must not block or abort `weave`; the epic is still planned and created.
- **FR-4** — The fixed 20s timeout is replaced with a bound that accommodates the ~100s real session-backend latency. `[ASSUMPTION]` A generous fixed default (comfortably above ~100s) satisfies this phase, with configurability as the escape hatch.
- **FR-5** — The timeout is configurable, and a single cheap classification is never capped below the backend's real latency.
- **FR-6** — Verdict extraction recovers the JSON object from responses wrapped in surrounding prose or markdown fences. Hardening includes a more forceful instruction and, where it helps, an assistant prefill that opens the JSON object.
- **FR-7** — The eval gate requires a minimum number of successfully scored cases before `PROCEED` is possible.
- **FR-8** — The eval gate reports `DO NOT PROCEED` or `INCONCLUSIVE` when the classifier-failure rate or the judge-inconclusive rate exceeds a low threshold. `[ASSUMPTION]` The minimum-scored-cases count and the rate thresholds are set low/strict enough that a high-failure run is glaringly non-`PROCEED`; exact values are fixed during implementation and recorded in the report.
- **FR-9** — The eval report surfaces failure-reason counts (timeout, invalid output, other errors) rather than silently dropping failed cases.
- **FR-10** — A re-run against the labeled set produces parseable verdicts and records per-axis accuracy and the gate's honest decision.

## Non-Functional Requirements

- **NFR-1 (observe-only invariant — sacred)** — The verdict must never influence planning, the quality gate, persona selection, or execution. Planning and execution must remain byte-identical regardless of the verdict. This phase must not introduce any consumer that reads the verdict to make a decision.
- **NFR-2 (no guardrail weakening)** — Hardening only; no policy relaxation.
- **NFR-3 (fixed model budget)** — One cheap model call per classification; one stronger model call per case for the judge.
- **NFR-4 (eval stays offline)** — The eval remains a developer harness, not wired into planning or execution.
- **NFR-5 (reuse, don't rebuild)** — Harden the existing classifier, eval, and judge machinery; do not re-implement it.

## Epics

This PRD is a single cohesive hardening effort across one existing subsystem and breaks into **one epic**:

- **Epic 1 — Wire and harden the intake classifier.** Wire the classifier into `loom weave` with best-effort persistence, fit and expose the timeout, harden JSON extraction, make the eval gate fail closed with honest reporting, and validate via a recorded re-run.

## Out of Scope

- Any consumer of the verdict that drives a decision (planner, quality gate, persona selection, execution) — explicitly forbidden by NFR-1.
- Improving classifier accuracy or achieving a `PROCEED` decision — an honest `DO NOT PROCEED` is an acceptable outcome for this phase.
- Wiring the eval into planning or execution; it stays an offline developer harness.
- New policy or guardrail changes beyond hardening.
- Rebuilding the Phase 0 classifier, eval, or judge from scratch.
