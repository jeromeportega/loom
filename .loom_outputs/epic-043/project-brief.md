# Skill-Generator Rubric Eval — Gate-Eval Consumer

## The Problem

The **skill generator** runs on loom's non-agentic completion path. After a story finishes, it inspects that story's work — a work summary plus diff context — and decides whether the work produced a *reusable* skill, returning either `NONE` or a single `SKILL.md` body. Its candidate skills feed the skill pipeline, where the skill *judge* gates them.

Today nothing measures the skill generator's own behavior. It is described as the **final consumer** of the gate-eval framework still lacking a rubric eval; the lesson-extractor and opportunity-engine consumers already have one. Two failure modes therefore go unmeasured:

- **Spurious generation** — manufacturing a skill from trivial or one-off work that should have returned `NONE` (a restraint failure).
- **Low-quality generation** — emitting a poorly-formed, vague, overgeneralized, or non-reusable `SKILL.md` when it does generate (a quality failure).

Because the output is open-ended — when the generator *does* generate, there is no single correct `SKILL.md` — exact-match evaluation cannot work. The skill generator needs a **rubric-based** eval, mirroring the existing lesson-extractor and opportunity-engine rubric consumers.

## Target Users

- **Primary — the operator** running the offline eval harness. Wants a trustworthy, fail-closed signal of the skill generator's *proposal quality* and its *restraint*, runnable on demand.
- **Secondary — loom maintainers** modifying the skill generator or its prompt. Want a regression gate that catches drift toward over-generation or weak skills.
- **Anti-persona — the autonomous worker agent / CI.** The full eval makes real model calls and must **not** run as a worker story. Workers run only deterministic mocked-LLM tests; the operator runs the live eval.

## Proposed Solution

Add a new gate-eval consumer in its **own `skill-generator` directory**, built on the existing framework (case loader, runner, LLM-as-judge, scorer, fail-closed thresholded decision, env-configurable model selection) and reusing the **production skill generator unchanged**. The consumer wires its modules via direct imports through its own sub-barrel, adding at most a single re-export line to the top barrel — exactly as the reference consumers do. The eval is **observe-only**: it measures, it never alters production behavior.

The epic is structured **foundation-first** to eliminate the recurring merge conflict (below).

## Key Capabilities

1. **Case set** of representative completed-story inputs (work summary + diff context) across three buckets: clearly **skill-worthy** → expects a good `SKILL.md`; clearly **trivial / one-off** → expects `NONE`; and **borderline** cases. Each case is paired with rubric expectations — the right NONE-vs-generate call, and for generate cases the qualities a good skill must have (well-formed per the skill format, genuinely reusable, faithful to the actual work, not overgeneralized).
2. **Rubric-based LLM-as-judge** scoring (a) **decision correctness** — generate-vs-`NONE` matches what the work warranted — and (b) for generated skills, **skill quality** — well-formed, reusable, faithful, appropriately scoped. The judge explicitly **flags spurious generation** (skill manufactured from trivial work) and **low-quality / unfaithful** skills.
3. **Runner** over the production skill generator (reuse, not a reimplementation).
4. **Scorer** aggregating decision correctness and skill quality into metrics plus a **spurious-generation rate**, ending in a **fail-closed thresholded decision**.
5. **Deterministic mocked-LLM unit tests** for the case loader, the rubric-judge wiring, and the scorer — no worker makes real model calls.
6. **Runner script + eval docs** consistent with the existing eval scripts, describing how the operator runs it; capabilities drift check passes if any user-visible surface changes.

## Constraints

- **Observe-only.** Do not change the skill generator's production behavior. Reuse the existing framework and the production generator — no reimplementations.
- **Isolation.** New consumer in its own directory with its own sub-barrel via direct imports; **≤ 1 re-export line** added to the top barrel.
- **Foundation-story structure (mandatory).** A **single foundation story** first creates the consumer directory skeleton and **all** shared type/schema files — the case schema, the judge result types, and the consumer index/sub-barrel stub. **Every other story** (case set, judge, runner, scorer, tests, docs) **depends on the foundation story** and only adds its own non-shared files or appends within its own file. **No two stories may edit the same shared type or schema file in parallel.** This dependency must be stated explicitly so the foundation is serialized before all others.
- **Model selection** env-configurable with safe defaults.
- **Offline / operator-run.** The full eval is not a worker story; the operator runs it.
- **Do not weaken any guardrail.**

## Risks and Open Questions

- **Threshold calibration.** Pass/fail thresholds and the target **spurious-generation rate** are not yet specified. *Open question:* what rates constitute a fail-closed failure, especially given borderline cases that may legitimately split either way?
- **Borderline scoring semantics.** *Open question:* on borderline cases, is "correct" a single expected call, or a tolerance band the judge scores against? The rubric must define this precisely to keep scores stable.
- **Judge reliability on open-ended output.** A rubric LLM-judge over free-form `SKILL.md` carries variance. `[ASSUMPTION]` the lesson-extractor / opportunity-engine rubric-judge pattern is directly adaptable here and is the intended reference.
- **Faithfulness checking.** Judging "faithful to the actual work" and "not overgeneralized" requires the judge to receive the original work context, not just the generated skill. The case schema must carry both.
- **Shared-file boundary.** The foundation-story rule depends on a crisp, agreed list of which files are "shared." *Open question for the PM/architect:* enumerate the exact shared type/schema files the foundation owns vs. the per-story files.
- **Case sourcing.** `[ASSUMPTION]` cases are curated fixtures (synthetic or harvested completed-story snapshots), not pulled live at run time — keeping the eval deterministic in structure.
- **Format coupling.** `[ASSUMPTION]` "well-formed per the skill format" means the agentskills.io `SKILL.md` format loom already uses. Cases may need updating if that format or the generator's prompt changes.

## Success Criteria

- A **single foundation story** creates the consumer skeleton and **all** shared type/schema files; every other story declares a dependency on it, and **no shared type/schema file is edited by two stories in parallel**.
- The consumer exists in a **new `skill-generator` directory** with its **own sub-barrel** (direct imports; ≤ 1 re-export line in the top barrel), built on the existing framework, and contains:
  - a **case set** with rubric expectations covering skill-worthy, trivial-yields-`NONE`, and borderline cases;
  - a **rubric-based LLM-as-judge** scoring generate-vs-`NONE` decision correctness and generated-skill quality, and **flagging** spurious generation and low-quality/unfaithful skills;
  - a **runner** over the production skill generator;
  - a **scorer** producing decision-correctness and skill-quality metrics plus a **spurious-generation rate**, with a **fail-closed decision**.
- The skill generator's **production behavior is unchanged**; the eval is **observe-only**.
- **Model selection is environment-configurable** with safe defaults.
- The **case loader, judge wiring, and scorer have deterministic mocked-LLM tests**; the full eval is **not** run as a worker story.
- A **runner script** and **eval docs** describe how the operator runs it; the **capabilities drift check passes** if a user-visible surface changed.
- The **full build and test suite pass.**
