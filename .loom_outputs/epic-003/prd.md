# Fleet Commander — Governance Layer for Governed Agent Fleets (PRD v2.0)

## Overview

Loom's web dashboard already federates status, streams live worker output over SSE, and exposes working mutation endpoints (approve / reject / stop / retry / kill) across web, MCP, and core. What it lacks is a **governance layer** that lets one human safely supervise many concurrent epics. Fleet Commander adds that layer **on top of** the existing surfaces — extending `packages/loom-web` and supporting `loom-core`/state, never rewriting them. It delivers four pillars: a per-epic autonomy dial the Supervisor enforces, a cross-epic decision inbox, a live fleet board, and a deployable read-only public mode. With no new flags or columns set, behavior is **byte-compatible with today**.

## Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G-1 | Cut time-to-decision for a multi-epic operator | `GET /api/inbox` surfaces 100% of pending decisions across all registered projects in one view; inbox approves **and** rejects a plan end-to-end (asserted in a test) |
| G-2 | Give per-epic oversight control | `autonomy_level` persists per epic and the Supervisor enforces all three modes, each covered by a passing unit test |
| G-3 | Allow safe delegation of visibility | Enumerated-route test proves zero mutation routes succeed without the write token while every GET route serves without one |
| G-4 | Ship with zero regression | Default (non-read-only, `manual`) behavior is unchanged; `npm run build` + `npm run test` green across all workspace packages |

## User Stories

- **US-1 (Must)** — As a fleet governor, I want a single inbox of every pending decision across all my epics and projects, so that I can act on what needs me without hunting epic-by-epic.
- **US-2 (Must)** — As a fleet governor, I want to set autonomy per epic, so that I can run epic A hands-off while checkpointing epic B after each story.
- **US-3 (Must)** — As a fleet governor, I want a live board aggregating my concurrent epics into cards, so that I can watch the whole fleet move at a glance.
- **US-4 (Must)** — As a fleet governor, I want `full-auto` epics to record the same audit row and policy snapshot as a human approval, so that autonomy changes who decides, not what is recorded.
- **US-5 (Must)** — As a read-only observer (stakeholder, teammate, or the operator on a phone), I want to watch fleet progress — status, costs, worker output — without any ability to mutate state, so that visibility can be shared without sharing control.

## Functional Requirements

- **FR-1** — Add an `autonomy_level` column to `epics` with values `full-auto` | `checkpoint` | `manual` and default `manual`; the value persists per epic.
- **FR-2** — `POST /api/epics/:id/autonomy` sets the autonomy level; the endpoint is token-gated and writes an audit row.
- **FR-3** — The `loom_set_autonomy` MCP tool sets the autonomy level; token-gated, with the same audit-logging as FR-2.
- **FR-4** — In `manual` mode the Supervisor requires explicit human approval before dispatch (current behavior).
- **FR-5** — In `checkpoint` mode the Supervisor pauses after each story, persists a durable paused indicator that the inbox can surface, and re-dispatches on resume.
- **FR-6** — In `full-auto` mode the Supervisor skips the human gate: auto-transition `planned`→`approved`, auto-dispatch, and run to completion.
- **FR-7** — The `full-auto` path writes the `epic_approved` audit row **and** the policy snapshot exactly as a human approve does.
- **FR-8** — `GET /api/inbox` federates every pending decision across registered projects, each tagged with `project_root` and a `type` of `plan_approval` | `checkpoint_resume` | `escalation`, plus the minimum fields to act: epic id, title, project, story id, age.
- **FR-9** — The inbox view offers inline Approve/Reject, Resume/Stop, and Retry/Kill, each wired to the **existing** mutation endpoints (no duplicated mutation logic).
- **FR-10** — `GET /api/fleet` aggregates epics into board cards carrying status, per-story states, cost roll-up (reusing `aggregateEpicCost`), and blocker count, with every story correctly attributed to its epic/project and **no cross-epic state bleed** when ≥2 epics run concurrently.
- **FR-11** — The fleet board view renders these cards and updates live off the existing SSE `agent`/`epic` events.
- **FR-12** — `LOOM_WEB_READONLY=1` and/or `loom web --read-only` serve GET/read routes + SSE without a token.
- **FR-13** — In read-only mode every mutation route returns `403` without the write token, enforced by a **single centralized mutation-guard** (not per-handler copies).
- **FR-14** — With no new flags or columns set, behavior is byte-compatible with today: autonomy defaults to `manual`, read-only is off, and the token continues to gate all of `/api/*`.

## Non-Functional Requirements

- **NFR-1 (Compatibility)** — The default (no new flags/columns) code path must produce behavior identical to the current release.
- **NFR-2 (Security/Audit)** — Every mutation is token-gated and audit-logged (CLAUDE.md invariant #5), including the new `autonomy` endpoint; `full-auto` auto-approval is held to the same audit standard as a human approval.
- **NFR-3 (Correctness)** — Autonomy enforcement lives in the Supervisor and is unit-tested per level; the read-only guard is centralized and test-enumerated over the route table; cross-epic attribution is proven by a test with two epics' agents in the DB.
- **NFR-4 (No rewrites)** — Reuse `EpicStore`, `AgentStore`, `Supervisor`, `AuditLog`, `ControlStore`, and `ProjectRegistry`; extend the vanilla-JS frontend and Express route table rather than replacing them.
- **NFR-5 (Live correctness)** — The board and inbox must respect existing per-project SSE scoping; introduce a new event only if strictly needed.
- **NFR-6 (Deployment exposure)** `[ASSUMPTION]` — A publicly tunneled read-only server still exposes worker output, costs, branch names, and PR URLs; the deploy documentation must note this sensitivity.

## Epics

This PRD is a single cohesive shipping unit — a governance layer added on top of loom's existing surfaces — and breaks into **one epic**:

- **epic-001 — Fleet Commander governance layer** (Must): per-epic autonomy dial (Supervisor-enforced), cross-epic decision inbox, live fleet board, and deployable read-only public mode, plus the `docs/capabilities.md` update and a full build/test pass. Covers FR-1 through FR-14.

## Out of Scope (V1)

- **Cost *forecasting*, velocity charts, and owner/tag/deadline metadata** — this is a control surface, not an analytics product; resist as scope creep.
- **Multi-user accounts, per-user identity, and role-based permissions (RBAC)** — the token + read-only split is the entire access model.
- **Rewrites** of the vanilla-JS frontend or the Express server, and any duplicated mutation logic — all new views call existing mutation endpoints.
- **Sensitivity scrubbing of streamed read-only fields** beyond a documentation note (a deeper field-level review is unspecified and deferred).
