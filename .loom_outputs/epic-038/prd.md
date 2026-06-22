# SkillJudge Eval — Measuring the Skill-Candidate Judge Before We Trust It to Gate

## Overview

The `SkillJudge` gates admission to loom's skill library: given a candidate `SKILL.md` and its context, it returns a 0–10 quality score and an accept/reject verdict, and that verdict now controls library admission via the `judge-minimum-score` policy knob on the non-agentic completion path. Critically, the judge **fails open** — on error it defaults to accept. Every other consumer of the gate-eval framework (the intake classifier eval, the brief-quality eval) has a labeled case set and a scorer proving it behaves; the skill judge has neither. This PRD specifies a fourth consumer of the **existing** gate-eval framework — a labeled case set, an independent LLM-as-judge, a runner, and a scorer — that measures the skill judge's decision accuracy and quality-band agreement and renders a single fail-closed pass/fail against a quality bar. The harness is offline, operator-run, and observe-only: it measures the production gate without touching it.

## Goals

1. **Make the skill judge measurable.** Produce decision-accuracy and quality-band-agreement reports for the skill judge. *Success metric:* a single eval run emits both numbers and a fail-closed pass/fail verdict.
2. **Reuse, don't reimplement.** Build entirely on the existing gate-eval framework, modeled on the brief-quality eval, with the production `SkillJudge` unchanged. *Success metric:* no new parallel eval framework is introduced; the case loader/runner/judge/scorer reuse existing framework primitives.
3. **Stay observe-only and deterministic in CI.** The production gating path and the judge's fail-open default are untouched; unit tests use a mocked LLM. *Success metric:* zero changes to production gating behavior; no worker makes real model calls; full build + test suite passes.

## User Stories

- **As a loom operator/maintainer**, I want to run an offline eval that reports the skill judge's decision accuracy and quality-band agreement with a single pass/fail, so that I can decide whether to trust it to gate the skill library. *(Must)*
- **As a maintainer**, I want to configure the gate-under-eval model and the judge model via environment variables with safe defaults, so that I can mitigate judge–gate circularity and reproduce runs. *(Must)*
- **As a maintainer**, I want deterministic mocked-LLM unit tests for the case loader, judge wiring, and scorer, so that CI validates the harness without real model calls. *(Must)*
- **As a maintainer**, I want a runner script and eval docs consistent with the existing evals, so that I can run the skill-judge eval the same way as the others. *(Should)*

## Functional Requirements

- **FR-1** — Provide a **labeled case set** of representative skill candidates spanning clearly-good (should accept), clearly-bad (should reject — too vague, not reusable, duplicative, or unsafe), and borderline candidates. Each case carries an expected accept/reject decision and an expected **quality band** (not an exact score).
- **FR-2** — Provide an **independent LLM-as-judge** that (a) decides on its own merits whether a candidate is worth admitting, and (b) grades the skill judge on whether it got the accept/reject decision right and whether its score sits in a defensible band.
- **FR-3** — Provide a **runner** that drives the production `SkillJudge` across the full case set, reusing the existing gate-runner pattern.
- **FR-4** — Provide a **scorer** that reports **decision accuracy** and **quality-band agreement** and renders a **fail-closed thresholded pass/fail** on whether the skill judge clears the quality bar.
- **FR-5** — Make **model selection environment-configurable** for both the gate-under-eval model and the judge model, with safe defaults; default the two to different models (or at least allow it) to mitigate circularity.
- **FR-6** — Define **quality bands** (good / borderline / bad) mapped to score ranges anchored to the `judge-minimum-score` knob's default, used as the agreement instrument. `[ASSUMPTION]` Bands map to reject-zone / borderline / accept-zone anchored to that default.
- **FR-7** — Provide **deterministic, mocked-LLM unit tests** covering the case loader, judge wiring, and scorer, with no real model calls.
- **FR-8** — Provide a **runner script and eval docs** consistent with the existing eval scripts, describing the skill-judge eval and how to run it.
- **FR-9** — If a user-visible surface changes, update `docs/capabilities.md` so the **capabilities drift check passes**. `[ASSUMPTION]` A new runner script/eval surface is the likely trigger.

## Non-Functional Requirements

- **NFR-1 — Observe-only.** The eval must not alter the skill judge's production behavior, including its fail-open-on-error default; it measures, it does not patch.
- **NFR-2 — No worker execution of the full eval.** The full skill-judge eval is operator-run and is explicitly *not* a worker story; no worker makes real model calls. This is a hard boundary.
- **NFR-3 — Guardrails untouched.** Policy engine and worktree-isolation invariants remain unchanged.
- **NFR-4 — Green build.** The full build and test suite must pass.

## Epics

- **Epic 1 — Skill-judge gate eval** (single cohesive piece of work: a fourth consumer of the existing gate-eval framework comprising case set, judge, runner, scorer, config, tests, and docs).

## Out of Scope

- Changing the skill judge's production gating behavior, including hardening the fail-open-on-error default (a measured-but-not-fixed risk; possible follow-up phase).
- Building any new or parallel eval framework — the existing gate-eval framework is reused as-is.
- Ratifying final band thresholds, quality-bar thresholds, and minimum case-set size/mix as organizational policy; this PRD adopts `[ASSUMPTION]` defaults (bands anchored to `judge-minimum-score`; case-set size referencing the brief-quality eval; thresholds following existing gate-eval precedent) pending ratification.
- Running the eval inside the production gating path or as part of normal worker execution.
