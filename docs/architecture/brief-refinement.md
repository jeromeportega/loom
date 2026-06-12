# Brief refinement — the gate before planning

`loom epic` (CLI) and `loom_start_epic` (MCP) both run a brief-quality
gate before the planner. The gate is a single Sonnet call against the
bundled `loom-brief-builder` skill that produces a structured critique
of the operator's brief; if the brief scores below
`policy.agents.min_brief_quality_score` (default 6/10), the planner
never runs and the critique is returned so the operator can tighten
the prompt and try again.

## The cost asymmetry it exists to fix

| Step | Cost | Bottleneck |
|---|---|---|
| Brief gate | 1 Sonnet call, ~10s, session-based | None |
| Plan epic (Analyst → PM → Architect) | 5+ Opus calls, several minutes, session-based | Expensive Opus turns |
| Execute epic (workers) | N × claude-cli runs, ~30 min each | Real time + session capacity |

Feeding a vague brief into the planner produces a vague plan, which
produces vague stories, which workers either over-engineer or under-edit.
The Sonnet refinement pass is ~1% the cost of one planning run and
catches most of the problems that would cascade through it.

## The shape

Internally the `BriefRefiner` returns:

```
{
  ready: boolean,
  quality_score: number,       // 0–10, derived from the critique
  refined_brief?: string,
  critique: {
    strong_points: string[],
    ambiguities: string[],
    missing_scope: string[],
    untestable_claims: string[],
    hidden_complexity: string[],
  },
  questions: string[],
  delta: {
    added_sections: string[],
    clarifications: Array<{ from: string; to: string }>,
    flagged_assumptions: string[],
  }
}
```

When `quality_score` is below the policy threshold:
- **CLI**: `loom epic` prints the questions, the critique categories
  with non-empty issues, and (when present) a suggested refined draft.
  Exits non-zero. The operator tightens the brief and re-runs.
- **MCP**: `loom_start_epic` returns
  `{status: "rejected", quality_score, min_quality_score, critique,
  questions, refined_brief, message}` so the chat client can walk the
  user through tightening the brief and re-call.

## Design choices worth noting

**The gate has a per-invocation escape hatch.** `loom epic --force`
(CLI) and `force: true` on `loom_start_epic` (MCP) override the gate
for that one run — the refiner still runs, its critique is still
produced, and a `brief_gate_forced` row is written to the audit log
before planning begins. It is an escape hatch, not a disable switch: it
applies to the single invocation and sets no standing bypass. The
*threshold* is also tunable (`policy.agents.min_brief_quality_score`,
1–10), so an operator can lower the bar permanently or wave a specific
brief through once. The mechanism teaches what a planning-ready brief
looks like and protects the planner spend.

**Single Sonnet call, not multi-turn.** Each gate run is stateless.
For chat clients, the loop is: brief → MCP returns critique →
client gathers user answers → re-call `loom_start_epic` with the
tightened brief. This keeps the gate cheap and the interactive
intelligence at the client (where it belongs).

**`ready: false` is the conservative default.** If the model returns
malformed JSON, missing fields, or anything unparseable, the
normalization layer falls back to `ready: false` with the problem in
`critique.ambiguities`. The user is never blocked by a tool error —
they're prompted to clarify.

**Bench harness drops the threshold.** SWE-bench Lite problem
statements are pre-structured GitHub issues; loom's brief rubric was
written for prose briefs and over-critiques them. `loom-bench`
overrides `min_brief_quality_score` to 1 per task so the bench
measures planner+worker quality, not the refiner's judgment of an
issue body.

## How it scales to cloud

The gate runs inside loom-core's `BriefRefiner` against whatever LLM
backend the policy specifies. Moving from session-based claude-cli to
a managed API service requires no contract change — the engine and
the policy knob stay the same.

## What this does NOT solve

- **The SWE-bench resolution rate.** Bench tasks ship with structured
  issues; the gate is dialed down for the bench anyway.
- **Bad ideas.** The gate surfaces ambiguity; it can't tell you that
  the feature itself isn't worth building. That's still a human call.
- **Planning stochasticity.** A perfectly-refined brief can still
  produce different epic structures across runs. That's a separate
  problem in the planner persona.
