# Epic G — Intake Triage (right-size the request)

> Future / backlog loom epic. NOT build-day work. Makes loom usable for small,
> concise goals — not just multi-story initiatives — and saves resources by
> not over-planning small work.

## Problem

`loom epic <brief>` always runs the FULL pipeline (BriefRefiner → Analyst →
PM → Architect → optional QA → multi-story DAG → multiple workers → review →
integration → PR). For a typo, a one-field form change, or a single bug, that
is massive over-spend: serial planning calls, multi-story orchestration, and
wall-clock measured in hours for work that should take minutes. It also caps
adoption — nobody reaches for loom for a quick fix when it spins up a 7-story
epic.

## Idea

A classifier at the **front of planner mode** sizes the incoming request and
routes it to a right-sized pathway:

| Tier | Routing |
|---|---|
| **initiative** (multi-epic) | decompose into several epics (a program) |
| **epic** | current full pipeline |
| **story** | single-story lightweight plan, one worker, normal review — skip epic decomposition |
| **bug** | fast-path: one worker + `failure-investigator` skill, minimal/no planning, quick scoped review |

The classifier is cheap (one call); the real build is the **lighter story and
bug execution paths** that bypass parts of the pipeline.

## Misclassification handling

- Classifier emits **confidence**; low confidence escalates one tier up or
  asks the human at loom's existing approval gate (loom already gates — reuse).
- **Composes with Epic F** (`epic-f-adaptive-review.md`): even a bug fast-path
  gets review sized to the delivered diff's real complexity, so a too-light
  triage call is caught at review. G picks planning depth; F picks review
  depth.

## Reuse what loom already has

- **BriefRefiner** already inspects the incoming brief at intake — the natural
  home for the classifier.
- **Signal Scout (v3)** gets stronger: discovered opportunities come in all
  sizes; triage lets it auto-route a small found fix down the bug path instead
  of forcing every signal into a full epic.
- Epic/story are already first-class in the data model — the new part is
  detecting granularity at intake and the bypass paths.

## Done means

- An incoming request is routed to the correct tier (bug/story/epic/
  initiative), with the choice + confidence recorded in a decision trace.
- The bug and story paths demonstrably **skip the full planning pipeline**
  (measurably fewer planning calls / faster) vs. the epic path.
- Low-confidence/ambiguous requests escalate or hit the human gate — never
  silently under-scoped.
- Tests for the classifier and each routing path; suite green.
- `docs/capabilities.md` updated.

## Non-goals

- Build-day scope (loom harness work).
- Removing the full epic path — it stays for genuine epics/initiatives.
- Auto-executing bug-path work without loom's normal guardrails + gate.
