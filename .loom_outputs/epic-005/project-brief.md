# Loom Flywheel — Self-Learning from Finished Epics

## The Problem

Loom completes epics but learns nothing from them. Every finished epic leaves behind rich telemetry — decision traces, review summaries, retry and handoff history, audit logs — yet that signal evaporates the moment an epic reaches terminal state. The next epic starts as naive as the last. Improvement today requires a human to run retrospectives manually, read the telemetry, and hand-feed insights back into worker context. For a capped-usage, high-autonomy operator, that human-in-the-loop retrospective is exactly the kind of recurring toil loom exists to eliminate.

Two prior capabilities set the stage but stop short: v3.0 Signal Scout added *discovery* (signals → opportunities → gated scoping), and epic-001 shipped a `lesson-extractor` skill — but only as a callable stub with no real handler. The learning loop is wired but dead.

## Target Users

- **Primary — the loom operator** (Jerome / any solo-or-small-team maintainer running loom on their own repo). Wants each completed epic to make the next one measurably better without manually running retros, while retaining a hard approval gate before any proposed work executes.
- **Secondary — future loom workers.** They are the *consumers* of learning: applicable lessons must reach their assembled prompts so they avoid repeating prior mistakes.
- **Anti-persona — the operator who wants an autonomous daemon.** Flywheel deliberately does **not** serve anyone seeking a self-triggering, self-approving, self-executing system. Every proposal and policy change is a suggestion that waits for an explicit human decision.

## Proposed Solution

Close the self-improvement loop in three stages, each reusing existing loom machinery rather than inventing new seams:

1. **Auto-retrospective.** On epic completion (`done` *or* `failed`), loom gathers that epic's telemetry, makes one batched `lesson-extractor` LLM call, and persists structured lessons to a new `lessons` table. The retro is best-effort — it can never block or fail the epic's finalization.
2. **Lesson application.** Applicable lessons are injected into future workers' prompts through the existing operator-guidance / context-notes seam, and recorded on the lesson as applied. A second mode writes policy *suggestions* (humans change policy — loom never auto-applies).
3. **Self-proposal.** On explicit operator action only, loom combines its top-ranked lessons with top open opportunities into a brief, runs it through the existing brief gate and planner, and lands a real `planned` + `manual` epic in the decision inbox — marked as proposed by loom, frozen until a human approves.

A read-only **flywheel view** in mission control surfaces lessons learned (and where each was applied) plus current self-proposals.

The unifying principle: **loom learns and suggests; humans decide and execute.** No scheduler, no auto-trigger, no auto-apply, no self-execution.

## Key Capabilities

1. **Real lesson extraction** — make `lesson-extractor` a genuine LLM-backed handler (mirroring the reviewer-skill factory pattern), loading SKILL.md as a cached system prefix, sending epic telemetry as the user message, parsing to the existing `Lesson` schema.
2. **Auto-retro on terminal state** — hook the EpicFinalizer/Supervisor finalize path; one batched call per retro; persist lessons via a new `LessonStore`.
3. **Lesson persistence** — schema v18 `lessons` table (epic_id, category, observation, root_cause, general_rule, evidence, applied_as, applied_ref, created_at), additive and backward-compatible.
4. **Guidance injection** — at least one persisted lesson demonstrably reaches a later worker's assembled prompt via the existing guidance/context seam.
5. **Policy suggestion mode** — a recorded suggestion artifact/audit row that never mutates policy.
6. **Explicit self-proposal** — `proposeNextEpic()` exposed via CLI (`loom propose`), a mission-control button, and an MCP tool, producing a gated `planned` + `manual` epic.
7. **Flywheel view** — `GET /api/lessons` (federated, read-only) plus a board rendering lessons and self-proposals, with an empty state.

## Constraints

