---
name: loom-skill-curator
description: Before calling loom_plan_epic, decide which loom skills the brief actually needs and apply their lenses — instead of blasting every skill at the Analyst, pick the few that fit and enrich the brief yourself.
---

# Skill Curator

When the user wants loom to plan an epic, do not just forward their brief
verbatim. The loom planner is sharper when the brief that reaches it is
already shaped — but only by the right disciplines, not all of them. Your job
is to curate.

This skill exists because the alternative — having loom's planner inject
every keyword-matched skill into the Analyst — over-planned narrow briefs
into 4–6 epics and 17–26 stories. The lesson: skill *application* belongs at
the orchestrator (you), not the planner.

## How you work

1. **Read the brief and judge its scope** before reaching for tools. Is this
   a one-line tweak, a focused feature, a multi-story epic? The amount of
   curation you apply should scale to scope — narrow briefs need 0–1 lenses,
   broad ones need 2–3. Never more than 3 — that was the old failure mode.

2. **Know the bundled catalog** — loom ships a fixed set of skills (listed
   below). Treat the catalog as the menu, not the floor.

3. **Match disciplines to the work, not keywords to keywords.** A brief
   about *authentication* genuinely benefits from `loom-edge-case-review`
   (auth has many failure modes) even if the brief never uses the word
   "edge." A brief about a *settings panel* benefits from
   `loom-ux-design`. A brief about a *rename* benefits from nothing.

4. **Apply the lenses by enriching the brief.** Do not pass skill names to
   loom — loom has no way to consume them post-planning. Instead, read the
   skill body via the chat UI (the SkillStore loads them; you can ask "show
   me loom-edge-case-review") and write the brief in a way that already
   reflects its discipline. For an auth brief with edge-case-review applied,
   that means listing the failure modes (expired tokens, concurrent sessions,
   partial logout) as explicit constraints. For UX design, list the states
   to handle. The brief is the spec; the spec carries the lens.

5. **Then call `loom_plan_epic` with the enriched brief.** The planner
   plans bare — no skill injection on its side. The brief you wrote IS the
   shaping.

## Which skills usually apply

The bundled library, with a sense of when each earns its place:

- `loom-brainstorm` — when the brief frames a *problem* and the solution
  shape is unclear ("we need to handle X better"). Skip when the user
  already named the implementation.
- `loom-plan-review` — when the brief is medium-to-large and the user
  needs the plan to actually ship. Skip for one-line tweaks.
- `loom-edge-case-review` — when the work touches failure-prone surfaces:
  auth, payments, concurrency, external integrations, migrations. Skip for
  internal refactors and pure UI changes.
- `loom-ux-design` — when the work has a UI surface (a screen, a flow, a
  control). Skip for backend-only or CLI work.
- `loom-ux-designer` — the persona; invoke it interactively (the user can
  chat with the designer) rather than auto-applying.
- `loom-code-review` — worker-time, not planning-time. The Supervisor
  injects it for relevant story workers.
- `loom-tech-writer` — worker-time, applied when stories touch docs.

## Anti-patterns

- **Do not apply every skill that name-matches.** That is the keyword
  matcher's failure; it is why this skill exists.
- **Do not apply review-time skills at planning time.** `loom-code-review`
  reviews code, not briefs. Injecting it during planning produces
  pseudo-review prose in the spec.
- **Do not pad a small brief with lenses to make it look thorough.**
  Loom's eval flagged exactly this: small briefs over-planned into many
  epics. If the brief is a one-liner, plan it as a one-liner.

## What loom does after you call loom_plan_epic

The planner runs Analyst → PM → Architect on your enriched brief — bare,
no skill injection. The Supervisor still injects worker-time skills
(loom-code-review, loom-edge-case-review when the story warrants) at
dispatch. You shape the plan; the supervisor shapes the execution. Clear
separation.
