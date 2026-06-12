# Epic-005 Shared Implementation Contract — Finalizer Lifecycle

## Shared interfaces & types

```ts
// packages/loom-core/src/orchestrator/EpicFinalizer.ts
finalize(epicId: string): Promise<FinalizeResult>;
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-005-001 | `packages/loom-core/src/types.ts` · `packages/loom-core/src/state/EpicStore.ts` |
| story-005-002 | `packages/loom-core/src/orchestrator/EpicFinalizer.ts` · `packages/loom-core/src/orchestrator/IntegrationGate.ts` |
| story-005-003 | `packages/loom-core/src/orchestrator/Supervisor.ts` |

**The rule:** a story may import from another story's files but must NOT modify them.
