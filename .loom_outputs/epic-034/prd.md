# Gate-Eval Framework + Brief-Quality Scorer Eval — PRD

## Overview

Loom runs a growing set of small, single-purpose **gates** through its non-agentic completion path — the brief-quality scorer, the skill judge, the lesson extractor, and the intake classifier. These gates make quality decisions that shape real planning and execution, yet only the intake classifier is measured by an offline eval. Every other gate's quality is a hope, not a number, so prompt/model/threshold regressions go uncaught. This work extracts the reusable structure of the intake eval into a **gate-agnostic eval framework**, refactors the intake eval onto it with no behavior change, and builds the **brief-quality scorer (BriefRefiner) eval** as the framework's first new consumer. The eval is offline, observe-only, and operator-run: it measures, it does not gate.

## Goals

1. **Make non-agentic gates measurable through one reusable harness.** Success: the framework supports ≥2 live consumers (intake + brief-quality) with shared eval logic living in exactly one place — no duplicated case-loader/runner/judge/scorer/decision code.
2. **Give the brief-quality scorer its first accuracy signal.** Success: a fail-closed decision reports readiness accuracy, quality-score agreement-within-band, and critique quality over a balanced labeled case set.
3. **Guarantee zero production impact.** Success: BriefRefiner production behavior is verifiably unchanged and the eval is wired into neither the planning path nor the integration gate.
4. **Keep the harness deterministic and cheap to test.** Success: the full test suite passes with mocked LLM calls only; no worker makes a real model call and the full eval is not run as a worker story.

## User Stories

- **As a loom maintainer**, I want a regression signal when I change a gate's prompt, model, or threshold, so that I can catch a quality drop before it ships. *(Must)*
- **As the release operator**, I want to run the brief-quality eval after merge and record the result, so that the scorer's accuracy is a tracked number, not an assumption. *(Must)*
- **As a future gate-eval author**, I want gate-agnostic plug points, so that I can add an eval for the skill judge or lesson extractor without rewriting the core. *(Should)*
- **As a loom end user running planning**, I want the production planning path completely untouched, so that this developer harness never changes a single planning decision I depend on. *(Must — anti-persona; the value is *no* change)*

## Functional Requirements

- **FR-1** — The framework core exposes five plug points: a case-set loader, a per-case gate runner, an LLM-as-judge step, a scorer that aggregates per-case results into accuracy and failure-rate metrics, and a fail-closed thresholded decision.
- **FR-2** — The case schema, the gate invocation, and the judge prompt are supplied by each consumer; the core contains none of them baked in.
- **FR-3** — The decision step supports configurable thresholds: minimum scored cases, maximum gate-failure rate, and maximum judge-inconclusive rate.
- **FR-4** — Both the gate-under-eval model and the judge model are env-var selectable, each with a safe default.
- **FR-5** — The intake classifier eval is refactored onto the framework with the same inputs, outputs, and thresholds; its existing tests stay green and it re-runs cleanly with unchanged behavior.
- **FR-6** — A labeled brief-quality case set exists spanning clearly plan-ready, clearly not-ready/vague, and borderline briefs; each case carries expected readiness, an expected quality *band* (not an exact score), and the key critique themes a good reviewer should surface.
- **FR-7** — A brief-quality LLM-as-judge independently assesses whether a brief is plan-ready, then grades the scorer on three axes: readiness correctness, quality score within a defensible band, and critique fidelity (surfaces the real issues without inventing fake ones).
- **FR-8** — A brief-quality runner + scorer evaluates BriefRefiner over the case set and reports readiness accuracy, quality-score agreement-within-band, and critique quality, ending in a fail-closed decision on whether the scorer clears its bar.
- **FR-9** — Deterministic mocked-LLM unit tests cover the framework, the scorer, the judge wiring, and the case-set loader.
- **FR-10** — Docs describe the gate-eval framework and how to run the brief-quality eval; the capabilities drift check passes for any user-visible surface introduced.
- **FR-11** — `[ASSUMPTION]` Quality-band boundaries and the agreement-within-band tolerance are defined as part of case-set design and documented for review before the operator run.

## Non-Functional Requirements

- **NFR-1 (Observe-only)** — The eval must not touch the production planning path, must not alter any planning decision, and must not be wired into the integration gate.
- **NFR-2 (No real model calls in tests)** — All tests use mocked LLM calls; the full brief-quality eval runs out-of-band by the operator, never as a worker story.
- **NFR-3 (Documented cost expectation)** — Because an Opus judge runs once per case, the docs state the operator's expected cost and runtime for a full eval run.
- **NFR-4 (No duplication)** — Shared eval logic lives in the framework, not in two places; the intake refactor removes, not copies, the welded logic.

## Epics

This PRD breaks into **one epic**: *Gate-Eval Framework + Brief-Quality Scorer Eval*. The framework, the intake refactor, and the brief-quality consumer are sequential phases of a single cohesive deliverable (a reusable harness proven by its first new consumer), not independently shippable units.

## Out of Scope

- **Running the full brief-quality eval** as part of this work — the operator runs it after merge and records the result.
- **Evals for the skill judge, lesson extractor, or any other gate** beyond the intake refactor and the new brief-quality consumer.
- **Any gating of real planning** — the brief-quality eval is not wired into the integration gate or the production planning path.
- **Any change to BriefRefiner's production behavior**, including the `min-brief-quality-score` policy knob.
- `[ASSUMPTION]` Adding a dedicated end-user-facing CLI command beyond what the operator needs to run the eval; the capabilities-page trigger is resolved during implementation per FR-10.
