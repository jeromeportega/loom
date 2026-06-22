# SkillJudge Eval — Measuring the Skill-Candidate Judge Before We Trust It to Gate

## The Problem

The skill judge (`SkillJudge`) decides what enters loom's skill library. Given a freshly-generated candidate skill — a `SKILL.md` body plus its context — it returns a 0–10 quality score and an accept-or-reject verdict with a reason. That verdict is a gate: admission is controlled by the `judge-minimum-score` policy knob, the judge now runs on the non-agentic completion path, and **on error it fails open — it defaults to accept**.

A gate that fails open and whose judgment quality has never been measured is an untrusted gate. Every other consumer of the gate-eval framework — the intake classifier eval, the brief-quality eval — has a labeled case set and a scorer proving it behaves. The skill judge has neither. We are trusting it to protect the skill library on faith. This phase replaces faith with measurement.

## Target Users

- **Primary — loom operators / maintainers.** They run the offline eval harness to answer one question: *can the skill judge be trusted to gate the library, and does it clear our quality bar?* They consume decision-accuracy and quality-band-agreement reports and a single fail-closed pass/fail.
- **Secondary — the `SkillJudge` itself**, as the gate-under-eval. The eval observes its behavior; it does not modify it.
- **Anti-persona — worker agents.** Workers must never run this eval. The full skill-judge eval is explicitly *not* a worker story, and no worker makes real model calls. This boundary is a requirement, not a guideline.

## Proposed Solution

Build a fourth consumer of the **existing** gate-eval framework, modeled structurally on the brief-quality eval — the closest existing reference (labeled cases, an independent LLM-as-judge that grades the gate, a per-axis scorer, a fail-closed decision). We reuse the framework, the case loader/runner/judge/scorer primitives, and the production `SkillJudge` unchanged. We add four new pieces specific to skill-candidate judging:

1. A **labeled case set** of representative candidate skills.
2. An **LLM-as-judge** that independently assesses skill admissibility and grades the skill judge's verdict.
3. A **runner** that evaluates the skill judge across the case set.
4. A **scorer** that reports decision accuracy and quality-band agreement, then renders a fail-closed pass/fail against a quality bar.

This is an offline, operator-run, observe-only harness. Nothing about it touches the production gating path.

## Key Capabilities

1. **Labeled case set** spanning clearly-good candidates (should accept), clearly-bad candidates (should reject — too vague, not reusable, duplicative, or unsafe), and borderline candidates. Each case is labeled with an expected accept-or-reject decision and an expected **quality band** — not an exact score.
2. **Independent LLM-as-judge** that decides whether a candidate is worth admitting on its own merits, then grades the skill judge on (a) whether it got the accept/reject decision right and (b) whether its score sits in a defensible band.
3. **Runner** that drives the skill judge over the full case set, reusing the existing gate-runner pattern.
4. **Scorer** reporting **decision accuracy** and **quality-band agreement**, with a **fail-closed thresholded decision** on whether the skill judge clears the quality bar.
5. **Environment-configurable model selection** for both the gate-under-eval model and the judge model, with safe defaults.
6. **Deterministic, mocked-LLM unit tests** covering the case loader, judge wiring, and scorer — no real model calls.
7. **Runner script + eval docs** consistent with the existing eval scripts, describing the skill-judge eval and how to run it.

## Constraints

- **Observe-only.** Do not change the skill judge's production behavior, including its fail-open-on-error default. This eval measures; it does not patch.
- **Reuse, don't reimplement.** Build on the existing gate-eval framework and the existing `SkillJudge`. Use the brief-quality eval as the structural template. No parallel framework.
- **Model selection via environment variables** for both the gate-under-eval model and the judge model, with safe defaults.
- **Offline operator-run harness.** The full eval is not a worker story; the operator runs it. No worker makes real model calls.
- **Do not weaken any guardrail.** Policy engine and isolation invariants are untouched.
- **Capabilities discipline.** If a user-visible surface changes, pass the capabilities drift check (and update `docs/capabilities.md` per repo policy).
- **Green build.** The full build and test suite must pass.

## Risks and Open Questions

- **Quality-band definition.** The bands (good / borderline / bad) and their score boundaries are the eval's core judgment instrument. Poorly drawn bands make "band agreement" meaningless. *Open: who ratifies the band thresholds?* `[ASSUMPTION]` Bands map roughly to score ranges (e.g. reject-zone / borderline / accept-zone) anchored to the `judge-minimum-score` knob's default.
- **Case-set representativeness and size.** Too few cases — especially borderline ones — and accuracy figures are noise. *Open: minimum case count, and target good/bad/borderline mix?* `[ASSUMPTION]` The brief-quality eval's case-set size is a reasonable starting reference.
- **Judge–gate circularity.** The independent LLM-as-judge and the skill judge may share model family and blind spots, inflating agreement. `[ASSUMPTION]` Defaulting the two to different models (or at least allowing it via the env knobs) mitigates this.
- **Fail-open is measured but not fixed.** This eval will likely surface that the production default-to-accept-on-error behavior is risky, but changing it is explicitly out of scope here. *Open: is a follow-up phase expected to harden the production default once measured?*
- **The quality bar itself.** What decision-accuracy and band-agreement thresholds constitute "clears the bar"? *Open.* `[ASSUMPTION]` Thresholds follow the precedent set by the existing gate evals' fail-closed decisions.

## Success Criteria

- [ ] A labeled skill-candidate case set, an LLM-as-judge, a runner, and a scorer exist for the skill judge, all built on the existing gate-eval framework.
- [ ] The scorer reports **accept-or-reject decision accuracy** and **quality-band agreement**, and renders a **fail-closed** pass/fail on whether the skill judge clears the quality bar.
- [ ] The skill judge's production behavior is unchanged; the eval is observe-only.
- [ ] Model selection is environment-configurable for both the gate-under-eval model and the judge model, with safe defaults.
- [ ] The case loader, judge wiring, and scorer have deterministic unit tests with a mocked LLM; no worker makes real model calls; the full eval is not run as a worker story.
- [ ] A runner script (consistent with existing eval scripts) and eval docs describe how to run the skill-judge eval; the capabilities drift check passes if a user-visible surface changed.
- [ ] The full build and test suite pass.
