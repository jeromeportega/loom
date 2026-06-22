# Skill-Generator Rubric Eval — Gate-Eval Consumer

## Overview

The skill generator runs on loom's non-agentic completion path: after a story finishes, it inspects that story's work (a work summary plus diff context) and decides whether the work warrants a *reusable* skill, returning either `NONE` or a single `SKILL.md` body. Its candidate skills feed the skill pipeline, where the skill judge gates them. Today nothing measures the skill generator's own behavior, leaving two failure modes unmeasured: **spurious generation** (manufacturing a skill from trivial or one-off work that should have returned `NONE` — a restraint failure) and **low-quality generation** (emitting a vague, overgeneralized, or non-reusable `SKILL.md` — a quality failure). Because the output is open-ended, exact-match evaluation cannot work. This PRD specifies a new **rubric-based gate-eval consumer** for the skill generator — the final consumer of the gate-eval framework still lacking a rubric eval — mirroring the existing lesson-extractor and opportunity-engine rubric consumers. The eval is **observe-only**: it measures, it never alters production behavior.

## Goals

1. **Trustworthy restraint + quality signal.** Give the operator an on-demand, fail-closed eval that scores both the skill generator's decision correctness (generate-vs-`NONE`) and its generated-skill quality. *Metric:* the eval produces decision-correctness, skill-quality, and spurious-generation-rate metrics and ends in a single fail-closed pass/fail decision.
2. **Regression gate against drift.** Let maintainers catch drift toward over-generation or weak skills when they change the generator or its prompt. *Metric:* re-running the eval on an unchanged generator reproduces a stable pass; a deliberately over-generating change flips it to fail via the spurious-generation rate.
3. **Zero production impact + strict isolation.** Reuse the existing framework and the production generator unchanged. *Metric:* skill-generator production code is byte-unchanged, and at most **one** re-export line is added to the top barrel.

## User Stories

- **As the operator** running the offline eval harness, I want to run the skill-generator eval on demand and get a fail-closed verdict, so that I can trust a single signal about the generator's proposal quality and restraint. *(Must)*
- **As a loom maintainer** modifying the skill generator or its prompt, I want a regression gate that flags drift toward over-generation or weak skills, so that I catch quality regressions before merge. *(Must)*
- **As the autonomous worker agent / CI** (anti-persona), I must **not** trigger real model calls; I run only the deterministic mocked-LLM tests, so that worker stories stay deterministic and cheap. *(Must — constraint)*

## Functional Requirements

- **FR-1 — Isolated consumer directory.** The eval lives in its own new `skill-generator` directory with its own sub-barrel, wired via direct imports, exactly as the reference (lesson-extractor / opportunity-engine) consumers do. At most **one** re-export line is added to the top barrel.
- **FR-2 — Case set with rubric expectations.** A curated case set of completed-story inputs (work summary + diff context) spans three buckets: clearly **skill-worthy** (expects a good `SKILL.md`), clearly **trivial / one-off** (expects `NONE`), and **borderline**. Each case carries rubric expectations: the correct `NONE`-vs-generate call, and for generate cases the qualities a good skill must have (well-formed per the skill format, genuinely reusable, faithful to the actual work, appropriately scoped). The case schema carries **both** the original work context and the expectations, so faithfulness/over-generalization can be judged.
- **FR-3 — Rubric LLM-as-judge.** A rubric-based judge scores (a) **decision correctness** — generate-vs-`NONE` matches what the work warranted — and (b) for generated skills, **skill quality** (well-formed, reusable, faithful, appropriately scoped). The judge explicitly **flags spurious generation** (skill manufactured from trivial work) and **low-quality / unfaithful** skills. Borderline-case scoring semantics are defined precisely (single expected call vs. tolerance band) so scores stay stable.
- **FR-4 — Runner over the production generator.** A runner drives the **production skill generator unchanged** over each case — reuse, not a reimplementation.
- **FR-5 — Scorer + fail-closed decision.** A scorer aggregates decision-correctness and skill-quality metrics plus a **spurious-generation rate**, and ends in a **fail-closed thresholded decision** (ambiguous or missing results fail rather than pass).
- **FR-6 — Deterministic mocked-LLM tests.** The case loader, the rubric-judge wiring, and the scorer have deterministic mocked-LLM unit tests. No test and no worker story makes real model calls.
- **FR-7 — Runner script + docs + drift check.** A runner script and eval docs, consistent with the existing eval scripts, describe how the operator runs the eval. The capabilities drift check passes if any user-visible surface changed.
- **FR-8 — Foundation-first structure.** A **single foundation story** first creates the consumer directory skeleton and **all** shared type/schema files (case schema, judge result types, consumer index/sub-barrel stub). Every other story (case set, judge, runner, scorer, tests, docs) **declares an explicit dependency** on the foundation story and only adds its own non-shared files or appends within its own file. No two stories edit the same shared type/schema file in parallel.

## Non-Functional Requirements

- **NFR-1 — Observe-only.** The eval must not change the skill generator's production behavior; the generator is consumed unchanged.
- **NFR-2 — Env-configurable model selection.** Model selection is environment-configurable with safe defaults, matching the framework's existing pattern.
- **NFR-3 — Offline / operator-run.** The full eval makes real model calls and runs only on demand by the operator — never as a worker story or in CI.
- **NFR-4 — No weakened guardrails.** No existing guardrail may be weakened.

## Epics

This PRD is delivered as **one epic** — *Skill-Generator Rubric Eval consumer* — structured foundation-first (FR-8) so the shared type/schema files are serialized before all parallel work.

## Out of Scope

- Any change to the skill generator's production behavior or prompt, or to the skill judge / skill pipeline.
- Reimplementing the gate-eval framework or the generator; only reuse is in scope.
- Running the full (real-model) eval as a worker story or in CI.
- Pulling cases live at run time — `[ASSUMPTION]` cases are curated fixtures (synthetic or harvested completed-story snapshots), not fetched at runtime.
- Final numeric **threshold calibration.** Exact pass/fail thresholds and the target spurious-generation rate remain an open question for the PM/architect; this epic establishes the metrics and the fail-closed decision mechanism, with initial defaults treated as `[ASSUMPTION]` placeholders to be tuned.
