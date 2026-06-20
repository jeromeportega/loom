# Loom Web Dashboard — Observability Spine Focus PRD

## Overview

The loom web dashboard is loom's observability surface: the CLI drives loom, and the dashboard is where operators watch it work. An audit surfaced three defect classes that undermine that mission — a misleading empty Autonomy stub, premature multi-project surface area (Fleet/Inbox) shown before it is ready, and three fully-wired read endpoints (per-agent decision traces, per-story audit, skills) that have no UI at all. Compounding these, mutation controls remain clickable in read-only mode where they silently fail, eroding trust in every control on the page. This is a focused frontend change that prunes what misleads, hides what is premature, and surfaces what is already built — concentrating the dashboard on its high-value observability spine. **No new backend capability is created**; existing read endpoints are reused as-is, and the autonomy/fleet/inbox capabilities (routes, CLI, view files, tests) are all preserved.

## Goals

1. **Eliminate dishonest surface area.** The dashboard navigation reflects only capabilities it actually delivers — zero empty stub tabs and zero premature multi-project tabs visible. *Metric: Autonomy/Fleet/Inbox tabs absent from nav; underlying routes/CLI/tests still pass.*
2. **Surface the high-value observability data loom already collects.** Operators can read decision traces, per-story audit, and skills data from the dashboard. *Metric: all three previously-headless read endpoints have a working UI front door.*
3. **Make every visible control honest.** No control silently fails. *Metric: in read-only mode, 100% of mutation buttons (approve, reject, stop, kill, retry, archive) are disabled or hidden with an explanation; all read surfaces remain functional.*
4. **Preserve restorability and keep docs current.** Hidden/removed capabilities are cleanly restorable and documentation matches reality. *Metric: Fleet/Inbox routes/views/tests intact with re-enable comment; `docs/capabilities.md` drift check passes.*

## User Stories

- **Must** — As a loom operator, I want the dashboard navigation to show only capabilities that actually work, so that I trust what the dashboard tells me loom is doing.
- **Must** — As a loom operator, I want to read the decision traces and audit entries behind each story from the epic detail view, so that I can understand *why* an agent did what it did without leaving the dashboard.
- **Must** — As a loom operator, I want a skills view with drill-down into per-skill history, so that I can see which skills loom discovered and how they have performed.
- **Must** — As a loom operator in read-only mode, I want mutation controls disabled or hidden with a brief explanation, so that I never click a control that silently does nothing.
- **Should** — As a maintainer/contributor, I want Fleet/Inbox code and the autonomy route/CLI preserved and cleanly restorable, so that the future multi-project workflow can be re-enabled without rebuilding it.

## Functional Requirements

- **FR-1** — Remove the Autonomy tab: delete its nav registration and its view file. The `POST` autonomy route and the `loom autonomy` CLI command remain unchanged and functional.
- **FR-2** — Hide the Fleet and Inbox tabs from the visible tab bar only. Their server routes, view files, and tests remain intact. A comment at the registration site explains the intentional hide and how to re-enable.
- **FR-3** — Add a read-only, collapsible **per-story decision traces** section to the epic detail view, fed by the existing per-agent traces endpoint with no backend change.
- **FR-4** — Add a read-only, collapsible **per-story audit** section to the epic detail view, fed by the existing audit endpoint with no backend change.
- **FR-5** — Add a **Skills view** tab listing discovered skills with lifecycle and track record from the existing skills endpoint, with drill-down to per-skill history from the existing per-skill history endpoint. Register it in the tab bar in place of the removed/hidden tabs so navigation stays coherent.
- **FR-6** — Make read-only mode honest: when read-only, disable or hide all mutation buttons (approve, reject, stop, kill, retry, archive) with a brief explanation. All read/observability surfaces remain fully functional.
- **FR-7** — Expose the existing server-side read-only state to the client, making only the minimum response-surface change needed and altering no route *behavior*. *(`[ASSUMPTION]` the flag already exists server-side; if not, exposing it is a small in-scope addition confirmed during implementation.)*
- **FR-8** — Update `docs/capabilities.md` to reflect the removed, hidden, and newly surfaced views, and ensure the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1** — No server route behavior changes except the minimum needed to expose read-only mode to the client (FR-7).
- **NFR-2** — The traces, audit, skills, and per-skill history endpoints are reused exactly as-is and must not be modified; any reshaping stays client-side.
- **NFR-3** — The observability spine (epic list, detail, live log panes, planning stream, planning artifacts) remains fully intact; no guardrail is weakened.
- **NFR-4** — The full build and test suite pass with no cross-cutting regressions.

## Epics

This PRD is **one epic**: *Refocus the dashboard on its observability spine.* Per the brief's critical structuring constraint, the epic's frontend work (FR-1 through FR-7) is a **single cohesive story** — all changes edit the same navigation/tab-bar region of `packages/loom-web/public/index.html` plus a small set of closely-related frontend files, and must not be split across parallel workers. Documentation (FR-8) and final build/test verification are separable only because they touch genuinely independent files.

## Out of Scope

- The multi-project fleet-manager workflow. Fleet/Inbox are seeds of that future and are hidden, not built for, here.
- Any new backend capability or modification of the traces, audit, skills, or per-skill history endpoints.
- Removal of any Fleet, Inbox, or Autonomy server route or underlying functionality (only the Autonomy *stub tab* is deleted; Fleet/Inbox are temporarily hidden).
- Changes to the observability spine surfaces beyond adding the new read-only sections/tab.
