# Story-graph module

The `storyGraph.ts` module (`packages/loom-core/src/orchestrator/storyGraph.ts`) provides
the DAG utilities that power decomposition-aware orchestration in loom.  It owns:

- building a directed acyclic graph from an epic's story list
- topological ordering for dependency-respecting dispatch
- cycle detection (used by `loom approve` to fail-close on cyclic plans)
- ready-story identification (stories whose dependencies are all complete)
- critical-path computation (longest-duration chain for `loom status` and the kanban highlight)

## Data model

```typescript
interface StoryGraph {
  nodes: Map<string, Story>;    // story-id → Story
  edges: Map<string, string[]>; // story-id → ids of stories it depends on
}

interface CriticalPathResult {
  chain: string[];         // ordered story-id array, root first
  estimatedMinutes: number; // 0 when no estimated_effort data present
}
```

The `edges` map stores **dependency** edges, not successor edges: an entry
`edges.get('story-B') = ['story-A']` means story-B depends on story-A.

## Exported functions

| Function | Purpose |
|---|---|
| `buildStoryGraph(stories)` | Builds a `StoryGraph` from the `Story[]` list; reads each story's `dependencies` array and `estimated_effort` field. |
| `topologicalSort(graph)` | Returns story IDs in an order safe for sequential dispatch; throws `StoryGraphCycleError` on a cycle. |
| `detectCycles(graph, opts?)` | Returns the cycle path as `string[]` (empty = acyclic). Called by `loom approve` before transitioning an epic to `approved`; never throws. |
| `findReadyStories(graph, completed)` | Returns stories whose every dependency is in the `completed` set — used by the Supervisor dispatch loop. |
| `criticalPath(graph)` | Computes the longest-duration path using `estimated_effort` as node weight; returns `estimatedMinutes: 0` when no effort data is present. |

## Error type

`StoryGraphCycleError` (extends `Error`) carries a `cyclePath: string[]` property
listing the cycle in the order it was detected.  `topologicalSort` throws it;
`detectCycles` returns the same array without throwing.

## Integration points

### `loom approve` — cycle gate

`packages/loom-cli/src/commands/gate.ts` (the approve path) calls `buildStoryGraph`
then `detectCycles` on the epic YAML before transitioning status to `approved`.
A non-empty cycle path causes approve to exit non-zero and print the cycle as
`story-A → story-B → story-A`, leaving the epic in `planned`.

### Supervisor dispatch loop

The Supervisor calls `findReadyStories(graph, completedSet)` at each tick to
determine which stories are eligible for dispatch.  Stories whose `requires`
dependencies are also satisfied (checked via `checkRequires` in `Supervisor.ts`)
are dispatched; others wait.

### `loom status` — critical path line

`packages/loom-cli/src/commands/status.ts` calls `buildStoryGraph` and
`criticalPath` to emit the `Critical path:` line in text output and the
`criticalPath` object in `--json` output.  The line is suppressed entirely when
the epic has no YAML or no dependency graph — existing script output is unchanged
for pre-feature epics.

### Fleet API — kanban highlight

`packages/loom-web/src/server/routes/fleet.ts` calls `loadEpicStories`
(from `epicCriticalPath.ts`) then `buildStoryGraph` and `criticalPath` to
populate the `criticalPath` field on each `FleetCard`.  The React `EpicCard`
component reads `criticalPath.chain` to apply an amber highlight ring to
critical-path story cards in the kanban view.

## Backward compatibility

All three new story fields (`provides`, `requires`, `estimated_effort`) are
optional in `StorySchema`.  An epic with no `estimated_effort` values produces
`estimatedMinutes: 0` and an arbitrary (but valid) `chain` from `criticalPath`.
An epic with no `dependencies` at all is a flat graph; `topologicalSort` returns
stories in insertion order and `detectCycles` returns `[]`.

Pre-feature epics (no `provides`, no `requires`, no `estimated_effort`) are
byte-identical in dispatch behavior to the baseline — no extra DB reads, no extra
PM calls, no prompt injection.
