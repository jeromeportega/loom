# Refined-Brief Variant for the Intake Classifier Eval

## The Problem

The intake classifier under-sizes. Given a one-paragraph brief, it returns a type and size with confidence — but it systematically calls some epics "stories," collapsing real scope into work that looks smaller than it is. The offline classifier eval already surfaces this weakness: it classifies each labeled case's raw brief, scores per-axis accuracy, builds a confusion matrix, and renders a fail-closed decision, with explicit attention to epic-to-story under-sizing confusions.

What is missing is a way to *test the leading hypothesis for why* it under-sizes. The working theory is that a raw one-paragraph brief simply lacks the scope signals needed to size correctly — and that the brief refiner, which surfaces hidden complexity and missing scope, would supply exactly those signals. Today there is no measurement that would confirm or refute this. Operators can see the under-sizing, but cannot quantify whether refining-before-classifying would shrink it. This brief covers the measurement, not the cure.

## Target Users

- **Primary — the eval operator.** Runs the classifier eval offline, by hand, over the labeled case set. Needs to read raw-brief and refined-brief results side by side and judge whether refining first reduces under-sizing.
- **Secondary — loom maintainers deciding production intake direction.** Consume the experiment's output as evidence for a later, separate decision about whether to refine before classifying in the production path.
- **Anti-persona — the production intake pipeline and its end users.** Explicitly *not* served by this change. Nothing in the live intake path moves; production continues to classify the raw brief.

## Proposed Solution

Extend the existing intake classifier eval with an **additive refined-brief variant**. For each labeled case, in addition to today's raw-brief classification, run the brief through the production brief refiner to produce a refined brief, classify *that*, and score it on the same axes. Report both results side by side so the operator can directly compare raw-brief and refined-brief under-sizing. The existing raw-brief path is the untouched default baseline; the refined variant is opt-in or clearly labeled. This is an observe-only experiment — no production behavior changes.

## Key Capabilities

1. **Dual classification per case** — for every labeled case, classify the raw brief (exactly as today) and, separately, classify a refined version produced by the brief refiner.
2. **Same-axis scoring for the refined variant** — score the refined-brief classification on the same axes used for the raw brief, including per-axis accuracy and the epic-to-story under-sizing count. `[ASSUMPTION]` the confusion matrix and fail-closed decision are also computed for the refined variant, since the brief specifies scoring "on the same axes."
3. **Side-by-side reporting** — present raw-brief accuracy and under-sizing count alongside refined-brief accuracy and under-sizing count, so the comparison is direct and unambiguous.
4. **Reuse, not reimplementation** — the variant calls the existing production brief refiner (non-agentic completion path) and the existing classifier; no parallel copies.
5. **Opt-in / clearly-labeled variant** — the raw baseline remains the default comparison point; the refined variant is gated behind a flag or distinctly labeled in the report. `[ASSUMPTION]` flag-gated is acceptable; the brief permits either and leaves the choice to implementation.
6. **Preserved raw baseline** — existing raw-brief results, numbers, and behavior remain bit-for-bit unchanged.

## Constraints

- **Production intake unchanged.** The live pipeline still classifies the raw brief. This phase touches the eval only.
- **Offline, operator-run only.** The full eval is *not* executed as a worker story — the operator runs it. No worker makes real model calls.
- **Reuse the existing refiner and classifier**, both on the non-agentic completion path.
- **Deterministic tests.** New eval wiring is covered by unit tests with a mocked LLM.
- **No guardrail weakening.**
- **Docs and drift.** Update the eval docs to describe the refined-brief variant and how to run it; pass the capabilities drift check if a user-visible surface changes.
- **Operational cost** `[ASSUMPTION]` — adding a refiner call per case roughly doubles the eval's LLM calls and run time; acceptable for an offline operator-run tool, but worth noting.

## Risks and Open Questions

- **The hypothesis may not hold.** Refining might not reduce under-sizing — or could over-correct, pushing some stories up to epics. The eval is designed to reveal this either way; a null or negative result is a valid outcome, not a failure of the work.
- **Refiner noise.** `[ASSUMPTION]` the refiner could introduce scope that misleads the classifier in cases that were already correctly sized; the side-by-side report should make any such regression visible.
- **Labeling semantics.** Open question: are the human labels still the correct ground truth for a *refined* brief, given the refiner may legitimately surface scope the labeler did not see? This affects interpretation, not wiring.
- **Variant exposure mechanism.** Open question for the PM: flag vs. always-rendered-but-labeled. Either satisfies the brief; the choice affects the user-visible surface and therefore the capabilities/drift obligation.

## Success Criteria

- For each labeled case, the eval classifies **both** the raw brief and a refined version produced by the production brief refiner, and reports both side by side — including per-axis accuracy and the epic-to-story under-sizing count for each.
- The existing raw-brief eval path and its numbers are **unchanged** and remain the default comparison point.
- The refined-brief variant **reuses** the existing refiner and classifier, not reimplementations.
- New eval wiring has **deterministic, mocked-LLM unit tests**; no worker makes real model calls, and the full eval is not run as a worker story.
- The **production intake pipeline is unchanged.**
- The **eval docs** describe the refined-brief variant and how to run it; the capabilities drift check passes if a user-visible surface changed.
- The **full build and test suite pass.**
