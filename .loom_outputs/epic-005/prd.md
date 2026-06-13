# Loom Flywheel — Self-Learning from Finished Epics (PRD)

## Overview

Loom finishes epics but learns nothing from them: decision traces, review summaries, retry/handoff history, and audit logs evaporate the moment an epic reaches terminal state, so every new epic starts as naive as the last. Today, closing that gap requires a human to run retrospectives by hand and feed insights back into worker context — exactly the recurring toil loom exists to eliminate. The Flywheel epic closes the self-improvement loop in three reuse-first stages — auto-retrospective on completion, lesson application into future workers, and explicit human-triggered self-proposal — surfaced through a read-only flywheel view. The unifying principle is non-negotiable: **loom learns and suggests; humans decide and execute.** No scheduler, no auto-trigger, no auto-apply, no self-execution.

## Goals

1. **Eliminate manual retrospective toil.** Every epic reaching `done` or `failed` auto-generates lessons with zero human action. *Metric:* 100% of terminal epics with usable telemetry persist ≥1 lesson; 0 finalize failures attributable to the retro.
2. **Close the learning loop to workers.** Lessons demonstrably reach the agents that consume them. *Metric:* ≥1 persisted lesson is injected into a later worker's assembled prompt and recorded as applied (`applied_as`/`applied_ref` set).
3. **Keep humans in control.** Every proposal and policy change is a gated suggestion. *Metric:* a structural test proves no auto-trigger, auto-approve, or auto-apply path exists; proposed epics stay `planned` + `manual` until explicit approval.
4. **Hold cost discipline.** *Metric:* exactly one batched LLM call per retro and per proposal (asserted by test; LLM injectable and stubbed).

## User Stories

- **(Must)** As the loom operator, I want each completed epic to automatically produce lessons from its own telemetry, so that I stop running retrospectives by hand.
- **(Must)** As the loom operator, I want lessons fed into future workers automatically, so that the next epic avoids repeating prior mistakes without me hand-wiring context.
- **(Must)** As the loom operator, I want auto-retro to never block or fail epic finalization, so that learning is strictly additive and safe.
- **(Should)** As the loom operator, I want loom to draft a next-epic proposal only when I explicitly ask, landing it as a gated, frozen `planned` epic in my inbox, so that I retain a hard approval gate.
- **(Should)** As the loom operator, I want loom to record policy *suggestions* without ever mutating policy, so that I decide every governance change.
- **(Should)** As the loom operator, I want a read-only flywheel view of lessons learned (and where applied) plus current self-proposals, so that I can see the loop working at a glance.
- **(Secondary)** As a future loom worker, I want applicable lessons present in my prompt, so that I act on prior learning.

## Functional Requirements

