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
  ready: boolean,             // DERIVED IN CODE — see "Code-derived readiness" below
  blocking_gaps: string[],    // model-emitted; empty [] when none
  quality_score: number,      // 0–10, model-emitted holistic score
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

The model emits `blocking_gaps` and `quality_score`; it no longer emits `ready`.
`ready` is synthesised in `normalize()` after the model call — see
[Code-derived readiness](#code-derived-readiness) below.

The gate produces three outcomes based on `quality_score` and `ready`:

| Outcome | Conditions | Meaning |
|---|---|---|
| `pass-clean` | `quality_score ≥ threshold` **and** `ready === true` | Brief is in the ready band (`quality_score ≥ READY_BAND_MIN = 7`) with no planning-blocking gaps. Planning proceeds without outstanding operator work. Minor optional questions may still be surfaced alongside a `pass-clean` verdict — they do not block readiness. |
| `pass-with-clarifications` | `quality_score ≥ threshold` **and** `ready === false` | Brief scored above the gate threshold but `ready` is `false` — either `quality_score` is below `READY_BAND_MIN` (7) or `blocking_gaps` is non-empty. Planning can be forced with `--force`, but the operator should address the flagged items first. |
| `below-threshold` | `quality_score < threshold` | Brief is too thin. The planner never runs. |

When the gate does not return `pass-clean`:
- **CLI**: `loom epic` prints the questions, the critique categories
  with non-empty issues, and (when present) a suggested refined draft.
  Exits non-zero. The operator tightens the brief and re-runs.
- **MCP**: `loom_start_epic` returns
  `{status: "rejected", quality_score, min_quality_score, critique,
  questions, refined_brief, message}` so the chat client can walk the
  user through tightening the brief and re-call.

## Code-derived readiness

`ready` is not emitted by the model. It is derived deterministically in code by
`deriveReady()` inside `normalize()`, after the model call returns:

```typescript
// packages/loom-core/src/brief/BriefRefiner.ts
export function deriveReady(
  qualityScore: number,
  blockingGaps: string[],
  readyBandMin: number,
): boolean {
  return qualityScore >= readyBandMin && blockingGaps.length === 0;
}
```

The model's job is to emit:
- **`quality_score`** — a holistic 0–10 assessment of planning readiness.
- **`blocking_gaps`** — an array of gaps so severe that the planner would have to
  invent requirements to proceed. An empty array `[]` when there are none. Minor
  ambiguities, optional clarifications, and scope nuances go into `critique.*` and
  `questions` instead, not into `blocking_gaps`.

`ready` then follows from those two model outputs: `true` when
`quality_score >= READY_BAND_MIN` **and** `blocking_gaps` is empty.

### Two distinct thresholds — do not conflate (ADR-005)

There are exactly two numeric thresholds in play; they serve different purposes and
must not be confused:

| Threshold | Source | Default | Role |
|---|---|---|---|
| `min_brief_quality_score` | `policy.agents.min_brief_quality_score` | **6** | Gate policy threshold. `evaluateBriefGate` compares `quality_score` against this value; below it, the planner never runs (`below-threshold`). Operator-tunable per repo. |
| `READY_BAND_MIN` | `src/brief/readyBand.ts` (= `BANDS.high[0]`) | **7** | High-band floor for `deriveReady()`. A brief must score **at or above 7** to be considered "in the ready band" for `ready=true`. A code constant — not a policy knob. |

A brief can pass the gate (`quality_score ≥ 6`, default) but still have
`ready === false` if `quality_score` is 6 (below `READY_BAND_MIN = 7`) or if
`blocking_gaps` is non-empty. That produces `pass-with-clarifications` rather than
`pass-clean`.

`READY_BAND_MIN` is the single source of truth for the high-band floor. It lives in
`src/brief/readyBand.ts` and is imported by `bands.ts` as `BANDS.high[0]` — the
two names refer to the same constant.

### Fail-closed behaviour on malformed output

If the model returns malformed JSON, a missing `blocking_gaps` field, or a
non-array value, `normalize()` coerces `blocking_gaps` to `[]` and the salvage /
fallback score paths clamp `quality_score` to values below `READY_BAND_MIN`:

- **Salvage path** (truncated response with a parseable `refined_brief` but no
  score): `quality_score` is set to `SALVAGE_QUALITY_SCORE = 3`. `3 < 7`, so
  `deriveReady` returns `false` regardless of `blocking_gaps`.
- **Full failure path** (unparseable response): `quality_score` is set to
  `FALLBACK_QUALITY_SCORE = 0`. Same result.

In both cases the user is never silently passed through — the refiner fails closed
without blocking on a tool error.

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

**`ready` is derived in code, not model-asserted.** Prior to story-036-001 the
model emitted a `ready` boolean directly; that created a single point where the
model's imprecise judgment of "readiness" could override the code's structural
checks. Now `ready` is a pure function of `quality_score` and `blocking_gaps` —
both of which the model still emits, but which are composed deterministically in
code. The model cannot assert `ready=true` while also emitting a blocking gap or a
low score. On malformed output the normalization layer is fail-closed (see above),
so a tool error never passes a brief through silently.

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
