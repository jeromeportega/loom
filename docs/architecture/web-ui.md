# Loom Web UI — Architecture

A locally-served dashboard for loom runs. Single-process Express server
that reads loom-core's SQLite state directly and exposes it as a JSON
API plus a Server-Sent Events stream. The architecture is shaped so the
same contract scales to a hypothetical cloud-hosted loom (multi-user,
remote DB, embedded in a host application's frontend) without rewriting
the frontend.

## Why a web UI

Operators steering long-running loom runs want a visual surface that
shows every story's live worker output, the planning artifacts inline
above the Approve button, and a single cross-repo view of every
loom-init'ed project on the machine. The CLI (`loom status`) covers
the same data textually; the MCP server (`loom_get_status` and friends)
covers it programmatically. The web view is the visual companion — it
doesn't replace MCP as the primary interface, it complements it for
moments where direct manipulation beats conversation.

The architecture also previews the eventual cloud-hosted loom: a
stateless HTTP/JSON API in front of loom's state, with a portable
frontend that can be served standalone or embedded in another host
(a host application's frontend, an internal tool, etc.).

## Components

```
loom CLI                           Browser
   │                                   │
   │  loom web                        │  http://localhost:<port>/
   │  → spawns loom-web                 ▲
   ▼                                   │
┌──────────────────────────────────────┴────┐
│  loom-web (Express)                       │
│                                            │
│   /api/*    JSON over HTTP                 │
│   /events   SSE stream of WorkerEvent +    │
│             SkillEvent                     │
│   /        Static React app (Vite build)   │
└──────────────────┬────────────────────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  loom-core          │
        │   AgentStore         │  reads .loom/loom.db
        │   EpicStore          │
        │   AuditLog           │
        │   SkillUsageStore    │
        │   ControlStore       │
        └──────────────────────┘
```

## Why these choices

**Backend: Express** — minimal, well-understood, matches Node ecosystem.
Could swap to Fastify later; no lock-in. Single process, serves both
the JSON API and the static frontend bundle.

**Frontend: a React single-page app** — `packages/loom-web/src/client/`
is a Vite + React Router + TanStack Query + Tailwind/shadcn-ui SPA, built to
`client-dist/` and served statically by the Express server. It has client-side
routing with a repository → epic → story drill-down; every level is a real,
deep-linkable URL (`/repo/:slug/epic/:epicId/story/:storyId`), so the browser
back/forward buttons work. (The original self-contained vanilla-JS
`public/index.html` was replaced by this SPA in the React re-platform; the JSON
API stayed stable across the migration.)

**Data fetching: TanStack Query polling for the list views; SSE for the
live story log** — the list/detail views poll their REST endpoints on a short
interval (the repo list federates across every registered project); the story
detail view opens an authenticated `EventSource` to `/api/events` (the token
rides in a `?token=` query param, since EventSource can't set headers) and
appends live worker output as `output` events stream in.

**Live updates: Server-Sent Events (SSE)** — simpler than WebSockets,
works through proxies, one-way (server → client) which is all we need
for streaming events. WebSocket upgrade can come later if bidirectional
becomes useful.

**No design system** — plain CSS in a `<style>` block at the top of
`index.html`. Dark theme, GitHub-Primer-adjacent palette. The goal is
portability: a loom-web bundle that can be served standalone or
composed into a host application's frontend (which may have its own
design system) without fighting two design systems. The host frontend
can style us if it wants; we ship neutral.

## API contract (v1)

All endpoints return JSON. Shape lives in
`packages/loom-web/src/shared/types.ts` (single file shared with the
frontend so types stay in sync).

### Read

```
GET  /api/status                          → { epics: EpicStatus[] }   # federated across every registered project
GET  /api/projects                        → { projects: ProjectDirectoryEntry[] }
GET  /api/epics/:id [?project=<root>]     → EpicDetail
GET  /api/epics/:id/planning-artifacts    → PlanningArtifacts   # brief / PRD / architecture / epic.yaml bodies
GET  /api/epics/:id/traces                → { traces: DecisionTrace[] }
GET  /api/agents/:id                      → AgentDetail (incl. log_tail)
GET  /api/agents/:id/audit                → { entries: AuditEntry[] }
GET  /api/agents/:id/traces               → { traces: DecisionTrace[] }
GET  /api/skills                          → { skills: SkillManifestSummary[] }
GET  /api/skills/:name/history            → { rows: SkillHistoryEntry[] }
GET  /api/cost                            → CostReport
```

### Write (gated on the local-only token)

```
POST /api/epics/:id/approve       → { status: 'approved', dispatch_pid? }  # also spawns `loom run <id>`
POST /api/epics/:id/reject        → { status: 'rejected' }
POST /api/stories/:id/retry       → { status: 'dispatching', will_resume, reset_stories, dispatch_pid? }
POST /api/stop                    → { status: 'stopping' }                 # cooperative — sets ControlStore state
POST /api/agents/:id/kill         → { status: 'killed', pid, story_id }    # SIGTERM the worker subprocess
```

`POST /api/stories/:id/retry` backs the per-row **Retry** / **Clean retry**
buttons that appear on `failed` / `blocked` stories. It delegates to
`StoryRetryService` (guards a running story or a live dispatch lease, optionally
tears down the worktree + stacked dependents on `clean`) and then re-dispatches
the epic the same way approve does. Body: `{ clean?: boolean, reason?: string }`.
See `docs/architecture/worker-resilience.md`.

### Live updates

```
GET  /events                  → SSE stream
                                 event: worker  data: {type:'dispatched'|'output'|'completed', ...}
                                 event: skill   data: {type:'injected'|'generated'|'promoted'|'demoted', ...}
                                 event: status  data: { epic_id, status, ... }
```

Frontend opens an EventSource on mount; reducer pattern updates the
React Query cache as events arrive.

## Local-only auth (v1)

loom web is **localhost-only by default**. The server binds 127.0.0.1.
A random per-launch token is printed to the launching terminal and
prepopulated as a URL fragment when loom web auto-opens the browser:

```
loom web
  → 🌐 http://127.0.0.1:8765/#token=ab7e3f...
```

Every API request includes the token. Cross-site requests without
the token fail. Defends against rogue local processes opportunistically
hitting `localhost:8765/api/*`.

### Token lifecycle (operator-facing)

The token is generated per *launch* of `loom web`, not per browser
session. Each time you start `loom web`, a fresh token is produced.

**Surviving a page refresh.** The frontend reads the token from the
URL fragment once, copies it to `sessionStorage`, and wipes the
fragment from the URL (keeps it out of screenshots / browser history).
A page refresh re-reads the token from `sessionStorage`. The token
survives until you close the tab.

**Common 401 scenarios:**

| You did | What happened | Fix |
|---|---|---|
| Restarted `loom web` in another terminal, then refreshed the existing tab | The new server has a fresh token; the tab's `sessionStorage` token is stale | Close the tab; open the URL the new terminal printed |
| Closed and re-opened the tab | `sessionStorage` cleared | Re-open with the URL the latest terminal printed |
| Copy-pasted just `http://127.0.0.1:8765/` (no fragment) to a new tab | No token to read | Re-open with the full URL including `#token=...` |

The dashboard renders a clear remediation message in each of these
cases — it's not just "HTTP 401."

## How this scales to cloud

The API contract is the load-bearing artifact. Two paths from here:

### Multi-user cloud loom

- Same JSON API, served from a managed loom instance (e.g. ECS).
- DB swaps from `better-sqlite3` (local file) to a loom-state service
  (Postgres or a loom-owned API over a cloud DB).
- Auth changes from local-token to a real identity layer.
- Frontend doesn't change — it talks to `/api/*` regardless of where
  the backend lives.

### Embedded in a host application's frontend

- Loom-web's frontend bundle is built as a library, not just an app.
- The host app imports the loom components as a route.
- The API endpoints point at the cloud loom backend.
- Loom state shows up in the host app's existing visibility surfaces.

Neither requires loom-web v1 to change. The contract is stable; the
implementation behind each endpoint can evolve.

## What ships today

- `packages/loom-web/` — Express server (JSON API) + a React SPA (Vite + React Router + TanStack Query + Tailwind/shadcn-ui)
- The read endpoints in the API contract above
- A federated list view (every loom-init'ed project on the machine,
  grouped by repo name, current project first)
- A detail view per epic with: original brief, planning artifacts
  inline (brief / PRD / architecture / epic.yaml) for `planned` epics,
  agent rows with live worker stdout via SSE, and inline controls
  (approve / reject / stop / per-worker kill / retry + clean retry on
  failed or blocked stories)
- `loom web` CLI command that auto-opens the browser with the token
  embedded in the URL fragment
- Localhost-only with the random per-launch token guard
- 33 tests covering every endpoint (against a fixture SQLite)

## What deliberately doesn't ship yet

- Authentication for non-local use (cloud path concern)
- Multi-tenancy (one loom per process)
- Real-time WebSocket bidirectional (SSE is enough)
- Mobile-responsive layout (laptop-only for now)
- The skill graph / skill lifecycle visualization (defer)
- Cross-machine federation — the dashboard aggregates across repos
  on **one** machine; sharing a teammate's runs needs the cloud
  Postgres mirror tracked at issue #19
