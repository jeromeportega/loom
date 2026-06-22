# Intake Routing — Graduating the Classifier from Observe-Only to Acting

## Overview

Loom's intake classifier already runs on every refined brief and records a **type** and **size** verdict to the database and audit log, but it is observe-only: the verdict never reaches planning. The planner guesses size on its own and routinely over-decomposes — inflating a single cohesive change into a multi-story epic. Classifying the *refined* brief has made the verdict trustworthy, yet that trust is stranded. This feature adds an **opt-in policy knob** that graduates the classifier from observing to acting, feeding its effective size and type into the existing planner as an explicit sizing constraint. It ships under conservative graduation: **default off, byte-identical legacy path, and acting only on explicit opt-in**, with three operator-controlled levels (`off`, `advisory`, `confirm`) and audit-log provenance for every routed decision.

## Goals

1. **Correctly-sized work the first time.** When routing is active, a `story` verdict produces a single cohesive story or the minimum necessary decomposition — *not* an inflated multi-story epic. **Metric:** an outcome-level test confirms a `story` verdict yields a single-story result (over-decomposition no longer occurs on the routed path).
2. **Zero impact for opted-out operators.** With the knob `off`, the classifier remains observe-only and the planning path is byte-identical to today. **Metric:** an automated test proves the off-path output and classifier behavior are unchanged (NFR-1 holds).
3. **Traceable provenance.** Every confirm-mode decision — accepted or overridden — is recorded with both the original verdict and the final routed values. **Metric:** the audit log distinguishes *accepted* from *overridden* and captures original-and-final values for 100% of confirm-mode runs.

## User Stories

- **Must** — As a **loom operator**, I want planning to size my work correctly the first time so that I don't hand-correct an inflated epic afterward.
- **Must** — As a **loom operator**, I want to choose per my risk tolerance whether routing is automatic (advisory) or gated (confirm) so that I control how much the classifier acts on my behalf.
- **Should** — As a **maintainer or auditor**, I want traceable provenance — what the classifier said, what the operator decided, and what the planner was told — so that a routed outcome can be traced to its source.
- **Must** — As an **operator who has not opted in**, I want behavior to be byte-identical to today so that this feature is invisible until I explicitly enable it.

## Functional Requirements

- **FR-1** — A policy knob `intake_routing` gates the feature with levels `off` (default), `advisory`, and `confirm`.
- **FR-2** — At `off`, the classifier runs observe-only, the verdict is recorded but never influences planning, and the planning path is byte-identical to today.
- **FR-3** — At `advisory`, planning routes on the verdict automatically; the classification (type, size, confidence) and its rationale are printed before planning begins; planning does **not** wait for input.
- **FR-4** — At `confirm`, the same classification surface is printed, then the operator is prompted to accept the classification or override **type and/or size** before planning proceeds; planning routes on the confirmed-or-overridden verdict.
- **FR-5** — Routing passes the effective size and type into the **existing planner as an explicit sizing constraint** (injected as prompt text): `story` instructs a single cohesive story or minimal necessary decomposition; `epic` instructs full decomposition as today. It is demonstrably not a separate or parallel pipeline.
- **FR-6** — The confirm-mode decision is recorded in the audit log alongside the original verdict, distinguishing *accepted* from *overridden* and capturing the final routed values.
- **FR-7** — `docs/capabilities.md` documents the knob and routing behavior, and the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1 (Observe-only invariant)** — When `intake_routing` is `off`, the classifier remains observe-only and the planning path is byte-identical to today. This invariant must be proven by an automated test.
- **NFR-2 (Non-blocking)** — Planning must not block for input except in `confirm` mode; `off` and `advisory` are non-blocking.
- **NFR-3 (No weakened guardrails)** — No existing guardrail may be weakened by this feature.
- **NFR-4 (Path integrity)** — The classifier stays on the non-agentic path and continues to classify the *refined* brief.

## Assumptions

- **[ASSUMPTION]** Confirm mode requires an interactive terminal. A defined non-interactive behavior (hard error, or documented degrade to advisory) is needed for headless/CI invocation and must be settled before implementation.
- **[ASSUMPTION]** The sizing constraint is injected as explicit prompt text; the `story`→single-story outcome must be verified by an outcome-level test, not assumed from the instruction's presence.
- **[ASSUMPTION]** Operator override is limited to **type and size**; confidence and rationale are classifier outputs and are not operator-editable.
- **[ASSUMPTION]** The confirm prompt is a new, self-contained CLI checkpoint distinct from epic approval; its ordering relative to existing gates should be confirmed.

## Epics

This PRD breaks into a single epic:

- **Intake Routing** — Add the `intake_routing` policy knob and graduate the classifier from observe-only to acting, routing the effective verdict into the existing planner as a sizing constraint with audit-log provenance and the three operator-control levels.

## Out of Scope

- The **web pending-classification surface** — CLI only this phase; it is an explicit follow-up.
- Operator editing of **confidence or rationale** — override is limited to type and size.
- Any change to **classifier accuracy** or the classifier's path — it continues to classify the refined brief on the non-agentic path.
- A **parallel or replacement planning pipeline** — routing must reuse the existing planner.
