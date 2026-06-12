# Epic-004 Shared Implementation Contract — Cursor Stream Parsing

## Shared interfaces & types

```ts
// packages/loom-core/src/orchestrator/CursorAgentWorker.ts
parseStreamLine(line: string): WorkerEvent | undefined;
```

## File & module ownership map

| Story | Owns (creates or sole editor) |
|---|---|
| story-004-001 | `packages/loom-core/src/orchestrator/BaseCliWorker.ts` · `packages/loom-core/src/orchestrator/CursorAgentWorker.ts` |
| story-004-002 | `packages/loom-core/src/orchestrator/configWarnings.ts` (new) · `packages/loom-core/src/orchestrator/workerFactory.ts` |
| story-004-003 | `packages/loom-core/src/orchestrator/WorkerTimeoutGuard.ts` |

**The rule:** a story may import from another story's files but must NOT modify them.
