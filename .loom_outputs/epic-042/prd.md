# PRD: Rubric-Based Eval for the Opportunity Engine's Signal-Clustering

## Overview

Loom's opportunity engine reads a list of signals and clusters them into opportunities, emitting a JSON array where each cluster carries a title, the grouped signal ids, impact/effort/confidence scores, and a rationale. It runs on the non-agentic completion path and feeds loom's signal-to-opportunity synthesis. Today its clustering quality is unmeasured: the output is open-ended (no single correct clustering), so exact-match evaluation does not apply, and nothing catches the failure modes that matter — forcing unrelated signals into one cluster, inventing opportunities from nothing, or citing signal ids absent from the input. This work adds a new **gate-eval consumer** for the opportunity engine that drives the production engine over a curated case set, judges the produced clusters against a **rubric** via an LLM-as-judge, scores and aggregates the results, and renders a fail-closed thresholded decision. It mirrors the lesson-extractor rubric eval, reuses the existing framework and the production engine, and is strictly observe-only.

## Goals

1. **Make clustering quality measurable.** A fail-closed thresholded decision runs over the curated case set and gates the engine before it is trusted in synthesis. *Success metric:* the consumer produces a pass/fail decision against an operator-tunable quality bar over ≥3 representative cases.
2. **Catch the three named failure modes.** *Success metric:* the judge flags forced/incoherent clusters, invented opportunities, and nonexistent signal ids; the scorer surfaces a forced-clustering / hallucination rate.
3. **Conform to the sub-barrel convention.** *Success metric:* the new consumer lives in its own directory with its own sub-barrel and a single public entry, wired via direct imports, adding **≤1** re-export line to the top barrel — matching the lesson-extractor reference.
4. **Keep CI deterministic and production untouched.** *Success metric:* mocked-LLM unit tests cover the case loader, rubric-judge wiring, and scorer with no real model calls; the opportunity engine's production behavior is unchanged.

## User Stories

- **As the eval operator,** I want to run an offline harness that scores the opportunity engine's clustering against a rubric and returns a fail-closed decision, so that I can decide whether the engine clears the quality bar before trusting it in synthesis. *(Must)*
- **As a gate-eval framework maintainer,** I want this consumer to follow the post-refactor sub-barrel convention (own directory, direct imports, single top-barrel re-export) like the lesson-extractor consumer, so that the framework stays consistent and extensible. *(Must)*
- **As an operator,** I want model selection for both the gate-under-eval and the judge to be environment-configurable with safe defaults, so that I can swap models without code changes. *(Should)*
- **As an operator,** I want a runner script consistent with the existing eval scripts and docs describing how to run it, so that running this eval matches every other eval I already know. *(Should)*

## Functional Requirements

- **FR-1** — Add a new gate-eval consumer in its own `opportunity-engine` directory with its own sub-barrel and a single public entry point, wired to its modules via direct imports, adding at most one re-export line to the top barrel.
- **FR-2** — Provide a rubric case set of signal inputs, each paired with rubric expectations (expected themes + force-clustering traps) rather than an exact clustering. It must include at least: (a) a set with clearly separable themes (→ distinct clusters), (b) a set of largely unrelated noise (→ few or no meaningful clusters, not forced groupings), and (c) a mixed set.
- **FR-3** — A runner drives the **production** opportunity engine across the case set and exercises the engine's JSON-repair retry path.
- **FR-4** — A rubric LLM-as-judge scores produced clusters on at least: **cluster coherence** (groups genuinely related signals), **score reasonableness** (impact/effort/confidence defensible, not arbitrary), and **grounding** (every clustered signal id exists in the input; no opportunity invented). It explicitly flags forced/incoherent clusters, invented opportunities, and nonexistent signal ids.
- **FR-5** — A scorer aggregates the three rubric dimensions into metrics plus a **forced-clustering / hallucination rate**.
- **FR-6** — A fail-closed decision evaluates the aggregated metrics against an operator-tunable quality bar with a documented safe default, consistent with the framework's existing thresholded-decision pattern.
- **FR-7** — Model selection is environment-configurable for both the gate-under-eval model and the judge model, each with a safe default.
- **FR-8** — Deterministic, mocked-LLM unit tests cover the case loader, the rubric-judge wiring, and the scorer, including a fixture (or mocked engine response) that deterministically exercises the JSON-repair retry path — with no real model calls.
- **FR-9** — Provide a runner script consistent with the existing eval scripts, and update the eval docs to describe how to run this eval.
- **FR-10** — If a user-visible surface changes, update `docs/capabilities.md` so the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1 — Observe-only.** The eval must not change the opportunity engine's production behavior in any way.
- **NFR-2 — Reuse, don't reimplement.** Build on the existing gate-eval framework (case loader, runner, judge step, scorer, fail-closed decision, env-configurable model selection) and the production engine; introduce no parallel reimplementations.
- **NFR-3 — Offline, operator-run.** The full eval is never run by a worker and no worker makes real model calls; the harness is for operator execution only.
- **NFR-4 — No guardrail weakened.** No existing policy or guardrail may be relaxed.
- **NFR-5 — Build/test integrity.** The full build and entire test suite must pass.

## Epics

- **Epic 1 — Opportunity-engine rubric gate-eval consumer.** The single, cohesive deliverable described above: a new framework consumer (case set, runner over the production engine, rubric LLM-as-judge, scorer + fail-closed decision, env-configurable models, deterministic tests, runner script, and docs).

## Out of Scope

- Any change to the opportunity engine's production clustering behavior or its agentic counterpart.
- Worker/CI execution of the full eval, or any worker making real model calls.
- Reimplementing gate-eval framework primitives that already exist.
- Live-model evaluation in CI (CI relies on mocked-LLM determinism).
- Setting a permanent, non-tunable quality threshold — the bar ships as an operator-tunable value with a documented safe default. *[ASSUMPTION]*
