# PRD: Observable cursor-cli Worker Backend

## Overview

The cursor-cli worker backend is opaque to loom's supervision machinery, producing two operator-facing failures observed in an earlier epic-011 run: (a) `WorkerTimeoutGuard` kills healthy workers because `cursor-agent -p --output-format json` emits output only on completion, so any story outlasting `story_stall_minutes` is killed mid-work and its dependents cascade to blocked; (b) an invalid `cursor_model` fails only after a full multi-minute LLM pass, with the valid-model list truncated by a 500-char stderr slice. This PRD makes the backend observable — streamed events that feed the stall timer — and makes broken configuration fail before money is spent.

## Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G-1 | Eliminate false stall kills on cursor-cli | A worker emitting incremental output survives a story running 3x the stall window (test-verified); zero stall kills of actively-working agents |
| G-2 | Preserve genuine-stall detection | A worker with zero output for `story_stall_minutes` is killed at the window, identical to today |
| G-3 | Fail-fast on invalid model ids | Invalid `cursor_model` rejected before the brief refiner or any worker spawns; detection cost drops from minutes of LLM time to seconds |
| G-4 | Legible failure output | On rejection, the operator sees the complete valid-model list; non-zero cursor-agent exits surface full (or near-full) stderr |

## User Stories

- **US-1 (Must):** As a loom operator running epics on cursor-cli, I want workers to stream incremental output that resets the stall timer, so that long-running healthy stories are not killed by the watchdog.
- **US-2 (Must):** As a loom operator, I want `cursor_model` (and the cursor-cli planning model) validated against `cursor-agent --list-models` at `loom doctor` and at the start of `loom epic` / `loom run`, so that a typo costs seconds, not minutes.
- **US-3 (Must):** As a dashboard watcher, I want live output and usage/request-count reporting to behave exactly as before the format switch, so that observability does not regress.
- **US-4 (Should):** As a loom operator, I want a loud startup warning when my stall configuration guarantees killing healthy cursor-cli workers, so that I never silently run a self-defeating config.

## Functional Requirements

- **FR-1:** `CursorAgentWorker` invokes `cursor-agent` with `--output-format stream-json --stream-partial-output`, and its `parseStreamLine` override parses the streamed event shape (verified against fixture lines).
- **FR-2:** Each streamed stdout event resets the stall timer; a cursor-cli worker emitting incremental output is not killed by `WorkerTimeoutGuard` even when a story runs 3x the stall window.
- **FR-3:** Genuine silence remains fatal: a cursor-cli worker with no output for `story_stall_minutes` is terminated at the window, exactly as today.
- **FR-4:** Usage/request-count harvesting (including the `requestCount: 1` per-session fallback) and human-readable dashboard SSE live output survive the format switch with unchanged behavior.
- **FR-5:** `BaseCliWorker`'s terminal-event detection and partial-line carry are verified to hold under the stream-json format.
- **FR-6:** When `worker_backend: cursor-cli` and `story_stall_minutes < story_absolute_cap_minutes`, loom emits a loud startup warning naming both values and the risk. *(Decision: warning chosen over default-to-cap — streaming in this same release restores the stall signal's meaning, and silently raising the window to the cap would weaken genuine-silence protection (G-2). PM sign-off given.)*
- **FR-7:** `cursor_model` and the cursor-cli `planning_model` are validated against `cursor-agent --list-models` output at `loom doctor` and at the start of `loom epic` / `loom run`, before any LLM pass; rejection shows the complete valid-model list.
- **FR-8:** When `--list-models` itself fails (offline, unauthenticated), validation degrades to an actionable warning/error rather than crashing or false-failing a valid configuration.
- **FR-9:** On non-zero cursor-agent exit, stderr is preserved in full or at a much larger bound than the current 500 chars, sufficient to show the complete valid-model list.

## Constraints

- Tests live next to source under `__tests__/`; new code paths require coverage: streamed-event parsing fixtures, the backend-aware warning, and the model-validation path (including the degraded `--list-models` case).
- `docs/capabilities.md` is updated in the same change: backend nuance on the progress-aware timeouts row, and the new `loom doctor` check row.

## Epics

1. **epic-001 — Observable cursor-cli worker backend** (single epic: one cohesive change to one backend's observability and validation path)

## Out of Scope

- claude-code backend streaming — already works; explicitly excluded.
- Retry-logic changes of any kind.
- New policy knobs beyond what the backend-aware warning requires.
- Retiring the stall safety net post-streaming — the brief's "until/unless" question is deferred; V1 ships warning + streaming as belt-and-braces.
- `[ASSUMPTION]` Stream event cadence during long model generation is sufficient to reset the stall timer; `--stream-partial-output` is the mitigation. Empirical confirmation is part of implementation, not a separate scope item.
