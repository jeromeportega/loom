# Epic B — Fleet Commander: mission control for governed agent fleets (v2.0)

## Problem

One developer or PM should be able to run 10+ epics in parallel and govern
the whole fleet from one surface. Loom's web dashboard already shows
federated status with approve/stop/retry, but governance is scattered:
pending approvals live per-epic, autonomy is a global policy file, and there
is no deployable view to share or operate from.

## Who it's for

The "agent fleet commander": a single human governing many concurrent epics —
setting direction, approving plans, resolving escalations.

## What to build

Extend `packages/loom-web` (+ supporting core/state changes):

1. **Decision inbox** — one queue of every pending human decision across all
   epics/projects: plan approvals, checkpoint confirmations, escalations.
   Approve/reject inline; actions flow through existing endpoints into SQLite
   + audit log.
2. **Autonomy dial per epic** — `full-auto` / `checkpoint` / `manual`,
   persisted (policy snapshot or epics table), enforced by the Supervisor:
   full-auto skips human plan approval, checkpoint honors story/epic
   checkpoints, manual gates everything.
3. **Fleet board** — epics as cards/lanes: stories, agent states, branches,
   review status, cost roll-up, blockers; live worker output via the existing
   SSE stream. Must hold up with several epics in flight.
4. **Deployable read-only mode** — a public, token-less mode exposing only GET
   views (mutations require the token, as today). Deploy to a public URL with
   a db sync or tunnel strategy; document the deploy in docs/.

## Done means

- Deployed public URL returns 200 with ≥2 of today's real epics rendering.
- Decision inbox + autonomy dial work end-to-end (UI → state → supervisor
  behavior), with tests for the autonomy enforcement.
- Read-only mode exposes zero mutation routes without the token.
- `docs/capabilities.md` updated; suite green.

## Non-goals

- Auth systems/multi-user accounts (token + read-only split is enough today).
- Rewriting the frontend stack — extend the existing vanilla JS app.
- New visualizations beyond what governance needs (this is a control surface,
  not a dashboard product).
