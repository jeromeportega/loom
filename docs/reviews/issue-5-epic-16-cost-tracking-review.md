---
title: "Issue #5 — Staff Engineer Review (Epic 16 cost tracking spine)"
reviewer: Claude (Opus 4.7)
date: 2026-05-23
status: reviewed
scope: "story-016-004 (worker token tracking via stream-json), story-016-005 (per-story budget halt), story-016-006 (loom cost dashboard). Stories 001/002/003 (context manifests / repo digest / diff-first prompts) are EXPLICITLY DEFERRED — see Findings."
---

# Issue #5 Review — Cost Tracking Spine

Epic 16's six stories split into two halves: a TRACKING spine (004 / 005 /
006) and a CONTEXT spine (001 / 002 / 003). This change ships the tracking
spine end-to-end. The context spine touches the worker prompt template and
the way skills hand off context to agents — that's its own design pass.

## What shipped

### story-016-004 — worker token tracking

- **`ClaudeCodeWorker` now uses `--output-format stream-json --verbose`.**
  Each JSON-line event is parsed by `parseStreamLine` (newly protected
  virtual on `BaseCliWorker`). The parser:
  - Extracts text deltas from `type:'assistant'` events for live output.
  - Surfaces tool-use markers like `[tool: Bash]` instead of dumping raw JSON.
  - Captures interim and final `usage` snapshots; the final `type:'result'`
    event carries `total_cost_usd`.
- **`WorkerUsage` type** in `WorkerRunner.ts`. Lives on `WorkerResult.usage`.
- **Line-buffered stdout parsing** in `BaseCliWorker.spawnAgent` so partial
  JSON lines don't break the parser. Trailing carry is flushed on close.
- **CursorAgentWorker** is unchanged at the protocol level — its default
  `parseStreamLine` falls through to the passthrough, so usage stays
  undefined for the Cursor backend (a Find below).
- **Schema v10**: `agents.tokens_input / tokens_output / tokens_cached /
  tokens_cache_creation / cost_usd` columns; `AgentStore.setUsage()`
  persists from the Supervisor on every story result.

### story-016-005 — per-story budget halt

- **`policy.agents.budget_tokens_per_story`** was declared but unused
  before. Now it threads through `workerFactory → BaseCliWorker.spawnAgent`.
  After each parsed event with usage, the cumulative `totalTokens` is
  compared to the budget; if exceeded, the subprocess is SIGTERM'd and the
  spawn result's `budgetExhausted=true` flag propagates to
  `WorkerResult.budgetExhausted`.
- **Supervisor** writes a `budget_exhausted` audit row when the worker
  reports this, alongside the failed status.

### story-016-006 — `loom cost`

- **`loom cost`** CLI subcommand. Per-epic table with planner tokens,
  worker tokens, PR count, retries, tokens-per-PR, and worker cost in USD
  when reported by the CLI. Optional `--epic <id>` filter and `--by-day`
  rollup. Aggregates agent rows; treats multiple agents for the same
  `story_id` as retries.

## Findings

### Medium

**1. Cursor backend gets no usage data.** `cursor-agent --output-format json`
returns a single blob; we don't parse it for tokens today. Cursor users will
see `–` in the cost dashboard and won't get budget enforcement. Mitigation:
explicit in the policy comment that budget enforcement requires claude-code;
re-revisit when Cursor stabilizes its JSON usage shape.

**2. Output behavior for `loom run` changed.** The worker's live output was
the raw text Claude prints; now it's parsed assistant deltas + tool-use
markers + a `(result)` summary line. Strict improvement in readability for
the run printer, but operators who scraped the raw stdout will see a
different format. Acceptable — that scrape was never a stable interface.

**3. Budget gate fires only when usage is reported.** If the claude CLI's
`type:'assistant'` events stop arriving (e.g., a tool-use turn that takes
several minutes), the budget is not checked during that gap. The story
could overrun budget by however much one assistant turn costs before the
next event lands. Mitigated by the existing `timeoutMs` worker-wide cap.
Acceptable for v1; a proper fix requires the API to expose mid-turn usage.

**4. Re-prompt token cost is part of the worker's running total, not
separated.** In `block-and-revise` mode, the re-prompt calls re-spawn the
worker — those tokens accumulate to the same `accumulatedUsage`. `loom
cost` sees the total. That's the right semantic (each story has a total
cost), but the cost dashboard does not break out review-driven revision
cost from initial-implementation cost. Acceptable.

### Low

**5. The cost dashboard's "budget exhausted" detection greps `log_tail`.**
Brittle. A better path is to count audit rows with
`action='budget_exhausted'`, which is now persisted. Would replace the
regex if the dashboard grows. Not worth a fix now — works for v1.

**6. `loom cost --by-day` uses `started_at ?? updated_at` for grouping.**
Two agent retries on the same story will appear on different days if they
ran across midnight. Acceptable for a v1 dashboard.

### Explicit deferrals

- **story-016-001 (context manifests per skill)**: requires changes to the
  worker prompt template and SKILL.md schema. The schema change is breaking
  for hand-authored skills. Needs its own issue + design.
- **story-016-002 (repo digest)**: needs a static repo-mapper utility; new
  bundled skill or new core module. Out of scope.
- **story-016-003 (diff-first worker prompts)**: depends on 002. Out of
  scope.

I will file a follow-up issue for the context spine before closing #5.

## Tests

11 new test cases; 325 total passing.

- `WorkerUsage.test.ts` (new): parser for `result`, `assistant`, `system
  init`, non-JSON fallback, silent event types.
- `Supervisor.test.ts` (extended): persists usage to `agents.tokens_*` and
  `agents.cost_usd`; writes `budget_exhausted` audit row on flag.
- `WorkerReview.test.ts` (extended): propagates `accumulatedUsage` through
  to `WorkerResult.usage` (parser-driven path).
- `MockWorkerRunner` now passes through `review`, `usage`, and
  `budgetExhausted` when they're set on the fixture.

## Files changed

- `packages/loom-core/src/state/Database.ts` (schema v10 + 5 columns)
- `packages/loom-core/src/state/AgentStore.ts` (setUsage)
- `packages/loom-core/src/types.ts` (AgentRecord + StatusTree)
- `packages/loom-core/src/orchestrator/BaseCliWorker.ts` (parseStreamLine
  + line buffer + budget gate)
- `packages/loom-core/src/orchestrator/ClaudeCodeWorker.ts` (stream-json
  args + parser)
- `packages/loom-core/src/orchestrator/WorkerRunner.ts` (WorkerUsage)
- `packages/loom-core/src/orchestrator/workerFactory.ts` (budget pass-through)
- `packages/loom-core/src/orchestrator/Supervisor.ts` (persist + audit)
- `packages/loom-core/src/orchestrator/MockWorkerRunner.ts` (passes review/usage)
- `packages/loom-cli/src/commands/run.ts` (budget wiring)
- `packages/loom-cli/src/commands/cost.ts` (new)
- `packages/loom-cli/src/commands/init.ts` (yaml template)
- `packages/loom-cli/src/index.ts` (cost subcommand)
- `packages/loom-mcp/src/tools/handlers.ts` (budget wiring)
- `packages/loom-core/src/__tests__/WorkerUsage.test.ts` (new)
- `packages/loom-core/src/__tests__/Supervisor.test.ts` (extended)
- `packages/loom-core/src/__tests__/WorkerReview.test.ts` (extended)
