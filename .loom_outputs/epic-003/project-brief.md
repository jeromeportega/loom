# Fleet Commander — Deployable Mission Control for Governed Agent Fleets (v2.0)

## The Problem

Loom's web dashboard already does the hard plumbing: it federates status across projects, streams live worker output over SSE, and exposes working approve / reject / stop / retry / kill endpoints across web, MCP, and core. What it lacks is a **governance layer** that lets one human safely supervise many epics at once.

Today, governance is scattered across three gaps:

- **Decisions are per-epic.** Pending human approvals are surfaced one epic at a time. An operator running several epics has no single place to see — let alone act on — every decision waiting on them.
- **Autonomy is global and coarse.** Autonomy is a single global policy file, so an operator cannot say "run epic A hands-off but checkpoint epic B after each story." Every epic is governed the same way.
- **The dashboard can't be shared.** The auth token grants full mutation access, so there is no safe way to expose a read-only view to a stakeholder. Sharing progress means sharing the keys to the fleet.

The result: a human governing concurrent agent work spends attention hunting for what needs a decision, cannot tune oversight per epic, and cannot delegate visibility without delegating control.

## Target Users

- **Primary — the fleet governor (solo operator).** One human supervising multiple concurrent epics across one or more projects. They need to find the next decision fast, set how much autonomy each epic gets, and watch the whole fleet move. `[ASSUMPTION]` Given loom's single-token model and the "one human governs many" framing, this is a single power-user operator, not a team — consistent with the project's dogfooding posture.
- **Secondary — the read-only observer.** A stakeholder, teammate, or the operator on a phone who wants to watch fleet progress (status, costs, worker output) without any ability to mutate state. Served by the public read-only mode.
- **Anti-persona — the multi-user team needing accounts/RBAC.** Real auth systems, per-user identity, and role-based permissions are explicitly **out of scope**. The token + read-only split is the entire access model; anyone needing more is not this product's user.

## Proposed Solution

Add a governance layer **on top of** loom's existing surfaces — extending `packages/loom-web` and supporting `loom-core`/state. This is a control surface, not a new dashboard product. The vanilla-JS frontend and the Express server are extended, never rewritten; all new actions reuse the existing mutation endpoints and audit/policy machinery.

Four pillars:

1. A **per-epic autonomy dial** the Supervisor actually enforces.
2. A **cross-epic decision inbox** that federates every pending human decision.
3. A **fleet board** aggregating concurrent epics into live cards.
4. A **deployable read-only public mode** that separates "watch" from "act."

The default with no new flags or columns set must be **byte-compatible with today**: autonomy defaults to `manual`, read-only is off, and the token continues to gate all of `/api/*`.

## Key Capabilities

1. **Per-epic autonomy dial (Supervisor-enforced).** A new `autonomy_level` column on `epics` (`full-auto` | `checkpoint` | `manual`, default `manual`), set via `POST /api/epics/:id/autonomy` and the `loom_set_autonomy` MCP tool (token-gated). The Supervisor enforces each mode: `manual` requires explicit human approval before dispatch; `checkpoint` pauses after each story with a durable paused indicator that the inbox can surface and a resume that re-dispatches; `full-auto` skips the human gate (auto-transition `planned`→`approved`, auto-dispatch, run to completion).
2. **Audit/policy parity on auto-approve.** The `full-auto` path MUST write the `epic_approved` audit row and the policy snapshot exactly as a human approve does — autonomy changes who decides, not what is recorded.
3. **Cross-epic decision inbox.** `GET /api/inbox` federates every pending decision across registered projects, each tagged with `project_root` and type — `plan_approval`, `checkpoint_resume`, or `escalation` — plus the minimum fields to act (epic id, title, project, story id, age). A new inbox view offers inline Approve/Reject, Resume/Stop, Retry/Kill wired to the **existing** mutation endpoints.
4. **Fleet board.** `GET /api/fleet` aggregates epics into board cards — status, per-story states, cost roll-up (reusing `aggregateEpicCost`), blocker count — with every story correctly attributed to its epic/project and **no cross-epic state bleed** when ≥2 epics run concurrently. A new board view renders these cards and updates live off the existing SSE `agent`/`epic` events.
5. **Deployable read-only public mode.** `LOOM_WEB_READONLY=1` and/or `loom web --read-only` serve GET/read routes + SSE without a token (safe to share), while every mutation route returns 403 without the write token. Enforced by a **single centralized mutation-guard** (not per-handler copies) so it cannot drift.

## Constraints

- **No rewrites.** Extend the existing vanilla-JS frontend and Express route table; reuse `EpicStore`, `AgentStore`, `Supervisor`, `AuditLog`, `ControlStore`, `ProjectRegistry`. New views call existing mutation endpoints — no duplicated mutation logic.
- **Byte-compatible default.** With no new flags/columns set, behavior matches today exactly.
- **Every mutation token-gated and audit-logged** (CLAUDE.md invariant #5), including the new `autonomy` endpoint.
- **Autonomy enforcement lives in the Supervisor** and is unit-tested per level; the read-only guard is centralized and **test-enumerated** over the route table.
- **`docs/capabilities.md` updated in the same PR** with the new CLI/MCP/web surfaces (CLAUDE.md requirement).
- **`npm run build` and `npm run test` green** across all workspace packages.

## Risks and Open Questions

- **Cross-epic state bleed (highest risk).** The fleet board and inbox compose per-project SSE streams; attributing every story to the correct epic/project under ≥2 concurrent epics is the central correctness hazard. Must be proven by a test with two epics' agents in the DB.
- **Durable paused indicator for `checkpoint`.** The brief leaves the mechanism open — a `paused` flag/column vs. a derived state. `[ASSUMPTION]` A persisted column is more robust for inbox surfacing and resume than a derived state, but the choice is a PM/architect decision and affects schema migration.
- **Auto-approve fidelity.** The `full-auto` path must reproduce the human-approve side effects (audit row + policy snapshot) precisely; any divergence breaks governability and the audit invariant.
- **SSE scoping under the board.** Live correctness depends on respecting existing per-project SSE scoping; whether a new lightweight event is needed is left to "only if strictly needed" — an open design call.
- **Read-only deployment exposure.** `[ASSUMPTION]` A publicly tunneled read-only server still exposes worker output, costs, branch names, and PR URLs — potentially sensitive. The deploy doc should note this; sensitivity review of streamed fields may be warranted but is not specified.
- **Scope discipline.** Cost *forecasting*, velocity charts, and owner/tag/deadline metadata are explicitly out of scope and should be resisted as scope creep — this is a control surface.

## Success Criteria

- `autonomy_level` persists per epic; the Supervisor enforces all three modes, each covered by a unit test: `full-auto` auto-approves + dispatches **and writes the approve audit row**; `checkpoint` pauses after a story and resumes on re-dispatch; `manual` still requires explicit approve.
- `GET /api/inbox` returns pending decisions federated across projects; the inbox view approves **and** rejects a plan end-to-end, with the status change + audit row asserted in a test.
- `GET /api/fleet` aggregates ≥2 concurrent epics into board cards with correct per-epic attribution and no state bleed — covered by a test with two epics' agents in the DB.
- Read-only mode: an enumerated-route test proves zero mutation routes succeed without the write token while every GET route serves without one; default (non-read-only) mode is unchanged.
- `docs/capabilities.md` updated with the new CLI/MCP/web surfaces; `npm run build` + `npm run test` green across all workspace packages.
