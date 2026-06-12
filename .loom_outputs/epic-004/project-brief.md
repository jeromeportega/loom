# Observable cursor-cli Worker Backend: Streaming Output, Live Stall Signal, Fail-Fast Model Validation

## The Problem

Two distinct failures, both observed in an earlier epic-011 run, share one root: the cursor-cli worker backend is opaque to loom's supervision machinery.

**(a) The stall watchdog kills healthy workers.** `WorkerTimeoutGuard` (driven from `BaseCliWorker.spawnAgent`) terminates a worker after `story_stall_minutes` (default 12) of zero stdout/stderr. But `CursorAgentWorker` invokes `cursor-agent -p --output-format json`, which — per its own code comment — emits a single JSON object only on completion. A cursor-cli worker is therefore *silent by construction*, and any story that takes longer than the stall window is guaranteed to be killed mid-work. Observed: story-011-001 killed at 12m27s with substantial uncommitted work; five dependent stories cascaded to blocked. The stall signal, on this backend, currently measures nothing.

**(b) Invalid model ids fail late and illegibly.** An invalid `cursor_model` (e.g. `"fable-5"`) surfaces only after a full multi-minute LLM pass, as `cursor-agent exited 1: Cannot use this model: ...` — and the valid-model list in that message is truncated mid-word by the 500-char `output.slice(0, 500)` in `CursorCliClient.ts` (~line 65). The operator pays minutes to discover a typo, then can't read the list of correct values.

## Target Users

- **Primary:** loom operators running epics on the `cursor-cli` worker backend — the people who configure `cursor_model` and `story_stall_minutes` and absorb the cost of false kills.
- **Secondary:** anyone watching the dashboard's SSE live-output streams; downstream story agents that block when an upstream story is wrongly killed.
- **Anti-persona:** claude-code backend users. That backend's streaming already works and is explicitly out of scope.

## Proposed Solution

Make the cursor-cli backend emit, and loom consume, a live signal — and refuse obviously-broken configuration before spending money.

1. **Stream instead of batch.** Switch `CursorAgentWorker` to `cursor-agent --output-format stream-json --stream-partial-output` and adapt its `parseStreamLine` override to the streamed event shape. Stdout activity then resets the stall timer, restoring meaning to the stall signal. Preserve the existing usage/request-count harvesting (`requestCount: 1` per-session fallback) and human-readable live output for the dashboard SSE streams. Verify `BaseCliWorker`'s terminal-event detection and partial-line carry still hold under the new format.
2. **Backend-aware stall safety net.** Until/unless streaming is active, when `worker_backend: cursor-cli`: either default the effective stall window to the absolute cap, or emit a loud startup warning when `story_stall_minutes < story_absolute_cap_minutes`. A configuration that guarantees killing healthy workers must not be silently accepted.
3. **Fail-fast model validation.** Validate `cursor_model` (and the cursor-cli `planning_model` path) against `cursor-agent --list-models` output at `loom doctor` and at the start of `loom epic` / `loom run` on this backend — before any LLM pass runs. Stop truncating cursor-agent's stderr on non-zero exit; preserve it in full (or at a much larger bound), since it is the one message that lists the valid model ids.

## Key Capabilities

1. Cursor-cli workers stream incremental events; each event resets the stall timer.
2. Genuine silence is still fatal: a worker with no output for `story_stall_minutes` dies at the window, exactly as today.
3. Usage/request-count harvesting and dashboard live output survive the format switch unchanged in behavior.
4. Misconfigured stall windows on cursor-cli are defaulted to the cap or loudly flagged at startup.
5. Invalid model ids are rejected pre-spawn at `loom doctor`, `loom epic`, and `loom run`, with the complete valid-model list shown.
6. Non-zero cursor-agent exits surface full (or near-full) stderr.

## Constraints

- Tests live next to source under `__tests__/`; new code paths require coverage (stream-parsing fixture lines, backend-aware default/warning, validation path).
- `docs/capabilities.md` must be updated in the same change: progress-aware timeouts row (backend nuance) and `loom doctor` row (new check).
- **Non-goals:** no changes to claude-code backend streaming; no new policy knobs beyond what backend-aware defaults require; no retry-logic changes.

## Risks and Open Questions

- `[ASSUMPTION]` The installed `cursor-agent` supports `--output-format stream-json --stream-partial-output` and its event shape is stable enough to parse against fixtures. If event cadence has long quiet gaps during model generation, stall-timer resets may still be sparse — `--stream-partial-output` is the mitigation, but this needs empirical confirmation.
- `[ASSUMPTION]` Usage data is recoverable from the streamed events; if the stream format omits it, the `requestCount: 1` fallback must carry the load without regressing cost reporting.
- The brief leaves the safety-net design choice open: default-to-cap vs. loud warning. One must be chosen; default-to-cap is stronger protection, the warning is less surprising. Owner of this decision: implementer with PM sign-off.
- Behavior of `cursor-agent --list-models` when offline or unauthenticated is unspecified — validation must degrade clearly (actionable error) rather than crash or false-fail.
- Open question: once streaming lands and is verified, does the safety net (capability 4) remain as belt-and-braces or get retired? The brief's "until/unless" phrasing suggests it may be transitional.

## Success Criteria

- [ ] On the cursor-cli backend, a worker emitting incremental output is **not** killed by the stall timer, even when a story runs 3x the stall window.
- [ ] A story with `story_stall_minutes: 12` and genuine silence **is** killed at the 12-minute window.
- [ ] An invalid `cursor_model` is rejected — with the full valid-model list — before the brief refiner or any worker spawns.
- [ ] Tests exist under `__tests__/` covering: streamed-event parsing (fixture lines), the backend-aware default/warning, and the model-validation path.
- [ ] `docs/capabilities.md` reflects the backend nuance on progress-aware timeouts and the new `loom doctor` check.
