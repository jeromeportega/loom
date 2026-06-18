# Remove the loom MCP Server: CLI-Only Control, Web-Only Observability

## The Problem

Loom currently exposes two ways to drive the orchestrator: the CLI (primary) and the `loom-mcp` server (`packages/loom-mcp`), which republishes the same operations as `mcp__loom` tools to Claude Code and Cursor. The second surface costs more than it returns:

- **Operator context bloat** — every MCP tool schema loads into the client, crowding the context window.
- **Duplication** — the server re-implements operations the CLI already owns, so each capability is maintained twice.
- **Wider surface** — more maintenance burden and a larger access/attack surface, against a goal of focusing on the core orchestrator loop.

The intended positioning is now singular: **the CLI is the usability surface, loom web is the observability surface, and loom offers no MCP surface of its own.** Today's code, docs, and positioning contradict that — `docs/operations/releasing.md` even calls the MCP server the *primary* loom surface. The risk in simply deleting the server is silently dropping capabilities that exist *only* in MCP today (notably the cursor worker's live-guidance read path). This work removes the server **without losing any capability**, by porting first and deleting second.

## Target Users

- **Primary — loom operators.** Engineers who drive loom from the CLI. They gain a complete CLI (no capability stranded in MCP) and a lighter client context.
- **Secondary — cursor-backend worker agents.** Workers that today pull live operator guidance via the `loom_pull_guidance` MCP tool. They must retain that path through a CLI command or a direct guidance-file read.
- **Secondary — loom maintainers.** They shed a duplicated package, its tests, and its publish/build wiring.
- **Anti-persona — the "loom-as-a-server" integrator.** Anyone wanting to mount loom itself as an MCP server inside Claude Code or Cursor. This use case is being **deliberately removed** and should not be designed for. Note the contrast with worker-facing MCP *provisioning* (granting workers approved third-party servers), which is explicitly retained.

## Proposed Solution

Execute in two ordered phases — **the order is load-bearing**.

**Phase 1 — Port first.** Before deleting anything, add CLI equivalents for every capability that exists only in MCP today, so parity holds at all times.

**Phase 2 — Remove cleanly.** Once parity is in place and verified, delete `packages/loom-mcp`, remove the `loom serve` command and `loom init --mcp` flag plus all `.mcp.json` generation for the loom server, strip the dependency and tests, fix build/test/publish wiring, and scrub all docs and positioning that advertise or imply a loom MCP surface.

Worker-facing MCP *provisioning* of approved third-party servers is preserved throughout; only loom-as-a-server is removed.

## Key Capabilities

**Phase 1 — new/extended CLI commands (parity port):**

1. `loom pull-guidance <story-id>` — wraps `OperatorGuidance.pullSince` (the worker-side read path; mirrors `loom_pull_guidance`). Prints new guidance as plain text by default; `--json` flag; a clear "no new guidance" message when empty.
2. `loom project <project-root>` — returns the one registered project's detail plus its latest epic (mirrors `loom_get_project`). Short human summary by default (root, name, latest epic id/status/title); `--json` for the full object.
3. `loom stop --epic <epic-id>` — terminates every running worker of one epic while leaving other epics running (mirrors `loom_stop_epic`). The existing no-argument `loom stop` (graceful whole-supervisor halt) is retained.
4. `--project <root>` flag on `loom status` and `loom scan` — targets one registered project (mirrors the MCP `project` parameter).
5. `--top-lessons`, `--top-opps`, and `--json` flags on `loom propose` (mirrors `loom_propose`).
6. `--reason` flag on `loom stop` and `loom retry` — audit parity with MCP. Optional; defaults to a CLI-source reason string; applies to bare `loom stop`, `loom stop --epic`, and `loom retry`.
7. **Cursor worker prompt update** — workers pull guidance via the new CLI command or by reading `.loom/guidance` for the story directly, instead of calling `loom_pull_guidance`; stop materializing the loom server entry into the cursor worktree `.cursor/mcp.json`.

**Phase 2 — removal:**

