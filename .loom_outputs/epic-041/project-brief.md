# Lesson-Extractor Eval — A Rubric-Based Gate-Eval Consumer

## The Problem

The **lesson extractor** reads an epic's telemetry — decision traces, agent logs, and the audit tail — and produces a set of structured lessons (category, observation, general rule, optional root cause and evidence). Those lessons feed loom's post-epic learning loop. It runs on the non-agentic completion path and **currently has no eval.**

Every other gate-eval consumer to date — classifier, brief-quality, skill-judge — grades output against a known-correct label. The lesson extractor cannot be graded that way: its output is open-ended, with no single correct set of lessons to match. Without an eval, the failure modes that matter most go undetected:

- **Hallucinated lessons** — claims not grounded in the supplied telemetry.
- **Over-extraction** — manufacturing lessons from thin or near-empty input.
- **Missed lessons** — important, surfaceable patterns the extractor failed to report.
- **Low-value lessons** — vague restatements rather than actionable, general rules.

Whoever owns extraction quality has no instrument to tell whether a change improved or regressed it.

## Target Users

- **Primary — the eval operator.** Runs the offline harness on demand to judge whether the lesson extractor clears a quality bar before relying on its output.
- **Secondary — loom maintainers / post-epic learning-loop owners.** Consume the aggregate metrics (faithfulness, usefulness, coverage, hallucination rate) and the fail-closed verdict to gate changes to the extractor.
- **Anti-persona — the autonomous worker/agent.** This eval is explicitly *not* a worker story. No worker runs the full eval, and no worker makes real model calls. The harness exists for the operator, off the agentic path.

## Proposed Solution

A new **rubric-based eval consumer** built on the existing gate-eval framework, living in its own `lesson-extractor` directory with its own sub-barrel and a single public entry. It reuses the framework (case loader, gate runner, LLM-as-judge step, scorer, fail-closed thresholded decision) and the **production** lesson extractor — no reimplementations. The structural reference is the existing brief-quality and skill-judge consumers.

The key departure from prior consumers: the judge scores the **extracted lessons against a rubric**, not against labeled verdicts. Cases are paired with *rubric expectations* — the lesson themes a competent reviewer should expect — rather than exact expected lessons.

## Key Capabilities

1. **Case set** of representative epic-telemetry inputs (realistic decision traces, agent logs, audit tails), including at least one **rich multi-story epic** and one **thin / near-empty epic**, each paired with rubric expectations: expected lesson themes plus known **over-extraction traps** (telemetry that should yield few or no lessons).
2. **Rubric-based LLM-as-judge** scoring extracted lessons on, at minimum, **faithfulness** (grounded in telemetry, not invented), **usefulness** (actionable general rule, not vague restatement), and **coverage** (important lessons surfaced without padding) — and flagging **hallucinated lessons** and **over-extraction**.
3. **Runner** that drives the production lesson extractor over the case set.
4. **Scorer** aggregating rubric scores into faithfulness, usefulness, and coverage metrics plus a **hallucination rate**, with a **fail-closed decision** on whether the extractor clears the quality bar.
5. **Environment-configurable model selection** for the gate-under-eval model and the judge model, with safe defaults.
6. **Runner script + eval docs** consistent with existing eval scripts, describing how the operator runs it.

## Constraints

- **Observe-only.** Do not change the lesson extractor's production behavior.
- **Reuse, don't reimplement.** Use the existing gate-eval framework and the production lesson extractor.
- **Sub-barrel convention.** New consumer in its own directory with its own sub-barrel wired via direct imports; add at most a **single re-export line** to the top barrel.
- **Model selection** stays environment-configurable (gate model + judge model) with safe defaults.
- **Offline, operator-run.** Not a worker story; the operator runs it. No worker makes real model calls.
- **Deterministic mocked-LLM unit tests** for the case loader, rubric judge wiring, and scorer.
- **Do not weaken any guardrail.** Pass the capabilities drift check if a user-visible surface changes.

## Risks and Open Questions

- **Quality-bar threshold is undefined.** The fail-closed decision needs a concrete pass threshold per metric. *Open question for the PM/architect:* what scores constitute "clears the bar"? [ASSUMPTION] thresholds will be calibrated against the brief-quality / skill-judge reference consumers rather than set arbitrarily.
- **Judge variance on open-ended output.** Rubric scoring of unlabeled output is inherently noisier than label-matching; a noisy judge could make the gate flaky. [ASSUMPTION] mitigated by clear rubric anchors and the deterministic mocked tests, but real-model judge stability is unverified until the operator runs it.
- **Case-set realism.** Synthetic telemetry must be representative of real epics for the eval to be meaningful. [ASSUMPTION] hand-authored fixtures are acceptable for v1; anonymized real telemetry would be stronger if available.
- **Rubric-expectation authoring is subjective.** "Expected lesson themes" and "over-extraction traps" are reviewer judgments; two authors may disagree. Worth a brief review pass on the case set before trusting the gate.
- **Barrel/entry convention drift.** Confirm the single-public-entry and one-re-export-line pattern matches the current brief-quality / skill-judge structure exactly, since the refactor is recent.

## Success Criteria

The build is done when all of the following exist and hold:

- [ ] A **case set** of epic-telemetry inputs with rubric expectations (expected lesson themes and over-extraction traps), including a rich multi-story epic and a thin/near-empty epic.
- [ ] A **rubric-based LLM-as-judge** scoring faithfulness, usefulness, and coverage, and flagging hallucination and over-extraction.
- [ ] A **runner** that drives the production lesson extractor over the case set.
- [ ] A **scorer** producing faithfulness/usefulness/coverage metrics + hallucination rate, with a **fail-closed decision**.
- [ ] All of the above built on the **existing framework**, in a **new `lesson-extractor` consumer directory** with its own sub-barrel; the top barrel gains at most one re-export line.
- [ ] The lesson extractor's **production behavior is unchanged**; the eval is **observe-only**.
- [ ] **Model selection is environment-configurable** (gate model + judge model) with safe defaults.
- [ ] The **case loader, rubric judge wiring, and scorer** have **deterministic mocked-LLM tests**; no worker makes real model calls.
- [ ] The **full eval is not run as a worker story**; a **runner script** and **updated eval docs** describe how the operator runs it.
- [ ] **No guardrail weakened**; the **capabilities drift check passes** if a user-visible surface changed.
- [ ] The **full build and test suite pass.**
