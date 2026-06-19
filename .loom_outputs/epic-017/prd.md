# Planning Phase Observability

## Overview

When loom plans an epic, it runs three planning personas — Analyst, Product Manager, then Architect — as headless subprocesses that take several minutes. Today the operator sees only a coarse phase label while raw output goes silent, turning the start of every epic into a multi-minute black box. Story execution already solves this for workers (rolling stdout buffer → durable flush → live SSE log pane → verbose terminal tail), but planning has no parity. This PRD specifies extending that *existing* worker-observability infrastructure to the planning path — capturing each persona subprocess's streaming output into a per-epic rolling buffer, recording the active persona, persisting it to durable state, and exposing it through the dashboard's live SSE log pane and a verbose flag on the planning command — without altering the personas or weakening any guardrail.

## Goals

1. **Eliminate the planning black box.** Operators can see live persona output during planning. *Metric:* persona stdout is visible in the dashboard log pane and (when verbose) the terminal as it is produced, not only after planning completes.
2. **Achieve observability parity by reuse, not reinvention.** Planning rides the existing rolling-buffer → durable-flush → SSE → verbose-tail pipeline. *Metric:* no parallel streaming mechanism is introduced; planning capture reuses the worker buffering approach.
3. **Preserve the concise default.** *Metric:* default (non-verbose) terminal output for the planning command is unchanged from current behavior; verbosity is strictly opt-in.

## User Stories

- **(Must)** As the loom operator running an epic, I want a live planning log alongside the phase label, so that I can confirm planning is progressing, see which persona is active, and tell when it stalls.
- **(Must)** As the loom operator, I want a verbose flag on the planning command that tails persona output in my terminal, so that I get the same local visibility I have with `run --verbose`.
- **(Should)** As a maintainer debugging the planning path, I want each persona's captured output retained in durable state, so that I have a persona-attributed diagnostic record when planning produces unexpected artifacts or hangs.
- **(Must)** As a casual CLI user, I want the default terminal output to stay concise, so that I am not drowned in persona output I did not ask for.

## Functional Requirements

- **FR-1** — Capture each planning persona subprocess's streaming stdout into a rolling buffer keyed to the epic being planned, using the same buffering approach the supervisor uses for worker output.
- **FR-2** — Record which persona (Analyst / PM / Architect) is currently producing output, so captured output is attributable to its source.
- **FR-3** — Flush the per-epic planning buffer to durable state so progress is observable live and inspectable after the fact.
- **FR-4** — For an epic in the planning phase, the web dashboard shows a live planning log pane fed by the existing SSE streaming mechanism, updating as output is produced, displayed alongside the existing phase indicator.
- **FR-5** — The planning command supports a verbose flag that tails planning output in the terminal as it is produced, mirroring the `run` command's verbose mode.
- **FR-6** — The default (non-verbose) planning command terminal output remains concise.
- **FR-7** — The existing coarse phase label continues to function unchanged, layered alongside the new live log.

## Non-Functional Requirements

- **NFR-1 — No secret leakage.** Captured and streamed planning output must not expose secrets; the redaction the worker stream already applies must extend to planning output `[ASSUMPTION: existing worker-stream scrubbing is the correct and sufficient mechanism — verify coverage for any persona-specific sensitive material such as API responses]`.
- **NFR-2 — No guardrail weakening.** No invariant or guardrail may be relaxed to ship this feature.
- **NFR-3 — Reuse mandate.** The feature must build on the existing rolling-buffer, durable-flush, SSE, and verbose-tail infrastructure; a parallel streaming mechanism is disallowed.
- **NFR-4 — Backward-compatible phase label.** The existing coarse phase indicator must continue to work without regression.

## Epics

- **Epic 1: Planning Phase Observability** — Extend worker-observability infrastructure to capture, persist, and stream planning persona output to the web dashboard and verbose terminal mode. (Single cohesive observability layer; one epic.)

## Out of Scope

- Any change to the planning personas themselves or the briefs/PRDs/architecture artifacts they produce — this is purely an observability layer.
- Building a new or parallel streaming mechanism instead of reusing the worker pipeline.
- A defined retention/expiry policy for planning logs after planning completes `[ASSUMPTION: retention is unspecified in the brief and deferred; logs persist at least as long as worker output does by reusing the same durable store]`.
- Per-persona cleanly-segmented log stores beyond a single epic-scoped buffer with an active-persona marker, unless the architect determines segmentation is required.
