# Refined-Brief Variant for the Intake Classifier Eval

## Overview

The intake classifier systematically under-sizes: given a one-paragraph brief, it calls some epics "stories," collapsing real scope. The existing offline classifier eval already surfaces this weakness via per-axis accuracy, a confusion matrix, and a fail-closed decision, with explicit attention to epic-to-story under-sizing. What is missing is a way to **test the leading hypothesis for why** it under-sizes — the theory that a raw brief lacks the scope signals the brief refiner would supply. This PRD covers an additive, observe-only extension to the eval: for each labeled case, also classify a *refined* version of the brief and report both results side by side, so an operator can quantify whether refining-before-classifying shrinks under-sizing. This is measurement, not cure. No production behavior changes.

## Goals

1. **Quantify the refiner's effect on under-sizing.** Operator can read the epic-to-story under-sizing count for the raw-brief path and the refined-brief path for the same labeled case set in a single eval run. *Metric: both under-sizing counts present and directly comparable in the report.*
2. **Enable direct side-by-side comparison.** Operator can judge raw vs. refined without cross-referencing two runs. *Metric: per-axis accuracy and under-sizing count for both variants rendered together per the same case set.*
3. **Preserve the raw baseline exactly.** The existing raw-brief path remains the untouched default. *Metric: raw-brief numbers are bit-for-bit unchanged versus before this work.*
4. **Keep the eval safe and deterministic.** New wiring is testable without real model calls. *Metric: new eval wiring covered by mocked-LLM unit tests; full build and test suite pass.*

## User Stories

- **(Must)** As the **eval operator**, I want each labeled case classified on both its raw brief and a refined version, scored on the same axes, so that I can see side by side whether refining first reduces under-sizing.
- **(Must)** As the **eval operator**, I want the raw-brief results to remain the unchanged default baseline, so that the comparison has a stable reference point I trust.
- **(Should)** As a **loom maintainer**, I want the experiment's side-by-side output as evidence, so that a later, separate decision about refining in the production intake path can be made on data.
- **(Should)** As the **eval operator**, I want the refined variant gated by a flag or distinctly labeled, so that I run the baseline by default and opt into the more expensive refined comparison deliberately.

## Functional Requirements

- **FR-1** For each labeled case, the eval MUST classify the raw brief exactly as today (unchanged path).
- **FR-2** For each labeled case, the eval MUST produce a refined brief by calling the existing production brief refiner (non-agentic completion path), then classify that refined brief using the existing classifier.
- **FR-3** The refined-brief classification MUST be scored on the same axes used for the raw brief, including per-axis accuracy and the epic-to-story under-sizing count.
- **FR-4** `[ASSUMPTION]` The confusion matrix and fail-closed decision MUST also be computed for the refined variant, since the brief specifies scoring "on the same axes."
- **FR-5** The eval MUST report raw-brief accuracy and under-sizing count alongside refined-brief accuracy and under-sizing count, so the comparison is direct and unambiguous.
- **FR-6** The refined variant MUST reuse the existing refiner and classifier — no parallel copies or reimplementations.
- **FR-7** The refined variant MUST be opt-in (flag-gated) or clearly labeled in the report; the raw baseline remains the default comparison point. `[ASSUMPTION]` Flag-gated is acceptable; the brief permits either.
- **FR-8** Existing raw-brief results, numbers, and behavior MUST remain bit-for-bit unchanged.
- **FR-9** The eval docs MUST describe the refined-brief variant and how to run it; the capabilities drift check MUST pass if a user-visible surface changed.

## Non-Functional Requirements

- **NFR-1** New eval wiring MUST be covered by deterministic unit tests with a mocked LLM.
- **NFR-2** No worker MUST make real model calls, and the full eval MUST NOT be run as a worker story — the operator runs it offline.
- **NFR-3** No guardrails MUST be weakened.
- **NFR-4** `[ASSUMPTION]` Adding a refiner call per case roughly doubles the eval's LLM calls and run time; this is acceptable for an offline operator-run tool but should be noted in the docs.

## Epics

This PRD is a single epic: **Refined-brief variant for the intake classifier eval** — additive eval wiring (dual classification, same-axis scoring, side-by-side reporting), reusing the existing refiner and classifier, with deterministic tests and docs.

## Out of Scope

- Any change to the production intake pipeline — it continues to classify the raw brief.
- The downstream decision about whether to refine before classifying in production (this experiment only supplies evidence).
- Fixing or "curing" the under-sizing; this work measures, it does not remediate.
- Running the full eval as a worker story or making real model calls from a worker.
- Re-evaluating labeling semantics (whether human labels remain correct ground truth for a refined brief) — an open interpretation question, not wiring.