- **Reuse over reinvention** (verified on main): `lesson-extractor` skill, `Lesson` schema (`findings/lesson.ts`), decision-traces / review-summary / handoff / audit-log telemetry sources, Planner + BriefRefiner + EpicStore lifecycle, `OpportunityStore`, the guidance/context-notes injection seam, and the `SkillGenerator`/`SkillJudge` path. Do not redefine these.
- **Reviewer-bug regression guard:** handler-owned fields (e.g. `source`) MUST be injected *before* the zod parse. The reviewer handler validated before stamping and every finding failed — do not repeat.
- **Finalize is sacred:** auto-retro must never block or fail epic completion. LLM unavailable or malformed → one repair attempt, then skip-with-audit-note.
- **Cost discipline:** exactly one batched LLM call per retro and per proposal (capped-usage operator). LLM is injectable and stubbed in tests.
- **Gating is non-negotiable:** proposed epics MUST be `planned` + `manual`; policy suggestions never auto-apply; no scheduler/daemon/auto-trigger/auto-execute anywhere.
- **Schema:** bump `Database.ts` `SCHEMA_VERSION` 17 → 18, idempotent `CREATE TABLE IF NOT EXISTS`; pre-v18 DBs auto-create.
- **Testing/web invariants:** every new web route covered by a real-`createApp` test (the epic-003 orphaned-route lesson); all new mutations token-gated and audit-logged.
- **Docs:** update `docs/capabilities.md` (add flywheel/lessons surfaces; move any relevant "what loom does NOT do" entry). `npm run build` + `npm run test` green across all workspaces.

### Scope guardrail (this is the v4.0 *stretch* epic)

If a time/cost ceiling is hit, ship in strict priority and stop: (1) auto-retro + lessons persistence → (2) guidance injection → (3) self-proposal → (4) flywheel view. Items 1–2 alone demonstrate "loom learns."

**Explicitly out of scope:** auto-applying policy changes; auto-triggering self-proposal or any scheduler; auto-executing proposed epics; model-level/fine-tuning learning (this is file/db/skill/prompt-level only); perfect lesson quality (loop existing end-to-end beats lesson polish).

## Risks and Open Questions

- **Lesson relevance matching.** Capability #4 hinges on deciding *which* lessons apply to *which* future worker. The brief specifies matching a lesson's `general_rule` to an epic/story area but not the matching mechanism. `[ASSUMPTION]` a simple area/category keyword match suffices for v4.0; semantic matching is out of scope. The PM/architect should pin this down — it is the riskiest under-specified seam.
- **Lesson ranking for self-proposal.** "Top-ranked lessons" and "top open opportunities" need a defined ordering. `[ASSUMPTION]` recency + category frequency is acceptable for v4.0; no scoring model implied.
- **Retro telemetry completeness.** A `failed` epic may have sparse or malformed telemetry. The skip-with-audit path covers LLM failure, but `[ASSUMPTION]` an epic with zero usable telemetry should produce zero lessons cleanly (not an error) — confirm the empty-input contract.
- **Lesson table growth / dedup.** No dedup or retention policy is specified. `[ASSUMPTION]` unbounded append is acceptable at v4.0 scale; flag if the flywheel view becomes noisy.
- **"At least one MORE application mode."** Policy-suggestion is the required second mode; skill-generation is explicitly optional/stretch. Confirm policy-suggestion alone satisfies the success bar.

## Success Criteria

- `lesson-extractor` is a real LLM-backed handler (stubbed in tests) that parses lessons, with handler-owned fields injected before parse — proven by a regression test using a field-less model response.
- On an epic reaching `done`/`failed`, an auto-retro persists ≥1 lesson to the `lessons` table from that epic's real telemetry (test with stubbed LLM + seeded telemetry), and finalize never fails due to the retro.
- At least one persisted lesson is injected into a subsequent worker's assembled prompt via the guidance/context seam (test). A `policy_suggestion` lesson records a suggestion without changing policy.
- `proposeNextEpic()` (explicit trigger) produces a real `planned` + `manual` epic marked `proposed_by='loom'`, passes the brief gate, surfaces in `GET /api/inbox`, and stays `planned` until explicit approval (test). A structural test proves no auto-trigger/auto-approve path exists.
- `GET /api/lessons` serves the flywheel data (real-`createApp` test); the board renders lessons + self-proposals with an empty state.
- `docs/capabilities.md` updated; `npm run build` + `npm run test` green across all workspaces.