8. Delete `packages/loom-mcp` entirely; remove `loom serve` and its dynamic import.
9. Remove `loom init --mcp` and all loom-server `.mcp.json` generation (the `mcpConfig` module and its use in `init`), keeping third-party worker-provisioning wiring only where needed.
10. Remove the `@loom-ai/mcp` (`at-loom-ai-slash-mcp`) dependency and the MCP-driven test in `loom-web`; update or delete every test referencing the mcp package across loom-core, loom-cli, loom-web.
11. Update root `package.json` build/test scripts to drop the mcp workspace; update the npm publish workflow to stop publishing the mcp package.
12. Update **all** docs/positioning: `docs/capabilities.md` (drop MCP-as-server rows, two-interfaces framing, `loom serve` and `loom init --mcp` entries, MCP tool listings, first-class Claude Code/Cursor-via-MCP rows; reframe as CLI = usability, web = observability), `CLAUDE.md`, `README.md`, `docs/getting-started`, `docs/index.md`, `docs/operations/releasing.md`. Scrub "mcp as a first-class citizen" language repo-wide.

## Constraints

- **Sequencing is mandatory:** no deletion in Phase 2 may land before its Phase 1 CLI equivalent exists. Parity must be unbroken at every commit.
- **Strict out-of-scope — do not touch:** worker-facing MCP provisioning of approved third-party servers; `loom mcp add` and `loom mcp list`; `policy.mcp.registry`; the `McpRegistry`, `WorktreeMcp`, and adapter modules in `packages/loom-core/src/mcp`; `CursorMcpEnforcer`; `docs/research/cursor-mcp-strictness.md`.
- **Existing installs are not actively cleaned:** Phase 2 only stops *new* materialization of the loom server into worktree configs and removes the generation code. No migration scrubs loom-server entries already on disk in other repos; stale entries are acceptable and noted as a follow-up.
- **No publishing action now:** drop the mcp package from future publishing by removing it from the workflow and releasing runbook. Do **not** run `npm deprecate`. Treat as a major version bump for our records only.
- **Error behavior:** unknown story id (`pull-guidance`), unregistered project root (`project`), and nonexistent epic id (`stop --epic`) each exit non-zero with a clear one-line message — never a stack trace.

## Risks and Open Questions

- **Hidden capability gap.** Risk that a `mcp__loom` operation lacks a CLI equivalent and is silently lost. *Mitigation, already decided:* a prior gap analysis enumerated every `mcp__loom` tool and mapped each to a CLI equivalent. Include an explicit verification step/test that lists the pre-removal `mcp__loom` tool inventory and asserts each maps to a CLI command — **parity is proven, not asserted.**
- **Cursor worker regression.** Removing the loom server from `.cursor/mcp.json` could break live operator guidance for cursor-backend workers. *Mitigation:* the prompt update routes guidance through `loom pull-guidance` or the `.loom/guidance` file path; this path must be confirmed working before the MCP read path is removed.
- **Incomplete positioning scrub.** Stale "first-class" / "primary surface" language could survive in untracked corners. *Mitigation, decided:* done-ness is search-defined — after the change, repo searches for `first-class`, `primary surface`, `two interfaces over the same engine`, `mcp__loom`, `loom serve`, and `loom init --mcp` return **no hits except** inside `docs/research/cursor-mcp-strictness.md` and the retained worker-provisioning code paths.
- **Provisioning entanglement.** `[ASSUMPTION]` The loom-server materialization and the third-party worker-provisioning wiring share enough code that surgically removing only the former requires care; expect to separate them rather than delete a shared module wholesale.
- **Stale on-disk entries.** `[ASSUMPTION]` Accepted as low-impact and logged as a follow-up; out of scope here.

## Success Criteria

1. `npm run build` and `npm run test` both pass with `packages/loom-mcp` gone.
2. The `loom serve` command and the `loom init --mcp` flag no longer exist.
3. Repository search for `loom-mcp`, `loom serve`, `mcp__loom`, and `loom init --mcp` across packages and docs returns **only** worker-provisioning hits (and `docs/research/cursor-mcp-strictness.md`) — never the removed server.
4. Every capability the MCP server had is reachable from the CLI, verified against the Phase 1 port-first list **and** the `mcp__loom` tool inventory (explicit mapping test passes).
5. `docs/capabilities.md` and all positioning no longer advertise an MCP interface; they frame the CLI as usability and loom web as observability.
6. Cursor-backend live operator guidance still works through `loom pull-guidance` or the `.loom/guidance` file path.
7. The retained out-of-scope surfaces (`loom mcp add`/`list`, `policy.mcp.registry`, `McpRegistry`/`WorktreeMcp`/adapters, `CursorMcpEnforcer`, the cursor-mcp-strictness research doc) remain intact and functional.
