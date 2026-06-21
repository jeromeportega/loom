# Gate-Eval Framework + Brief-Quality Scorer Eval

## The Problem

Loom runs a growing set of small, single-purpose **gates** through its non-agentic completion path — the brief-quality scorer, the skill judge, the lesson extractor, and the intake classifier. These gates make quality decisions that shape real planning and execution, yet only one of them is measured.

The intake classifier has a working offline eval: labeled cases, an Opus LLM-as-judge, a per-axis scorer with a confusion matrix, and a fail-closed gate with configurable thresholds (minimum scored cases, maximum classifier-failure and judge-inconclusive rates) and env-var model selection. Every other gate's quality is **a hope, not a measured number** — there is no way to catch a regression when a prompt, model, or threshold changes.

Two things block fixing this: the eval logic is welded to the classifier and cannot be reused, and the highest-leverage ungated gate — the **brief-quality scorer (BriefRefiner)** — gates *all* planning via the `min-brief-quality-score` policy knob while its own accuracy is entirely unmeasured.

## Target Users

- **Primary — loom maintainers / the release operator.** The developer who changes a gate and needs a regression signal, and the operator who runs the eval after merge and records the result.
- **Secondary — future gate-eval authors.** Whoever later builds evals for the skill judge, lesson extractor, and other single-purpose gates. They are the reason the framework must be gate-agnostic.
- **Anti-persona — loom end users running planning.** They must be *unaffected*. This work is an offline developer harness; it must never touch the production planning path or change a single planning decision.

## Proposed Solution

Extract the reusable structure of the intake eval into a **gate-agnostic eval framework** with five plug points — case loader, gate runner, LLM-as-judge step, aggregating scorer, and fail-closed thresholded decision — where each consumer supplies its own case schema, gate invocation, and judge prompt. Refactor the existing intake eval to sit on top of this framework with no behavior change. Then build the **brief-quality scorer eval** as the framework's first new consumer. The eval is offline, observe-only, and operator-run; it measures, it does not gate.

## Key Capabilities

1. **Reusable framework core** — case-set loader, per-case gate runner, LLM-as-judge step, a scorer aggregating per-case results into accuracy and failure-rate metrics, and a fail-closed decision with configurable thresholds and env-var model selection (gate-under-eval model *and* judge model, with safe defaults).
2. **Gate-agnostic plug points** — the case schema, the gate invocation, and the judge prompt are provided by each consumer, not baked into the core.
3. **Intake eval refactored onto the framework** — same inputs, same outputs, same thresholds; proven by its existing tests and a clean re-run.
4. **Brief-quality labeled case set** — representative rough briefs spanning clearly plan-ready, clearly not-ready/vague, and borderline, each labeled with expected readiness, an expected quality *band* (not an exact score), and the key critique themes a good reviewer should surface (a specific ambiguity, a missing scope item).
5. **Brief-quality LLM-as-judge** — independently assesses whether a brief is plan-ready, then grades the scorer on three axes: readiness correctness, quality score within a defensible band, and critique fidelity (surfaces the real issues without inventing fake ones).
6. **Brief-quality runner + scorer** — evaluates BriefRefiner over the case set and reports readiness accuracy, quality-score agreement within band, and critique quality, ending in a fail-closed decision on whether the scorer clears its bar.
7. **Deterministic mocked-LLM unit tests** — covering the framework, the scorer, the judge wiring, and the case-set loader, with no worker making real model calls.

## Constraints

- **Observe-only.** No change to BriefRefiner's production behavior; the eval does not gate real planning and is not wired into the integration gate.
- **Refactor, don't duplicate.** The intake eval is rebuilt on the new framework and must stay green; shared logic lives in the framework, not in two places.
- **Configurable models, safe defaults.** Both the gate-under-eval model and the judge model are env-var selectable.
- **No long eval inside a worker story.** Per the established lesson, this epic *prepares* the framework, case set, judge, runner, and scorer but does **not** run the full brief-quality eval as a worker story. The operator runs it after merge and records the result.
- **No real model calls from workers.** Tests use mocked LLM calls only.
- **Docs + capabilities drift.** Update docs to describe the framework and how to run the brief-quality eval; pass the capabilities drift check if any user-visible surface changes.

## Risks and Open Questions

- **Quality-band definition.** The case set labels an expected *band* rather than a score, but the band boundaries and the "agreement within band" tolerance are not specified. `[ASSUMPTION]` bands and tolerance will be defined as part of the case-set design and should be reviewed before the operator run.
- **Critique-quality is the hardest axis to judge.** "Surfaced the real issues without inventing fake ones" is inherently subjective and the most likely source of judge-inconclusive results. Threshold tuning here carries the most uncertainty.
- **Case-set size and representativeness.** Too few cases makes metrics noisy; the brief does not fix a count. `[ASSUMPTION]` a small but balanced set across the three readiness categories, sized to satisfy the framework's minimum-scored-cases threshold.
- **Operator-run cost and runtime.** An Opus judge per case has real cost and latency; this is acceptable precisely because it runs out-of-band, but the operator needs a documented expectation.
- **Framework boundaries.** Where the shared framework lives and how consumers register their plug points is unspecified. `[ASSUMPTION]` it lands alongside the existing intake eval modules in loom-core's eval surface.
- **Capabilities-page trigger.** Whether adding an operator-facing eval command counts as a user-visible surface change (and thus requires a `docs/capabilities.md` row) is an open question to resolve during implementation.

## Success Criteria

- [ ] A reusable gate-eval framework exists with a case loader, a gate runner, an LLM-as-judge step, an aggregating scorer, and a fail-closed thresholded decision, with env-var model selection.
- [ ] The intake classifier eval is refactored onto the framework, still passes its existing tests, and re-runs cleanly with unchanged behavior.
- [ ] A labeled brief-quality case set (plan-ready, not-ready, borderline) exists with expected readiness, expected quality band, and key critique themes per case.
- [ ] A brief-quality LLM-as-judge, runner, and scorer exist, reporting readiness accuracy, quality-score agreement within band, and critique quality, ending in a fail-closed decision.
- [ ] BriefRefiner's production behavior is verifiably unchanged; the eval is not wired into planning or the integration gate.
- [ ] Deterministic mocked-LLM tests cover the framework, scorer, judge wiring, and case loader; no worker makes a real model call, and the full eval does not run as a worker story.
- [ ] Docs describe the gate-eval framework and how to run the brief-quality eval; the capabilities drift check passes.
- [ ] The full build and test suite pass.
