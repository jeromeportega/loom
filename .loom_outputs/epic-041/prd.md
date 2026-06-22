# Lesson-Extractor Eval — Rubric-Based Gate-Eval Consumer

## Overview

The lesson extractor reads an epic's telemetry (decision traces, agent logs, audit tail) and produces structured lessons that feed loom's post-epic learning loop. It runs on the non-agentic completion path and currently has no eval. Unlike every prior gate-eval consumer (classifier, brief-quality, skill-judge), its output is open-ended — there is no single correct lesson set to label-match against — so its highest-value failure modes (hallucinated lessons, over-extraction, missed lessons, low-value restatements) go undetected. This PRD specifies a new **rubric-based eval consumer**, built on the existing gate-eval framework and driving the production lesson extractor, that scores extracted lessons against *rubric expectations* rather than labeled verdicts. It is offline and operator-run, observe-only, and never executes on the agentic worker path.

## Goals

1. **Make extraction quality measurable.** Produce per-run faithfulness, usefulness, and coverage scores plus a hallucination rate for the production lesson extractor. *Metric: an operator can run the harness over the case set and obtain all four aggregate numbers in one invocation.*
2. **Gate changes fail-closed.** Convert the aggregate metrics into a single pass/fail verdict against per-metric thresholds, defaulting to fail when a metric is below bar. *Metric: a deliberately degraded extractor output produces a `fail` verdict; a known-good output produces `pass`.*
3. **Detect the failure modes that label-matching can't.** Flag hallucinated lessons and over-extraction on representative inputs, including a thin/near-empty epic that should yield few or no lessons. *Metric: the thin-epic case with over-extraction traps drives the hallucination/over-extraction signal when the extractor manufactures lessons.*
4. **Stay observe-only and within convention.** Add the consumer without changing production extractor behavior, weakening any guardrail, or violating the sub-barrel/single-public-entry pattern. *Metric: full build + test suite pass; capabilities drift check passes; top barrel gains at most one re-export line.*

## User Stories

- **Must** — As the **eval operator**, I want to run the harness on demand over a fixed case set, so that I can judge whether the lesson extractor clears the quality bar before relying on its output.
- **Must** — As a **loom maintainer / learning-loop owner**, I want aggregate faithfulness/usefulness/coverage metrics, a hallucination rate, and a fail-closed verdict, so that I can gate changes to the extractor on objective quality signals.
- **Should** — As the **eval operator**, I want to select the gate-under-eval model and the judge model via environment variables with safe defaults, so that I can re-run the eval against different models without code changes.
- **Anti-persona** — the autonomous worker/agent: this eval is explicitly **not** a worker story. No worker runs the full eval, and no worker makes real model calls.

## Functional Requirements

- **FR-1** — Provide a case set of representative epic-telemetry inputs (decision traces, agent logs, audit tails), including at least one **rich multi-story epic** and one **thin/near-empty epic**.
- **FR-2** — Pair each case with **rubric expectations**: expected lesson themes a competent reviewer should surface, plus known **over-extraction traps** (telemetry that should yield few or no lessons). These are themes, not exact expected lessons.
- **FR-3** — Provide a **case loader** that reads the case set and its rubric expectations into the framework's case structure.
- **FR-4** — Provide a **runner** that drives the **production** lesson extractor over the case set (no reimplementation of extraction).
- **FR-5** — Provide a **rubric-based LLM-as-judge** that scores the extracted lessons against the rubric expectations on at least **faithfulness** (grounded in telemetry), **usefulness** (actionable general rule, not vague restatement), and **coverage** (important lessons surfaced without padding), and that flags **hallucinated lessons** and **over-extraction**.
- **FR-6** — Provide a **scorer** that aggregates the judge's per-case scores into faithfulness, usefulness, and coverage metrics plus a **hallucination rate**, and emits a **fail-closed thresholded decision** (pass/fail) on whether the extractor clears the quality bar. Default thresholds are calibrated against the brief-quality / skill-judge reference consumers rather than set arbitrarily. *[ASSUMPTION]*
- **FR-7** — Make model selection **environment-configurable** for both the gate-under-eval model and the judge model, each with a safe default.
- **FR-8** — Provide a **runner script** consistent with existing eval scripts and **updated eval docs** describing how the operator runs the harness.
- **FR-9** — House the consumer in its own `lesson-extractor` directory with its own **sub-barrel** and a **single public entry**, wired via direct imports; add **at most one re-export line** to the top barrel, matching the current brief-quality / skill-judge structure.

## Non-Functional Requirements

- **NFR-1** — **Observe-only:** the production lesson extractor's behavior is unchanged by this work.
- **NFR-2** — **Reuse, don't reimplement:** build entirely on the existing gate-eval framework (case loader, gate runner, LLM-as-judge step, scorer, fail-closed decision) and the production extractor.
- **NFR-3** — **Deterministic mocked-LLM unit tests** for the case loader, rubric judge wiring, and scorer; no worker and no unit test makes a real model call.
- **NFR-4** — **No guardrail weakened;** the capabilities drift check passes if a user-visible surface changes; the full build and test suite pass.

## Epics

- **Epic 1 — Lesson-Extractor Rubric Eval Consumer.** A single cohesive consumer (case set + rubric expectations, case loader, runner over the production extractor, rubric judge, scorer with fail-closed decision, model config, runner script + docs, mocked tests) added to the gate-eval framework. This is one shipping unit.

## Out of Scope

- Changing the lesson extractor's production behavior, prompts, or output schema.
- Running the eval on the agentic worker path or having any worker make real model calls.
- Anonymized real-epic telemetry; hand-authored synthetic fixtures are acceptable for v1. *[ASSUMPTION]*
- Empirically tuning or validating real-model judge stability and final threshold values; v1 ships calibrated defaults, and the operator validates stability on real runs.
- Label-matching / exact-expected-lesson grading (the deliberate departure from prior consumers).
