# PRD: Fix Skill-Generator Eval Decision-Correctness Scoring

## Overview

The skill-generator eval's decision-correctness scoring is defective and produces a false-negative gate: a recent run scored a healthy generator at **0% decision correctness over 4 of 8 cases** and raised a do-not-proceed verdict, even though the generator correctly returned `NONE` on all four trivial cases and produced healthy skills for the worthy ones. Two compounding defects cause this — (1) `NONE` cases are silently dropped from decision scoring and the scored-case count because there is no skill body to judge, and (2) cases that correctly generated still scored as incorrect, pointing to a broken actual-versus-expected comparison. This is a **consumer-side fix only**: it repairs the eval's decision-scoring logic by decoupling it from skill-quality judging, reuses the existing gate-eval framework, and leaves the skill generator's production behavior untouched.

## Goals

- **Score every case's decision.** Decision correctness is computed for all 8 cases (not 4), including correct-`NONE` cases. Success metric: scored-case count equals total case count for the reference 8-case run.
- **Restore a trustworthy gate.** The proceed / do-not-proceed verdict is driven by corrected decision-correctness numbers. Success metric: the reference run that exhibited correct generator behavior scores 100% decision correctness and does not raise a false do-not-proceed gate.
- **Lock the fix with deterministic tests.** Mocked-LLM unit tests prove all four scoring behaviors. Success metric: tests cover correct-`NONE`-counted, correct-generate, incorrect-in-either-direction, and quality-only-on-generated; full build and test suite pass.

## User Stories

- As a **loom operator**, I want decision correctness to reflect the generator's actual generate-versus-`NONE` behavior across all cases, so that I can trust the gate verdict when deciding whether the generator is safe to proceed. **(Must)**
- As a **loom maintainer**, I want the eval's decision metrics to be consistent and complete over time, so that I can track generator regression and improvement without false negatives polluting the signal. **(Should)**

## Functional Requirements

- **FR-1** — The eval MUST compute generate-versus-`NONE` decision correctness for **every** case, independent of whether a skill body was produced.
- **FR-2** — A correct `NONE` decision on a trivial case MUST be counted in the scored-case count and MUST score as a correct decision.
- **FR-3** — Decision scoring MUST compare the generator's **actual** decision against the **case's expected** decision (read from the case fixture), with correct polarity, so that both a correct generate and a correct `NONE` register as correct.
- **FR-4** — `NONE` cases MUST NOT be removed from decision scoring or from the scored-case count.
- **FR-5** — Skill **quality and faithfulness** judging MUST continue to run, but only on cases that actually produced a skill; a `NONE` result has no skill to grade and is excluded from quality judging only — not from decision scoring.
- **FR-6** — The proceed / do-not-proceed gate verdict MUST be driven by the corrected decision-correctness figures. If the gate threshold is expressed against the (previously dropped-`NONE`) scored-case denominator, that denominator MUST be corrected so the threshold evaluates against all scored cases. `[ASSUMPTION]` The threshold *value* itself is correctly specified and needs no change — only its inputs were wrong; this is confirmed during implementation.
- **FR-7** — Deterministic, mocked-LLM unit tests MUST cover: (a) a correct `NONE` on a trivial case scores as correct **and** is counted as scored; (b) a correct generate scores as correct; (c) an incorrect decision in **either** direction scores as incorrect; (d) quality grading applies only to generated skills.

## Non-Functional Requirements

- **NFR-1** — Unit tests MUST be deterministic with mocked LLM/judge responses; no live judge calls in unit tests.
- **NFR-2** — No guardrail may be relaxed as a side effect of this change.

## Epics

This PRD breaks into **one epic**: repair the skill-generator eval consumer's decision-correctness scoring by decoupling it from skill-quality judging, within the existing gate-eval framework.

## Out of Scope

- Any change to the **skill generator's production behavior** — the generator is correct and is explicitly not touched.
- Any change to **other eval consumers**; if decision-scoring logic is shared, the fix MUST be isolated to the skill-generator path so other consumers remain unchanged.
- **Adjusting the gate threshold value** (only its inputs are corrected).
- **Running the full skill-generator eval** as part of this work — the eval stays observe-only and operator-run; the operator re-runs it after the fix.
- Introducing a parallel/alternative scoring path instead of reusing the gate-eval framework.
- New CLI/MCP surface. `[ASSUMPTION]` This is an internal scoring fix; the capabilities drift check applies only if eval output or docs prove operator-facing, in which case docs are updated and the drift check is passed.
