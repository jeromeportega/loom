# Epic-001 Shared Implementation Contract — Brief-Quality Gate

## Shared interfaces & types

```ts
// packages/loom-core/src/brief/gate.ts
export function evaluateGate(refinement: BriefRefinement, force: boolean): GateVerdict;
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-001-001 | `packages/loom-core/src/brief/gate.ts` (new) · `packages/loom-core/src/brief/__tests__/gate.test.ts` |
| story-001-002 | `packages/loom-core/src/brief/BriefRefiner.ts` · `packages/loom-core/src/brief/types.ts` |
| story-001-003 | `packages/loom-cli/src/commands/epic.ts` · `packages/loom-cli/src/index.ts` (--force wiring) |
| story-001-004 | `packages/loom-mcp/src/tools/registry.ts` (loom_start_epic force param) |
| story-001-005 | `packages/loom-core/src/state/AuditLog.ts` |

**The rule:** a story may import from another story's files but must NOT modify them.
