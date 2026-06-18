# MCP Server Removal Notes

The `loom serve` command and the `@loom-ai/mcp` package were removed in epic-002
(story-003-001). This document records the rationale and migration path.

## Rationale

Loom's MCP server exposed the same operations as the CLI over the stdio MCP protocol,
but the CLI already provides full parity via `--json` flags. Maintaining two surfaces
(CLI + MCP) for the same functionality added complexity without meaningful benefit:

- Every new feature had to be wired into both surfaces.
- The MCP server required a persistent stdio process, complicating the "stateless CLI"
  mental model.
- No production workload was observed using the MCP server path; all integrations had
  migrated to the CLI.

## What was removed

- `packages/loom-mcp/` — the entire `@loom-ai/mcp` workspace package.
- `loom serve` CLI command — the entry point that started the MCP server.
- `.mcp.json` init step — `loom init` no longer writes an MCP config entry.
- Dead code that injected a loom MCP server entry into worker worktrees
  (`MaterializeOptions.loomServerEntry`, `SupervisorOptions.loomServerEntry`,
  `ALWAYS_ALLOWED='loom'` in `CursorMcpEnforcer`) — cleaned up in epic-016.

## Migration

| Before | After |
|---|---|
| `loom serve` → MCP client calls `loom_get_status` | `loom status [--json]` |
| `loom serve` → MCP client calls `loom_start_epic` | `loom epic "<brief>"` |
| `loom serve` → MCP client calls `loom_approve_plan` | `loom approve <epic-id> [--run]` |
| `loom serve` → MCP client calls `loom_get_diff` | `loom diff <id>` |
| `loom serve` → MCP client calls `loom_get_review` | `loom review <story-id>` |
| `loom serve` → MCP client calls `loom_get_audit_log` | `loom audit [--story <id>]` |
| `loom serve` → MCP client calls `loom_get_planning_artifacts` | `loom artifacts <epic-id>` |
| Worker reads guidance via MCP | `loom pull-guidance <story-id>` or `.loom/guidance/<story-id>.md` |

See `docs/capabilities.md` for the current CLI surface.
