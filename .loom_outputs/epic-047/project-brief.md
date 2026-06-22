# Standalone Story Routing for Story-Sized Briefs

## The Problem

When `intake_routing` is enabled, loom already does the hard part correctly: a story-sized brief is classified as a story, and the planner is instructed to produce a single cohesive story. But the pipeline then wraps that story inside a one-story epic and reports it as **"1 epic, 1 story."** The result is real waste and a misleading presentation:

- **Ceremony that earns nothing** — a heavy epic-level PRD and a multi-story decomposition pass run for a unit of work that is, by the classifier's own verdict, a single story.
- **A misrepresented artifact** — the operator submitted story-sized work and receives an `epic-NNN`. Status output, the PR structure, and the mental model are all epic-shaped when they should be story-shaped.

A story-sized unit of work should be a **first-class standalone story**: lightweight planning, a direct dispatch, and a single pull request — presented as a story, not an epic-with-one-story.

## Target Users

- **Primary — loom operators** submitting story-sized briefs under `intake_routing: advisory` or `confirm`. They get a faster, honestly-labeled path from brief to a single PR.
- **Secondary — loom maintainers** working on the planning pipeline, who must keep the epic path unchanged and the new branch cleanly isolated.
- **Anti-persona — operators submitting genuinely epic-sized work.** Their experience must not change at all. This feature is invisible to them, and any operator who overrides a story *up* to epic (in `confirm` mode) is explicitly routed back to the full epic pipeline.

## Proposed Solution

Introduce a **standalone-story path** in the planner. When `intake_routing` is `advisory` or `confirm` **and** the effective verdict — after any operator override — is `size=story`, loom branches away from epic decomposition:

1. **Skip the epic ceremony** — no multi-story breakdown, no heavy epic-level PRD.
2. **Produce one story directly** from the refined brief: title, description, acceptance criteria, and the technical notes a single story needs to be implemented well.
3. **Dispatch through the existing story machinery** — worker, branch, worktree, and integration gate, unchanged.
4. **Finalize as a single pull request** for that story.
5. **Present it as a standalone story** (a story id) in user-facing output and `loom status` — never as `epic-NNN with 1 story`.

The architect chooses the cleanest implementation: a true standalone-story record with its own lightweight dispatch/finalize path, **or** a minimal internal wrapper that is presented and finalized as a single standalone story. Either is acceptable **only if** the user-facing experience, the lightweight planning, and the single-PR outcome are genuinely standalone-story.

## Key Capabilities

1. **Route detection** — branch to the standalone path exactly when `intake_routing ∈ {advisory, confirm}` and effective `size=story` (post-override).
2. **Lightweight single-story planning** — generate title, description, acceptance criteria, and technical notes from the refined brief, with no epic PRD and no decomposition pass.
3. **Reuse story execution** — dispatch via the existing worker / branch / worktree / integration-gate flow without modification.
4. **Single-PR finalize** — finalize the standalone story to one pull request.
5. **Standalone presentation** — output and status show a story id and story framing, not an epic.
6. **Full provenance** — preserve decision traces, audit entries, and logs for the standalone story exactly as stories have them today.
7. **Docs currency** — update `docs/capabilities.md` to describe standalone-story routing and pass the capabilities drift check.

## Constraints

- **Narrow trigger.** The path applies *only* when `intake_routing` is `advisory` or `confirm` and effective size is `story`. No other configuration is touched.
- **`intake_routing: off` is frozen.** Behavior must be **byte-identical** to today — the full epic pipeline — and this is proven by a test.
- **Epic size is unchanged.** When effective size is `epic`, including a `confirm`-mode override from story → epic, the full epic pipeline runs exactly as today.
- **No guardrail weakening.** The standalone story passes through the integration gate and the same guardrails as any story.
- **Classifier unchanged in placement.** Keep the classifier on the non-agentic path; keep classifying the *refined* brief.
- **Maximize reuse.** Reuse existing story-execution, integration-gate, and finalize-to-PR machinery rather than building parallel infrastructure.

## Risks and Open Questions

- **Do stories exist without an epic parent today?** `[ASSUMPTION]` Stories are currently always children of an epic; a standalone story may require a new id scheme or null-parent handling in the state model. This is the central design question the architect must resolve, and it likely decides "true standalone record" vs. "minimal internal wrapper."
- **Status and observability surfaces may assume an epic parent.** `[ASSUMPTION]` `loom status` and trace/audit rendering may need to handle a parentless story id without regressing epic display.
- **Proving "byte-identical."** `[ASSUMPTION]` The off-path equivalence test is best expressed as a snapshot/golden test over planning output; the team should confirm a stable, deterministic comparison point exists.
- **Override semantics edge case.** A `confirm`-mode override of story → epic must route to the epic pipeline; the reverse (epic → story override, if permitted) must route to the standalone path. Confirm both directions are handled by the effective-verdict logic.
- **PR and branch naming.** `[ASSUMPTION]` Branch/PR naming conventions may encode an epic id; standalone stories need a coherent naming scheme that the finalize machinery accepts.

## Success Criteria

1. With `intake_routing` `advisory` or `confirm` and effective `size=story`, loom produces a **single standalone story** with lightweight planning — no multi-story epic breakdown, no heavy epic PRD — dispatches it through the existing story machinery, and finalizes it as **one pull request**.
2. The standalone story is **presented in output and `loom status` as a story** (a story id), not as an epic with one story.
3. The standalone story carries **full decision-trace, audit, and log provenance**, equivalent to any story today.
4. **Guardrails and the integration gate apply unchanged** to the standalone story.
5. With `intake_routing: off`, planning is **byte-identical to today** and still produces the full epic pipeline — **proven by a test**.
6. When effective size is `epic` (including a `confirm`-mode story → epic override), the **full epic pipeline runs as today**.
7. `docs/capabilities.md` **documents standalone-story routing** and the capabilities **drift check passes**.
8. The **full build and test suite pass**.
