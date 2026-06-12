# Epic-003 Shared Implementation Contract — Gate Command Resolution

## Shared interfaces & types

```ts
// packages/loom-core/src/orchestrator/GatePreflight.ts
export function resolveGateCommand(projectRoot: string): ResolvedGateCommand;
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-003-001 | `packages/loom-core/src/orchestrator/GatePreflight.ts` (new) · `packages/loom-core/src/orchestrator/IntegrationGate.ts` |
| story-003-002 | `packages/loom-core/src/orchestrator/GateDryRun.ts` (new) · `packages/loom-core/src/orchestrator/git.ts` |
| story-003-003 | `packages/loom-cli/src/commands/doctorGateCheck.ts` (new) · `packages/loom-cli/src/index.ts` (doctor flag) |

**The rule:** a story may import from another story's files but must NOT modify them.
