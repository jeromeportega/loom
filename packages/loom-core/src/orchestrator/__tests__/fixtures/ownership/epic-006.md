# Epic-006 Shared Implementation Contract — Infra Retry & Resilience

## Shared interfaces & types

```ts
// packages/loom-core/src/orchestrator/InfraRetryController.ts
export class InfraRetryController { /* ... */ }
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-006-001 | `packages/loom-core/src/orchestrator/resilience/constants.ts` (new) · `packages/loom-core/src/orchestrator/resilience/RetryClock.ts` (new) |
| story-006-002 | `packages/loom-core/src/orchestrator/InfraFailureClassifier.ts` (new) · `packages/loom-core/src/state/Database.ts` |
| story-006-003 | `packages/loom-core/src/orchestrator/InfraRetryController.ts` (new) |
| story-006-004 | `packages/loom-cli/src/commands/retry.ts` (new) |

**The rule:** a story may import from another story's files but must NOT modify them.
