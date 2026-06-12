---
title: "Epic 4 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 4 Review: MCP Server

Reviewing the MCP tool layer — the `tools/` extraction, the `ToolContext`, background
dispatch, and the handler tests — with an eye on downstream impact on Epics 5–6.

Note: the MCP scaffold landed in Epic 1, `loom_start_epic` was wired in Epic 2, and
the status/policy tools in earlier epics. Epic 4's real work was making the layer
**testable** and adding **background dispatch**.

## Findings

### Medium — fixed in this pass

**1. Background dispatch failures vanished into stderr.**
- `loom_approve_plan` hands `supervisor.run()` to `ctx.background()`. The production
  sink only did `process.stderr.write(...)` on failure. A top-level Supervisor failure
  (e.g. a missing epic YAML) left the epic stuck `in_progress` with no trace the user
  could see through the MCP channel.
- **Fix**: `productionContext().background` now also records a `background_failure`
  audit entry, so the failure surfaces via `loom_get_audit_log`.

### Medium — documented, justified asymmetry

**2. `loom_start_epic` blocks; `loom_approve_plan` does not.**
- `loom_approve_plan` returns immediately and dispatches in the background (dispatch
  is unbounded — potentially hours). `loom_start_epic` still blocks the client until
  planning finishes (~5 minutes).
- This asymmetry is deliberate: planning is bounded and returns a result the client
  needs (epic ids, artifact paths). Making it background would require a "planning
  runs" table for progress polling — epics do not exist in the DB until planning
  completes, so `loom_get_status` would show nothing meanwhile.
- **Action**: documented. Revisit if a real MCP client's tool-call timeout proves
  shorter than a planning run.

### Low — documented, minor

**3. `loom_get_status` story `title` mirrors the story id.**
- The `agents` table does not store the story title, so the status tree's `title`
  field repeats the `id`. Real titles live in the epic YAML.
- **Fix later**: either store the title on the agent row, or have `loom_get_status`
  read it from the epic YAML. Low priority — the id is informative enough.

**4. The stdio transport wiring is not unit-tested.**
- `startMcpServer()` and `productionContext()` are thin SDK glue. The 7 handlers — the
  actual logic — are fully tested via injected mocks. The transport is the documented
  thin seam (cf. `ClaudeCodeWorker`'s subprocess).

**5. Tool inputs are coerced, not schema-validated.**
- Handlers defensively coerce (`String(args.command ?? '')`); the registry declares an
  `inputSchema` with `required` fields that MCP clients validate against. A zod parse
  of tool args would be stricter. Acceptable for MVP.

## Downstream impact matrix

| Finding | Epic 5 (Skills) | Epic 6 (IDE) |
|---|---|---|
| #1 background failures | — | now visible in audit log |
| #2 start_epic blocking | — | Cursor tool-call timeout — verify in Epic 6 |
| #3 status title | — | cosmetic in the dashboard |
| #4 transport seam | — | — |
| #5 input coercion | `loom_list_skills` gets real output | — |

## What's solid

- **Testable handlers**: extracting the 7 tools behind a `ToolContext` with injectable
  LLM/worker factories means the whole MCP surface — including the planning pipeline
  and background dispatch — is unit-tested with mocks. No stdio, no API key, no
  `claude` CLI needed. 13 handler tests.
- **Non-blocking dispatch**: `loom_approve_plan` returns `dispatching` immediately and
  the Supervisor runs detached in the long-lived server process — the right model for
  an unbounded operation.
- **One registry, one wiring**: `TOOL_DEFINITIONS` + `HANDLERS` are the single source
  of truth; `server.ts` is now ~50 lines of pure transport glue.
- **Consistent contracts**: every handler returns a plain JSON-serializable object;
  `server.ts` wraps them uniformly. Error results are structured (`{status:'error'}`),
  never thrown across the protocol boundary.
