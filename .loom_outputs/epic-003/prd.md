# PRD: Remove the loom MCP Server — CLI-Only Control, Web-Only Observability

## Overview

Loom exposes two control surfaces: the CLI (primary) and the `loom-mcp` server, which republishes the same operations as `mcp__loom` tools to Claude Code and Cursor. The second surface costs more than it returns — operator context bloat, duplicated maintenance, and a wider access/attack surface — and contradicts loom's intended positioning: **the CLI is the usability surface, loom web is the observability surface, and loom offers no MCP surface of its own.** This work retires the loom-as-a-server surface **without losing any capability**, executed in two load-bearing phases: first port every MCP-only capability to the CLI so parity holds at all times, then delete the server, its wiring, and all positioning that advertises it. Worker-facing MCP *provisioning* of approved third-party servers is explicitly retained.

## Goals

1. **No capability loss.** Every `mcp__loom` operation is reachable from the CLI. *Metric:* a parity mapping test enumerates the pre-removal `mcp__loom` tool inventory and asserts each maps to a CLI command; all seven Phase-1 capabilities are reachable from the CLI.
2. **Singular positioning enforced.** No code, doc, or positioning advertises a loom MCP surface. *Metric:* repo search for `loom-mcp`, `loom serve`, `loom init --mcp`, `mcp__loom`, `first-class`, `primary surface`, and `two interfaces over the same engine` returns **no hits** except inside `docs/research/cursor-mcp-strictness.md` and retained worker-provisioning code paths.
3. **Reduced surface and clean build.** The duplicated package, its tests, and its publish wiring are gone. *Metric:* `npm run build` and `npm run test` pass with `packages/loom-mcp` deleted; the mcp package is removed from the publish workflow and releasing runbook.
4. **Worker guidance continuity.** Cursor-backend workers retain live operator guidance after the MCP read path is removed. *Metric:* live guidance is verified working through `loom pull-guidance` or the `.loom/guidance` file path before the MCP read path is deleted.

## User Stories

- **As a loom operator,** I want every orchestrator operation available from the CLI, so that no capability is stranded in MCP and my client context stays light. *(Must)*
- **As a cursor-backend worker agent,** I want to pull live operator guidance via a CLI command or by reading `.loom/guidance` for my story, so that guidance still works once the MCP read path is gone. *(Must)*
- **As a loom maintainer,** I want the duplicated mcp package, its tests, and its publish/build wiring removed, so that I maintain one control surface instead of two. *(Must)*
- **As a new loom user,** I want docs and positioning to reflect a single CLI control surface and web observability, so that I am not misled into mounting loom as an MCP server. *(Should)*

## Functional Requirements

**Phase 1 — Port first (parity port):**

- **FR-1** — `loom pull-guidance <story-id>` wraps `OperatorGuidance.pullSince` (mirrors `loom_pull_guidance`). Prints new guidance as plain text by default; supports `--json`; prints a clear "no new guidance" message when empty.
- **FR-2** — `loom project <project-root>` returns the one registered project's detail plus its latest epic (mirrors `loom_get_project`). Prints a short human summary by default (root, name, latest epic id/status/title); `--json` emits the full object.
- **FR-3** — `loom stop --epic <epic-id>` terminates every running worker of one epic while leaving other epics running (mirrors `loom_stop_epic`). The existing no-argument `loom stop` (graceful whole-supervisor halt) is retained unchanged.
- **FR-4** — `loom status` and `loom scan` accept a `--project <root>` flag that targets one registered project (mirrors the MCP `project` parameter).
- **FR-5** — `loom propose` accepts `--top-lessons`, `--top-opps`, and `--json` flags (mirrors `loom_propose`).
- **FR-6** — `loom stop` (bare and `--epic`) and `loom retry` accept an optional `--reason` flag for audit parity with MCP; when omitted, the audit log records a default CLI-source reason string.
- **FR-7** — The cursor worker prompt is updated to pull guidance via `loom pull-guidance` or by reading `.loom/guidance` for the story directly, and the loom-server entry is no longer materialized into the cursor worktree `.cursor/mcp.json`.

**Phase 2 — Remove cleanly:**

- **FR-8** — Delete `packages/loom-mcp` entirely; remove the `loom serve` command and its dynamic import.
- **FR-9** — Remove `loom init --mcp` and all loom-server `.mcp.json` generation (the `mcpConfig` module and its use in `init`), retaining third-party worker-provisioning wiring only where needed.
- **FR-10** — Remove the `@loom-ai/mcp` (`at-loom-ai-slash-mcp`) dependency and the MCP-driven test in `loom-web`; update or delete every test referencing the mcp package across loom-core, loom-cli, and loom-web.
- **FR-11** — Update root `package.json` build/test scripts to drop the mcp workspace; update the npm publish workflow to stop publishing the mcp package.
- **FR-12** — Update all docs/positioning — `docs/capabilities.md` (drop MCP-as-server rows, the two-interfaces framing, `loom serve` and `loom init --mcp` entries, MCP tool listings, and first-class Claude Code/Cursor-via-MCP rows; reframe as CLI = usability, web = observability), plus `CLAUDE.md`, `README.md`, `docs/getting-started`, `docs/index.md`, and `docs/operations/releasing.md` — and scrub "mcp as a first-class citizen" / "primary surface" language repo-wide.

**Cross-cutting:**

- **FR-13** — A verification test/step lists the pre-removal `mcp__loom` tool inventory and asserts each tool maps to a CLI command — parity is proven, not asserted.
- **FR-14** — Error behavior: an unknown story id (`pull-guidance`), an unregistered project root (`project`), and a nonexistent epic id (`stop --epic`) each exit non-zero with a clear one-line message — never a stack trace.

## Non-Functional Requirements

- **NFR-1** — **Sequencing invariant.** No Phase 2 deletion may land before its Phase 1 CLI equivalent exists; CLI parity must be unbroken at every commit.
- **NFR-2** — **Search-defined done-ness.** After the change, the forbidden-string searches in Goal 2 return no hits except inside `docs/research/cursor-mcp-strictness.md` and the retained worker-provisioning code paths.

## Epics

This PRD breaks into **two ordered epics**; the order is load-bearing and Epic 2 depends on Epic 1.

1. **Epic 1 — CLI Parity Port (Phase 1).** Add CLI equivalents for every MCP-only capability so parity holds before any deletion. Covers FR-1 through FR-7, FR-13, FR-14. Independently shippable: it delivers a complete CLI even before removal.
2. **Epic 2 — Remove the loom MCP Server (Phase 2).** Delete the server, strip wiring and tests, fix build/test/publish, and scrub all positioning. Covers FR-8 through FR-12. Begins only once Epic 1 parity is verified.

## Out of Scope

- **Worker-facing MCP provisioning of approved third-party servers** — explicitly retained and untouched: `loom mcp add` / `loom mcp list`, `policy.mcp.registry`, the `McpRegistry` / `WorktreeMcp` / adapter modules in `packages/loom-core/src/mcp`, `CursorMcpEnforcer`, and `docs/research/cursor-mcp-strictness.md`.
- **Cleaning stale on-disk entries.** Phase 2 only stops *new* materialization of the loom server into worktree configs and removes the generation code. No migration scrubs loom-server entries already on disk in other repos; stale entries are acceptable and logged as a follow-up.
- **Any publishing action now.** The mcp package is dropped from future publishing by removal from the workflow and runbook only; `npm deprecate` is **not** run. Treated as a major version bump for our records only.
- **The "loom-as-a-server" integration use case** — mounting loom itself as an MCP server inside Claude Code or Cursor — is deliberately removed and not designed for.
