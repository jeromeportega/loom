# Loom Web Dashboard — Observability Spine Focus

## The Problem

The loom web dashboard is loom's **observability surface** — the CLI drives loom; the dashboard is where operators watch it work. An audit of the dashboard found three classes of defect that undermine that mission:

1. **A misleading stub.** The Autonomy tab appears in the navigation but is an empty shell, implying a capability the dashboard does not deliver.
2. **Premature surface area.** The Fleet and Inbox tabs are multi-project features shown before they are ready, cluttering the navigation and setting false expectations.
3. **Wired backends with no front door.** Three read endpoints are fully built and serving data — decision traces (per-agent), per-story audit, and a skills view — yet have no UI. The most valuable observability data loom collects is invisible to operators.

Compounding this, the dashboard offers mutation controls (approve, reject, stop, kill, retry, archive) even when running in **read-only mode**, where they silently fail — eroding operator trust in every control on the page.

## Target Users

- **Primary — the loom operator.** Drives loom from the CLI and uses the dashboard to observe epics, stories, live logs, planning streams, and now the reasoning, audit, and skills data behind agent decisions. Needs the dashboard to honestly reflect what loom is doing and what controls actually work.
- **Secondary — the maintainer/contributor.** Needs Fleet/Inbox code preserved and cleanly restorable, and the navigation kept coherent as features mature.
- **Anti-persona — the multi-project fleet manager.** Not served by this change. Fleet/Inbox are the seeds of that future workflow, but it is explicitly out of scope now; this work hides rather than builds for them.

## Proposed Solution

A focused frontend change that prunes what misleads, hides what is premature, and surfaces what is already built — concentrating the dashboard on its high-value observability spine. No new backend capability is created; the three existing read endpoints are reused as-is. Read-only mode is made honest. The autonomy, fleet, and inbox **capabilities** (routes, CLI, view files, tests) are all preserved — only the Autonomy *stub tab* is deleted; Fleet and Inbox are *temporarily hidden* from the nav.

## ⚠️ Critical Structuring Constraint (carry into PRD/epic breakdown)

**The frontend work MUST be a single story.** Every frontend change below edits the same navigation and tab-bar region of one file — `packages/loom-web/public/index.html` — plus a small number of closely-related frontend files. A prior attempt split this into **seven parallel stories that all edited the same navigation region and deterministically conflicted on integration, blocking the epic.**

Therefore the epic has exactly **three stories**:

- **Story 1 — Cohesive frontend change (ALL of Key Capabilities 1–6), one worker.** Do NOT split index.html or tab-bar edits across parallel stories.
- **Story 2 — Documentation.** Independent file (`docs/capabilities.md`).
- **Story 3 — Build & test verification.** Independent, runs last.

Stories 2 and 3 are separable only because they touch genuinely independent files. The PM agent must not re-decompose the frontend work.

## Key Capabilities

The frontend story must deliver all six together:

1. **Remove the Autonomy tab** — delete its nav registration and its view file. Keep the POST autonomy route and `loom autonomy` CLI command exactly as-is.
2. **Hide Fleet and Inbox tabs** — unregister from the visible tab bar only. Keep their server routes, view files, and tests intact, with a clear comment at the registration site explaining the intentional hide and how to re-enable.
3. **Per-story decision traces** — add a read-only, collapsible reasoning section to the epic detail view, fed by the existing per-agent traces endpoint (no backend change).
4. **Per-story audit** — add a read-only, collapsible audit section to the epic detail view, fed by the existing audit endpoint.
5. **Skills view** — add a tab listing discovered skills with lifecycle and track record from the existing skills endpoint, with drill-down to per-skill history from the existing per-skill history endpoint. Register it in the tab bar **in place of** the removed/hidden tabs so navigation stays coherent.
6. **Honest read-only mode** — when read-only, disable or hide mutation buttons (approve, reject, stop, kill, retry, archive) with a brief explanation rather than silently-failing controls. All read/observability surfaces remain fully functional.

## Constraints

- **No server route behavior changes** except the minimum needed to expose read-only mode to the client.
- **Reuse existing endpoints as-is** — traces, audit, skills, and per-skill history endpoints already exist and must not be modified.
- **Preserve all capabilities** — do not remove Fleet, Inbox, or Autonomy server routes or their underlying functionality. This is a navigation/frontend change plus one stub removal.
- **Keep the observability spine fully intact** — list, detail, live log panes, planning stream, planning artifacts.
- **Do not weaken any guardrail.**
- **`docs/capabilities.md` must stay current** (project invariant) and pass the drift check.

## Risks and Open Questions

- `[ASSUMPTION]` The read-only mode flag is already known to the server and can be passed to the client without altering route *behavior* — only its response surface. If no such flag exists, exposing it is a small, in-scope addition; confirm during implementation.
- `[ASSUMPTION]` The traces, audit, skills, and per-skill history endpoints return shapes directly renderable by the frontend without transformation. If reshaping is needed, it stays client-side; no backend edits.
- `[ASSUMPTION]` "Closely-related frontend files" beyond `index.html` are limited (e.g., shared JS/CSS and the per-tab view files). The single-story scope assumes this set is small and co-edited by one worker.
- **Open:** Where exactly should the Skills tab sit in nav order relative to the surviving tabs? Brief says "in place of the removed and hidden tabs" — worker should choose the most coherent slot.
- **Open:** For Fleet/Inbox, is hiding best done by commenting out the registration or gating behind a feature flag? Either satisfies "intact and easily restorable"; worker picks the cleaner option and documents it at the registration site.

## Success Criteria

- The Autonomy tab is absent from dashboard navigation and frontend, **and** the autonomy route and `loom autonomy` CLI command still work.
- Fleet and Inbox are not shown in navigation, **and** their routes, view files, and tests remain intact with a clear re-enable comment at the registration site.
- The epic detail view shows **per-story decision traces** and **per-story audit entries** in read-only collapsible sections, sourced from the existing endpoints.
- A **skills view** lists discovered skills and opens per-skill history from the existing endpoints, read-only.
- In read-only mode, mutation buttons are disabled or hidden with an explanation; all read surfaces remain functional.
- All frontend changes ship in **one story** — no parallel index.html/tab-bar editors.
- `docs/capabilities.md` reflects the removed, hidden, and newly surfaced views, and the capabilities drift check passes.
- The full build and test suite pass with no cross-cutting regressions.
