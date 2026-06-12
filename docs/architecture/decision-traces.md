# Decision traces

Loom's audit log captures **what** an agent did. The decision-trace
substrate captures **why**. Both are first-class persistent state with
distinct shapes, distinct consumers, and distinct retention rules.

## What gets captured

For every reasoning event an agent emits, loom persists a row in
`decision_traces` with:

| Field | Meaning |
|---|---|
| `agent_id` / `epic_id` / `story_id` | Which work the reasoning belongs to |
| `kind` | `thinking` \| `tool_intent` \| `plan_rationale` \| `pivot` |
| `subject` | The thing being decided about (tool name, file, story id) |
| `rationale` | The reasoning text itself — load-bearing field |
| `metadata` | Optional JSON-encoded structured context |
| `timestamp` | When the reasoning was produced |

## How it's populated

### Source 1 (today): worker thinking blocks

Claude's `--output-format stream-json` emits content blocks of type
`thinking` before each assistant turn. `ClaudeCodeWorker.parseStreamLine`
extracts them and the `Supervisor` records them to the table via
`assignment.onTrace`. Two trace shapes come out of this:

- `kind: 'thinking'` — a raw reasoning block.
- `kind: 'tool_intent'` — a thinking block immediately followed by a
  tool-use block. The thinking is captured as the rationale; the
  tool name lands in `subject`. Answers "why did the agent call Bash
  here?" without needing to reconstruct adjacency from the audit log.

### Source 2 (future): planner reasoning

The Analyst / PM / Architect personas don't currently emit thinking
blocks — they're invoked via the LLM client's `complete()` which uses
`--output-format json`, not `stream-json`. Migrating the planner to
stream-json (and capturing its thinking) would answer:

- Why did the PM choose 4 stories instead of 6?
- Why did the Architect propose this technical approach over alternatives?
- What did the Analyst surface as `[ASSUMPTION]` and why?

### Source 3 (future): pivot detection

When a worker abandons one approach mid-flight and switches to another,
loom could surface this as a `kind: 'pivot'` trace. Detection signal:
thinking blocks that explicitly say "let me try a different approach"
or that propose to undo a prior step. Heuristic; defer until the v1
capture path is in production use.

## How it's consumed

Three consumers today:

1. **Operators**, via `loom-web`:
   - `GET /api/agents/:id/traces` — replay one worker's reasoning timeline.
   - `GET /api/epics/:id/traces` — whole-epic timeline across all stories.
2. **Bench iteration** (Gate 1 diagnosis):
   - When a story fails with "exit 1, no commits," the trace timeline
     shows what the worker was reasoning about right before giving up.
     Without traces, this is opaque post-mortem.
3. **Skill generation** (future): the `SkillGenerator` could weight
   patterns it sees recur across MULTIPLE successful traces, not just
   the audit log of successful tool calls. Higher signal for what
   reusable skills should encode.

## Retention

Append-only. No edits, no deletes. Rationales above 16 KB are
truncated at write time (a runaway thinking block from a confused
worker shouldn't bloat the DB). The table indexes on `agent_id` and
`story_id` for fast per-agent / per-story replay.

## How this connects to the bench methodology

[Gate 1](../testing/bench-methodology.md#gate-1-diagnose-every-failure-before-proposing-a-fix)
asks the operator to classify every failure into a specific category.
Decision traces give the operator the evidence to do that — instead of
guessing "this looked like an under-edit failure," they can read the
worker's reasoning and confirm.

The flywheel:

```
failure → read traces → classify (Gate 1) → hypothesize fix (Gate 2)
                                                        ↓
                                                  measure shift → promote / reclassify
```

## What this isn't

- **Not a log**. Logs are streams of events; traces are reasoning
  attached to decisions. The audit log already captures the action.
- **Not prompts**. The system prompt is an INPUT to reasoning, not the
  reasoning itself.
- **Not stream-json verbatim**. The parser pulls thinking content and
  drops everything else (token counts, init events, rate-limit
  notifications). Traces are curated, not raw.

## What's NEXT

In rough priority order:

1. **Planner-side traces** — switch the LLM client to stream-json for
   planner calls; capture Analyst / PM / Architect thinking. Biggest
   value, biggest implementation lift.
2. **Review-agent traces** — `CodeReviewAgent` emits structured findings
   but no rationale for why it found them. Capturing thinking would
   tell us when the reviewer is being legitimately cautious vs. crying
   wolf.
3. **Replay UX in loom-web** — the `/api/agents/:id/traces` endpoint
   exists; the frontend should render it as a timeline alongside the
   audit log and diff.
4. **Trace search** — FTS5 over `rationale` so an operator can find
   "every time the agent considered the `Auth.validate` function."
