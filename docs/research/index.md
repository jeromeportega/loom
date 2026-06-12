# Research

Exploratory investigations that inform — but do not yet drive —
implementation. Each entry is a self-contained technical research report;
not all reports lead to features, and that is intentional. The Research
section is where loom thinks through hard mechanism questions before
committing them to the architecture.

## Reports

| Date | Topic | Status | Summary |
|---|---|---|---|
| 2026-06-11 | [cursor-agent MCP strictness — precedence, per-project disable durability, residual gap](./cursor-mcp-strictness.md) | accepted | Spike behind story-002-002. Establishes that `cursor-agent` *merges* user-global and project `.cursor/mcp.json` (project does not suppress user-global), and that `mcp disable` is per-project and durable (clears the ADR-2 gate). Documents the residual denylist/race gap versus claude's `--strict-mcp-config` and records the upstream ask as out of scope. |
| 2026-06-01 | [Live agent guidance — course-correcting headless workers mid-spawn](./live-agent-guidance.md) | draft | Investigates seven mechanisms for shrinking operator-guidance pickup latency from "per-revision" to "between tool calls". Recommends `claude --input-format stream-json` stdin injection as the smallest viable change; an `anthropic-api`-side abort+resume migration and an MCP `loom_pull_guidance` fallback for cursor-cli as the longer arc. |

## How this section differs from Architecture

- **Architecture** documents how loom *is* assembled today. Stable, factual,
  matches `main`.
- **Research** documents how loom *might* solve a problem the team has not
  yet committed to. Speculative, exhaustive, options-comparing.

A research doc that motivates a shipped change should be linked from the
relevant Architecture doc as the design rationale.
