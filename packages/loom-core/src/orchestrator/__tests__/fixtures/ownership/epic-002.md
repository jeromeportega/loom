# Epic-002 Shared Implementation Contract — Worktree MCP Materialization

## Shared interfaces & types

```ts
// packages/loom-core/src/mcp/WorktreeMcp.ts
export function materializeWorktreeMcpConfig(loomServerEntry: McpJsonEntry): void;
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-002-001 | `packages/loom-core/src/mcp/WorktreeMcp.ts` (new) · `packages/loom-core/src/mcp/__tests__/WorktreeMcp.test.ts` |
| story-002-002 | `packages/loom-core/src/orchestrator/CursorMcpEnforcer.ts` (new) |
| story-002-003 | `packages/loom-core/src/orchestrator/ClaudeCodeWorker.ts` · `packages/loom-core/src/orchestrator/Supervisor.ts` |
| story-002-004 | `packages/loom-core/src/mcp/adapter.ts` |

**The rule:** a story may import from another story's files but must NOT modify them.
