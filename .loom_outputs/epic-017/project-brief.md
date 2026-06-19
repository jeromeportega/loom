# Planning Phase Observability

## The Problem

When loom plans an epic, it runs three planning personas — Analyst, then Product Manager, then Architect — as headless subprocesses that take several minutes to complete. During that window the operator is flying blind: the system surfaces only a coarse phase label, and even the raw command output falls silent after an initial start message. There is no way to tell what a persona is actually doing, whether the run has stalled, or how far along it is.

This is a notable inconsistency in the product. Story execution already solves exactly this problem for workers: the supervisor keeps a rolling stdout buffer flushed to durable state, the web dashboard streams it live over server-sent events (SSE) into a log pane, and a verbose terminal flag tails it locally. Planning has none of that parity. The result is a multi-minute black box at the very start of every epic — the moment an operator most wants confidence that things are progressing.

## Target Users

- **Primary — the loom operator running an epic.** Drives planning from the CLI and/or watches the web dashboard. Needs live, trustworthy signal that planning is advancing, which persona is active, and where it is if it stalls.
- **Secondary — the maintainer / contributor debugging the planning path.** Wants the persona-by-persona output as a diagnostic record when planning produces unexpected artifacts or hangs. The maintainer explicitly requested both web-interface planning logs and better under-the-hood feedback.
- **Anti-persona — the casual CLI user.** Should *not* be drowned in persona output by default. The concise, single-line-ish default terminal experience must be preserved; verbosity is strictly opt-in.

## Proposed Solution

Extend the existing worker-observability infrastructure to cover the planning path, rather than building a parallel mechanism. Capture each planning persona subprocess's streaming stdout into a rolling buffer associated with the epic being planned, flush it to durable state, and record which persona is currently producing output. Then expose that captured stream through the two channels operators already use: the web dashboard's live SSE log pane, and a verbose terminal flag on the planning command. The coarse phase label remains as a stable, low-resolution indicator layered alongside the new live log.

## Key Capabilities

1. **Per-epic planning buffer** — capture the streaming stdout of each planning persona subprocess into a rolling buffer keyed to the epic, using the same buffering approach the supervisor uses for worker output.
2. **Active-persona tracking** — record which persona (Analyst / PM / Architect) is currently producing output, so the log is attributable.
3. **Durable flush** — persist the planning buffer to durable state so progress is live *and* inspectable after the fact.
4. **Live web log pane** — for an epic in the planning phase, show a live planning log pane in the dashboard, fed by the existing SSE streaming mechanism, updating as output is produced, alongside the existing phase indicator.
5. **Verbose terminal mode** — give the planning command a verbose flag that tails planning output in the terminal as it is produced, mirroring the `run` command's verbose mode.
6. **Concise default** — keep the default (non-verbose) terminal output concise.
7. **Phase-label continuity** — keep the existing coarse phase label working unchanged.

## Constraints

- **No changes to the personas or their artifacts.** The planning personas themselves and the briefs/PRDs/architecture they produce are out of scope. This is purely an observability layer.
- **Reuse, do not reinvent.** Build on the existing rolling-buffer, durable-flush, SSE, and verbose-tail infrastructure that powers worker output. A parallel streaming mechanism is explicitly disallowed.
- **Concise by default.** Verbose output must be opt-in; the default terminal experience stays terse.
- **No secret leakage.** Captured and streamed planning output must not expose secrets.
- **No guardrail weakening.** No invariant or guardrail may be relaxed to ship this.
- **Backward-compatible phase label.** The existing coarse phase indicator must continue to function.

## Risks and Open Questions

- **Worker-stream coupling assumptions.** The worker streaming pipeline (rolling buffer → DB flush → SSE) `[ASSUMPTION]` assumes a long-lived supervisor owning a worker process. Planning subprocesses are shorter-lived and run in sequence; the buffer/flush lifecycle may need an epic-scoped owner rather than a per-worker one. Worth confirming where the planning subprocesses are launched and whether an equivalent owning component exists.
- **Buffer keying and persona transitions.** `[ASSUMPTION]` A single epic-scoped buffer with a recorded "active persona" marker is sufficient, with persona boundaries delimited inline. If consumers need cleanly separated per-persona logs, the data model may need per-persona segmentation instead.
- **Durable state shape.** Whether the existing worker-output table/columns can be reused for planning output, or whether a planning-specific store is needed, is an open question for the architect.
- **Secret-scrubbing parity.** `[ASSUMPTION]` Whatever redaction the worker stream already applies extends to planning output; if planning personas emit different sensitive material (e.g., API responses), scrubbing coverage should be re-verified.
- **Dashboard state for planning epics.** The dashboard must render a live log pane for an epic that has no stories yet (planning phase). How the existing pane keys to a planning epic versus an executing one is an open question.
- **Retention.** Whether planning logs persist after planning completes, and for how long, is unspecified.

## Success Criteria

- During planning, each persona's streaming output is captured into durable, per-epic state using the same buffering approach as worker output, and the currently active persona is recorded.
- The web dashboard shows a live planning log pane for an epic in the planning phase, fed by the existing SSE streaming mechanism, updating as each persona produces output, displayed alongside the existing phase indicator.
- The planning command supports a verbose mode that tails planning output in the terminal as it is produced; the default (non-verbose) output stays concise.
- The coarse phase label continues to work unchanged.
- No secrets are leaked through captured or streamed planning output, and no guardrail is weakened.
- The full build and test suite pass.
