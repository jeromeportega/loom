# PRD: Worker MCP Isolation — Allowlist-Only Servers, Materialized Per-Worktree, Audit-Logged

## Overview

Headless story workers currently inherit the developer's personal MCP servers from user-level config (`~/.cursor/mcp.json`), silently arming code-writing agents with the developer's Jira and internal-tool credentials, inflating worker spawn time and prompt size, and leaving no audit trace of what tools a worker held. This change makes the `loom mcp`-managed registry (`policy.mcp.registry`) the **exclusive** MCP allowlist for workers: at story worktree setup, loom materializes a worktree-local `.cursor/mcp.json` containing exactly the allowlisted servers, structurally excludes everything else per worker backend (explicit disables for cursor-cli; `--strict-mcp-config` for claude-code), and writes one audit row per worker spawn recording the exact server set before the worker starts. This is a deliberate behavior change for operators who relied on inherited servers; the migration path is `loom mcp add`.

## Goals

1. **Eliminate ambient credential exposure.** A worker spawned in a repo whose policy registry defines zero servers sees zero non-loom MCP servers, regardless of the developer's `~/.cursor/mcp.json` — verified on the cursor-cli backend.
2. **Make tool exposure deliberate.** 100% of MCP servers visible to a worker arrived via `loom mcp add`; no other source can add servers to a worker's config.
3. **Close the audit gap.** Every worker spawn writes an audit row containing its exact MCP server set, and that row exists before the worker process starts.
4. **Land the behavior change safely.** `docs/capabilities.md` states the exclusive-allowlist semantics with the operator-facing change and `loom mcp add` migration path called out prominently.

## User Stories

- **As a loom operator**, I want workers to load only the MCP servers I registered via `loom mcp add`, so that worker tool exposure is deliberate, minimal, and under my control. *(Must)*
- **As a developer running loom on my own machine**, I want my personal MCP servers and their credentials kept out of worker context, so that LLM-directed workers cannot act with my identity. *(Must)*
- **As a security reviewer**, I want each worker's MCP server set recorded in the audit log at spawn time, so that I can reconstruct after the fact what tools any worker was armed with. *(Must)*
- **As an operator who relied on inherited personal servers**, I want the change flagged prominently with a stated migration path, so that I can re-register the servers workers actually need. *(Should)*

## Functional Requirements

- **FR-1** — At story worktree setup, loom generates a worktree-local `.cursor/mcp.json` from `policy.mcp.registry`: registry contents in, nothing else. An empty registry produces a config exposing zero non-loom servers.
- **FR-2** — Servers registered via `loom mcp add` (persisted through `upsertMcpServer`) appear in every subsequently spawned worker's worktree `.cursor/mcp.json`.
- **FR-3** — Cursor-cli backend: at worktree setup, loom enumerates servers via `cursor-agent mcp list` and disables every non-allowlisted server via `cursor-agent mcp disable <name>`, run headlessly against the worktree, so user-level servers neither load nor prompt. Any strictness gap that cannot be closed headlessly is investigated and documented, with the upstream cursor-agent ask recorded as out of scope.
- **FR-4** — Claude-code backend: workers are spawned with `--strict-mcp-config --mcp-config <generated file>` (arg construction in `ClaudeCodeWorker.ts`).
- **FR-5** — Every worker spawn writes one audit row containing the exact set of MCP server names the worker was given, before the worker starts, mirroring how bash commands are logged. `[ASSUMPTION]` the existing `audit_log` table accommodates this payload without a schema migration.
- **FR-6** — A deliberate, documented decision is made on whether workers receive the loom MCP server itself. `[ASSUMPTION]` default is to exclude it, since the worker prompt has no use for it — confirmed against any dispatch-time dependency before shipping.
- **FR-7** — `docs/capabilities.md` is updated in the same change: the "Provision approved MCP servers for workers" row reflects exclusive-allowlist semantics, with the operator-facing behavior change and `loom mcp add` migration path stated prominently.

## Non-Functional Requirements

- **NFR-1** — Enforcement is structural, per worker backend, at worktree setup / spawn time. Isolation must hold regardless of LLM output or worker behavior; it is not prompt-based.
- **NFR-2** — Config-precedence behavior is verified, not assumed: `[ASSUMPTION]` a worktree-local `.cursor/mcp.json` plus explicit disables prevents user-level servers from loading, and `cursor-agent mcp disable` state is per-project (not user-global). Both must be verified early, before the enforcement design is finalized.

## Epics

This PRD breaks into **one epic**:

- **epic-001: Worker MCP isolation** — allowlist-only server materialization per worktree, backend-specific structural exclusion, and audit logging of each worker's server set.

## Out of Scope

- Planner/refiner MCP exposure — they run via LLM clients, not agent CLIs, today.
- Any new registry format; `policy.mcp.registry` is used as-is.
- Upstream cursor-agent feature work — a `--strict-mcp-config` equivalent for cursor-agent is recorded as an upstream ask, not built here.
- Preserving the undocumented inherit-personal-servers behavior; affected operators migrate via `loom mcp add`.
