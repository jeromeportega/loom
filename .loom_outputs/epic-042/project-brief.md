# Rubric-Based Eval for the Opportunity Engine's Signal-Clustering

## The Problem

Loom's opportunity engine reads a list of signals and clusters them into opportunities — emitting a JSON array where each cluster carries a title, the signal ids it groups, impact/effort/confidence scores, and a rationale. It runs on the non-agentic completion path and feeds loom's signal-to-opportunity synthesis. **Today its clustering quality is unmeasured.** Because the output is open-ended — there is no single correct clustering — exact-match evaluation does not apply, and nothing currently catches the failure modes that matter: forcing unrelated signals into one cluster, inventing opportunities from nothing, or citing signal ids that never appeared in the input. The gate-eval framework already exists and is gaining consumers; the opportunity engine is the next thing being trusted without a gate in front of it.

## Target Users

- **Primary — the eval operator.** A maintainer who runs the offline harness to decide whether the opportunity engine's clustering clears a quality bar before it is trusted in synthesis.
- **Secondary — gate-eval framework maintainers.** They extend the framework and rely on each consumer following the post-refactor sub-barrel convention (own directory, direct imports, single top-barrel re-export). The lesson-extractor consumer is the reference this one must resemble.
- **Secondary — downstream synthesis.** The signal-to-opportunity pipeline that consumes the engine's output benefits from a measured quality floor.
- **Anti-persona — the worker/CI agent.** This eval is explicitly *not* for unattended worker execution. No worker story runs the full eval, and no worker makes real model calls. The operator runs it.

## Proposed Solution

Add a new gate-eval **consumer** for the opportunity engine, living in its own `opportunity-engine` directory with its own sub-barrel and a single public entry, wired to its modules via direct imports and adding at most one re-export line to the top barrel. It mirrors the lesson-extractor rubric eval: it drives the **production** opportunity engine over a curated case set, judges the produced clusters against a **rubric** (not an exact labeled answer) via an LLM-as-judge, scores and aggregates the results, and renders a fail-closed thresholded decision. It reuses the existing framework (case loader, runner, judge step, scorer, fail-closed decision, env-configurable model selection) and the production engine — no reimplementations. The eval is observe-only: it changes nothing about how the engine behaves in production.

## Key Capabilities

1. **Rubric case set.** Representative signal inputs, each paired with rubric expectations (expected themes + force-clustering traps) rather than an exact clustering. Must include at least: one set with clearly separable themes (→ distinct clusters), one set of largely unrelated noise (→ few or no meaningful clusters, *not* forced groupings), and one mixed set.
2. **Rubric LLM-as-judge.** Scores produced clusters on, at minimum, **cluster coherence** (groups genuinely related signals), **score reasonableness** (impact/effort/confidence defensible, not arbitrary), and **grounding** (every clustered signal id exists in the input; no opportunity invented). It flags forced/incoherent clusters, invented opportunities, and nonexistent signal ids.
3. **Runner over the production engine.** Drives the real opportunity engine across the case set and **exercises its JSON-repair retry path**.
4. **Scorer + fail-closed decision.** Aggregates coherence, score-reasonableness, and grounding into metrics plus a **forced-clustering / hallucination rate**, and decides fail-closed whether the clustering clears the quality bar.
5. **Deterministic tests.** Mocked-LLM unit tests for the case loader, the rubric-judge wiring, and the scorer — no real model calls.
6. **Operability.** A runner script consistent with existing eval scripts, plus updated eval docs describing how to run it.

## Constraints

- **Observe-only.** Do not change the opportunity engine's production behavior.
- **Reuse, don't reimplement.** Build on the existing gate-eval framework and the production opportunity engine.
- **Sub-barrel convention.** New consumer in its own directory, own sub-barrel, direct imports, ≤1 re-export line added to the top barrel.
- **Model selection env-configurable** for both the gate-under-eval model and the judge model, with safe defaults.
- **Offline, operator-run.** Not a worker story; the full eval is never run by a worker; no worker makes real model calls.
- **Do not weaken any guardrail.**
- **Capabilities drift check must pass** if a user-visible surface changes.
- **Full build and test suite must pass.**

## Risks and Open Questions

- **Where is the quality bar set?** The brief specifies a fail-closed decision but not the threshold values. [ASSUMPTION] The bar is an operator-tunable threshold with a documented safe default, consistent with the framework's existing thresholded-decision pattern.
- **Judge non-determinism.** The eval itself is LLM-based, so judge variance could swing pass/fail for cases near the threshold. [ASSUMPTION] Rubric prompt design and threshold margin are in scope to keep the signal stable; unit tests mock the LLM precisely to avoid this in CI.
- **Triggering the JSON-repair retry deterministically.** Exercising the repair path requires an input or fixture that reliably provokes malformed output. [ASSUMPTION] A crafted fixture (or a mocked engine response in tests) covers the retry path without depending on live model flakiness.
- **Is the harness a "user-visible surface"?** Whether an operator-run eval + runner script counts as a capabilities-page surface is an open question; if it does, `docs/capabilities.md` must be updated and the drift check must pass.
- **Rubric calibration.** "Themes a competent reviewer expects" and "defensible scores" are judgment calls; the rubric must encode them concretely enough that the judge applies them consistently across the separable, noise, and mixed cases.

## Success Criteria

- A new `opportunity-engine` consumer exists in its own directory with its own sub-barrel and a single public entry, adding at most one re-export line to the top barrel, built on the existing framework.
- A case set of signal inputs with rubric expectations exists, including expected themes and force-clustering traps, with at least the separable-themes, unrelated-noise, and mixed cases.
- A rubric LLM-as-judge scores cluster coherence, score reasonableness, and grounding, and flags forced clusters, invented opportunities, and nonexistent signal ids.
- A runner drives the **production** opportunity engine over the case set and exercises its JSON-repair retry path.
- A scorer aggregates the three rubric dimensions plus a forced-clustering / hallucination rate and renders a fail-closed decision against a quality bar.
- The opportunity engine's production behavior is unchanged; the eval is observe-only; no guardrail is weakened.
- Model selection is environment-configurable for both the gate-under-eval and judge models, with safe defaults.
- Deterministic mocked-LLM unit tests cover the case loader, the rubric-judge wiring, and the scorer; no worker makes real model calls; the full eval is not run as a worker story.
- A runner script consistent with existing eval scripts exists, and the eval docs describe how to run it.
- The capabilities drift check passes if a user-visible surface changed.
- The full build and test suite pass.
