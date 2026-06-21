# Sharpen BriefRefiner Readiness Determination

## Overview

loom's BriefRefiner scores brief quality and emits a binary readiness flag, but that flag is over-cautious: it flips otherwise plan-ready briefs to **not ready** whenever one more clarification question can be imagined, even minor or optional ones a planner could proceed past. The offline brief-quality eval isolates this — quality-score band agreement and critique faithfulness are at 100%, while readiness correctness sits at ~67%, with every miss in the same direction (briefs that are ready, called not ready). This work sharpens the readiness criteria inside the BriefRefiner prompt so **ready** means *plannable* — quality in the ready band and no critical, planning-blocking gap — rather than the mere availability of a question. It is a principled prompt change, not eval-fixture tuning, and it must leave the score and critique axes untouched.

## Goals

1. **Correct the readiness flag's meaning.** Readiness reflects genuine plan-readiness (ready-band quality + no critical blocking gap), not question-availability. *Metric:* readiness-axis accuracy in the operator-run brief-quality eval rises above the current ~67% baseline, with no remaining one-directional "ready→not ready" bias.
2. **Hold the two passing axes flat.** *Metric:* quality-score band agreement and critique faithfulness remain at 100% after the change.
3. **Keep the contract and guardrails intact.** *Metric:* output schema, parsing, fallback behavior, and the non-agentic transport are unchanged; no guardrail is weakened; the full build and test suite pass.

## User Stories

- **As a loom operator running planning,** I want the readiness flag to distinguish a *clean pass* from a *pass-with-clarifications* accurately, so that I am not sent chasing answers planning never needed. (Must)
- **As a loom maintainer,** I want unit tests asserting the readiness-criteria intent without live model calls, so that I can confirm the fix and guard against regression in CI. (Must)
- **As a loom maintainer running the brief-quality eval,** I want readiness semantics documented where they are surfaced, so that re-running the operator eval and reading its output is unambiguous. (Should)

## Functional Requirements

- **FR-1** — The BriefRefiner prompt MUST define **ready** as: the brief's quality is in the ready band *and* no critical, planning-blocking gap (blocking ambiguity or missing scope) exists.
- **FR-2** — The readiness criteria MUST be severity-aware: critical gaps make a brief not ready; minor or optional gaps a planner can reasonably proceed past MUST NOT.
- **FR-3** — The presence of minor or optional clarification questions MUST NOT, on its own, flip an otherwise plan-ready brief to not ready. Clarification questions are still surfaced; they no longer force a "not ready" verdict.
- **FR-4** — The readiness flag MUST be internally consistent with the brief's own quality score and the severity expressed in its critique.
- **FR-5** — The readiness criteria MUST be stated as general principles of plan-readiness, referencing no eval fixture or specific labeled case.
- **FR-6** — The scorer MUST continue to return the same outputs: readiness flag, 0–10 quality score, optional refined brief, structured critique, and clarification questions — with unchanged schema, parsing, and fallback behavior.
- **FR-7** — Documentation of readiness semantics MUST be updated wherever it exists; if a user-visible surface changes, the capabilities drift check MUST pass.

## Non-Functional Requirements

- **NFR-1** — Readiness-intent unit tests MUST exercise the decision logic via fixed/mocked scorer outputs and MUST NOT spawn real model completions.
- **NFR-2** — The scorer MUST remain on the non-agentic completion path; its transport is not changed.
- **NFR-3** — The prompt edit MUST NOT be tuned or fitted to specific eval cases (no overfitting), and MUST be checked for the opposite failure mode — over-correction into false "ready" verdicts.

## Epics

This PRD is a single epic: **Sharpen BriefRefiner readiness criteria** — the prompt change, supporting unit tests, and documentation/capabilities updates.

## Out of Scope

- Lowering the quality gate or any change to what quality score is required to plan. The ready band is unchanged; only the no-critical-gap condition is added on top of it.
- Running the full brief-quality eval as a worker story — it stays operator-run; this epic ships the criteria change plus unit tests.
- Any change to the output schema, parsing, fallback behavior, or the scorer's transport.
- Weakening or altering any guardrail.
