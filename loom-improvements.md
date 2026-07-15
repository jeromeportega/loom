# Loom improvements log

A running record of significant changes delivered through the loom dogfood program.
Each entry corresponds to one completed epic.

---

## epic-095 — Decomposition-aware story orchestration (v6.16.x)

**Stories:** 095-001 through 095-007  
**Branch:** `epic/epic-095`

### What shipped

**Story schema extension (`provides` / `requires` / `estimated_effort`)**  
Three new optional fields on each story in the epic YAML:
- `provides` (object) — key→value outputs the story produces for downstream consumers.
- `requires` (object) — key→story-id map declaring upstream outputs this story depends on.
- `estimated_effort` (integer, minutes) — used to compute the critical path.

Pre-feature epics with none of these fields dispatch identically to the baseline.
DB schema bumped to v31 (`provides_output TEXT`, `resplit_count INTEGER`).

**Story-graph module (`storyGraph.ts`)**  
New module at `packages/loom-core/src/orchestrator/storyGraph.ts` exposing:
`buildStoryGraph`, `topologicalSort`, `detectCycles`, `findReadyStories`, `criticalPath`,
`StoryGraphCycleError`.  Powers the cycle gate, the Supervisor ready-story query, and
the critical-path display in `loom status` and the web kanban.

**Cycle rejection at `loom approve` (fail-closed)**  
Before any epic transitions to `approved`, `detectCycles` runs on the story dependency
graph.  A cycle causes approve to exit non-zero and print the ordered cycle path;
the epic stays in `planned`.  Covers both in-epic and cross-repo dependency cycles.

**Critical path in `loom status`**  
When story `estimated_effort` values are present, `loom status` emits a
`Critical path:` line listing the longest-duration dependency chain (ordered story IDs,
root first) and its total estimated wall-clock.  Epics without effort data suppress the
line entirely — existing script output is unchanged.

**Typed-requires validation and `LOOM_PROVIDES` parsing (Supervisor)**  
The Supervisor now:
- Blocks dispatch of a story whose `requires` keys are not yet satisfied.
- Injects resolved upstream `provides` values into the worker prompt.
- Parses a `LOOM_PROVIDES {"key": value}` trailer from worker stdout on completion.
- Stores the parsed blob in `agents.provides_output` (JSON).

**Runtime reroute-to-PM re-decomposition**  
When a worker emits `LOOM_TOO_BIG` or hits the capacity cap, the Supervisor calls the
PM agent to decompose the story into sub-stories, then injects them atomically into the
epic YAML and resumes normal dispatch.  Budget: 2 re-splits per story
(`MAX_RESPLIT_BUDGET`).

**Kanban critical-path highlighting (loom web)**  
`GET /api/fleet` now returns a `criticalPath: { chain, estimatedMinutes } | null` field
on each fleet card.  The React `EpicCard` component applies an amber ring to
critical-path story cards in the kanban view.

### Files added

- `packages/loom-core/src/orchestrator/constants.ts` — `LOOM_TOO_BIG_SIGNAL`, `MAX_RESPLIT_BUDGET`
- `packages/loom-core/src/orchestrator/storyGraph.ts` — story-graph DAG module
- `packages/loom-core/src/orchestrator/rerouteHandler.ts` — reroute-to-PM logic
- `packages/loom-core/src/orchestrator/epicCriticalPath.ts` — `loadEpicStories` helper
- `docs/architecture/story-graph.md` — architecture reference for storyGraph.ts
- `loom-improvements.md` — this file

### Key invariants

- All three new story fields are optional; backward compatibility is structural.
- Cycle detection is fail-closed: a cycle blocks approve unconditionally.
- `provides`/`requires` wiring is additive; no existing behavior changes when fields are absent.
- Reroute budget (2) is an engine constant; not an operator knob.