- **FR-1** — `lesson-extractor` is a real LLM-backed handler (mirroring the reviewer-skill factory / `SkillGenerator` pattern): it loads `SKILL.md` as a cached system prefix and sends the epic's telemetry as the user message.
- **FR-2** — Handler-owned fields (e.g. `source`/`epic_id`) MUST be injected **before** the zod parse against the existing `Lesson` schema (`findings/lesson.ts`). A regression test using a field-less model response must prove this. (Reviewer-bug regression guard.)
- **FR-3** — On an epic reaching `done` *or* `failed`, an auto-retro hooks the EpicFinalizer/Supervisor finalize path, gathers that epic's telemetry (decision traces, review summary, handoff, audit log), makes exactly one batched `lesson-extractor` call, and persists the resulting lessons.
- **FR-4** — Auto-retro is best-effort and MUST never block or fail finalization. On LLM-unavailable or malformed output: one repair attempt, then skip-with-audit-note.
- **FR-5** — An epic with zero usable telemetry produces zero lessons cleanly (no error). *[ASSUMPTION] the empty-input contract returns an empty lesson set, not a failure — confirm with architecture.*
- **FR-6** — A new `LessonStore` persists lessons to a schema v18 `lessons` table with columns: `epic_id, category, observation, root_cause, general_rule, evidence, applied_as, applied_ref, created_at`. Table creation is additive (`CREATE TABLE IF NOT EXISTS`) and backward-compatible; pre-v18 DBs auto-create.
- **FR-7** — Applicable lessons are injected into a future worker's assembled prompt through the existing operator-guidance / context-notes seam, and the lesson is recorded as applied (`applied_as`, `applied_ref`).
- **FR-8** — Lesson-to-worker relevance is determined by matching a lesson's `general_rule`/`category` to the target epic/story area. *[ASSUMPTION] a simple area/category keyword match suffices for v4.0; semantic matching is out of scope — architect to pin the mechanism (riskiest under-specified seam).*
- **FR-9** — Policy-suggestion mode writes a recorded suggestion artifact / audit row (`applied_as = 'policy_suggestion'`) that never mutates policy.
- **FR-10** — `proposeNextEpic()` runs only on explicit operator action. It combines top-ranked lessons with top open opportunities (`OpportunityStore`) into a brief, runs it through the existing brief gate and Planner/BriefRefiner, and lands a real `planned` + `manual` epic marked `proposed_by = 'loom'`, frozen until human approval. *[ASSUMPTION] ranking = recency + category frequency; no scoring model.*
- **FR-11** — `proposeNextEpic()` is exposed via CLI (`loom propose`), a mission-control button, and an MCP tool; the produced proposal surfaces in `GET /api/inbox` and stays `planned` until explicitly approved.
- **FR-12** — `GET /api/lessons` serves federated, read-only flywheel data; a mission-control board renders lessons (with where each was applied) and current self-proposals, including a defined empty state.
- **FR-13** — `docs/capabilities.md` is updated in the same change: add the flywheel/lessons surfaces and move any now-shipped "what loom does NOT do" entry into the appropriate table.

## Non-Functional Requirements

- **NFR-1 (Safety)** — Finalize is sacred: the retro path is strictly best-effort and may never propagate an error into epic finalization (covered by FR-4).
- **NFR-2 (Cost)** — Exactly one batched LLM call per retro and per proposal; the LLM dependency is injectable and stubbed in all tests.
- **NFR-3 (Gating)** — No scheduler, daemon, auto-trigger, auto-apply, or auto-execute anywhere in the feature; a structural test must prove these paths do not exist.
- **NFR-4 (Schema compatibility)** — Bump `Database.ts` `SCHEMA_VERSION` 17 → 18; migration is idempotent and additive; pre-v18 databases upgrade transparently.
- **NFR-5 (Web/test invariants)** — Every new web route is covered by a real-`createApp` test (epic-003 orphaned-route lesson); all new mutations are token-gated and audit-logged.
- **NFR-6 (Build health)** — `npm run build` and `npm run test` are green across all workspaces.

## Epics

This PRD is delivered as **one** epic — the v4.0 Flywheel stretch epic. Its stages are priority-ordered, not separable shipping units. If a time/cost ceiling is hit, ship in strict priority and stop: (1) auto-retro + lesson persistence → (2) guidance injection → (3) self-proposal → (4) flywheel view. Stages 1–2 alone satisfy the "loom learns" bar.

- **epic-001 — Loom Flywheel: self-learning from finished epics** (Must) — real lesson extraction, auto-retro on terminal state, lesson persistence (schema v18), guidance injection, policy-suggestion mode, explicit self-proposal, and the read-only flywheel view.

## Out of Scope (V1)

- Auto-applying policy changes.
- Auto-triggering self-proposal, or any scheduler/daemon/auto-execution of proposed epics.
- Model-level or fine-tuning learning — this feature is file/DB/skill/prompt-level only.
- Semantic lesson-relevance matching (keyword/area match only for v4.0).
- Lesson dedup or retention policy — *[ASSUMPTION] unbounded append is acceptable at v4.0 scale; flag if the flywheel view becomes noisy.*
- Skill-generation as a lesson-application mode — optional/stretch; policy-suggestion is the required second mode.
- Perfect lesson quality — closing the loop end-to-end beats lesson polish.
