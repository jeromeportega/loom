# Stall-Resilient Execution: Automatic In-Run Resume & Stall Diagnostics

## The Problem

Loom can now *detect* a stalled worker fast — the tighter liveness bound that terminates a hung model-request stream shipped in epic-030 and is live. But detection only stops the bleeding; it does not heal the run. Today, when a worker is killed by a no-output stall or by hung-request detection, the story is left failed and a **human must notice and manually re-run it**. That manual step defeats the purpose of unattended, autonomous operation: a run that should complete on its own instead parks until an operator intervenes.

A second gap compounds the first: when a kill happens, loom records that it happened but not *why* in actionable detail. Operators cannot distinguish a model request that hung with no response from a fully silent subprocess, cannot see the last stream event before the kill, and cannot tell how many times automatic recovery has already been attempted. Stalls are therefore hard to diagnose and tune after the fact.

## Target Users

- **Primary — Loom operators running unattended epics.** They want a run to recover from transient stalls and hung requests without babysitting, and they want failures (when they do occur) to be diagnosable.
- **Secondary — Loom maintainers tuning stall/hung-request thresholds.** They need audit-grade diagnostics to calibrate the liveness bound, stall window, and attempt cap against real failure patterns.
- **Anti-persona — the genuinely-stuck story.** A story that fails deterministically on every attempt must *not* be served by this feature. The design must let it fail cleanly rather than loop forever consuming run budget.

## Proposed Solution

Close the loop between detection and recovery by adding **automatic in-run resume** on top of the existing recovery machinery, and **stall diagnostics** to the audit trail.

When a worker is killed by a stall or hung-request detection *and* its work was checkpoint-committed, loom automatically re-dispatches that story from its checkpoint **within the same run**, feeding the existing handoff so the resumed worker continues rather than restarts. Recovery re-enters the existing manual-retry preparation path with a non-clean resume — it is the same path a human re-run would take, not a new parallel recovery path. The behavior is bounded by the existing automatic-resume attempt-cap policy knob, enforced by a **run-scoped, non-persisted attempt counter** so the bound applies only within a single run.

In parallel, every stall and hung-request kill records richer audit detail so the cause and recovery history of each kill are visible after the fact.

## Key Capabilities

1. **Auto re-dispatch from checkpoint within the same run.** On a stall/hung-request kill with a checkpoint commit, re-dispatch the story from that checkpoint with no manual re-run.
2. **Resume via existing handoff.** Feed the existing handoff so the resumed worker continues prior work rather than restarting from scratch.
3. **Reuse the manual-retry preparation path with a non-clean resume.** The next dispatch builds the prompt with the handoff included — no parallel recovery code path is introduced.
4. **Bound by the existing attempt-cap knob.** Enforce the limit with a run-scoped, non-persisted counter; on cap exhaustion, leave the story failed.
5. **Fail rather than dirty-resume when no checkpoint exists.** Absent a checkpoint commit, leave the story failed instead of resuming uncommitted work.
6. **Record stall/hung-request diagnostics.** For each kill, audit: (a) hung-request-with-no-response vs. fully-silent-subprocess, (b) the last stream event seen before the kill, and (c) which automatic resume attempt this was.
7. **Keep the capabilities surface current.** Document automatic in-run resume in `docs/capabilities.md` and pass the drift check.

## Constraints

- **Reuse, do not reinvent.** Build entirely on the existing checkpoint, handoff, auto-retry-budget, and manual-retry-preparation machinery. Do **not** introduce a parallel recovery path.
- **Run-scoped, non-persisted counter.** The attempt bound must apply per-run only; it must not persist across runs.
- **Do not touch detection or thresholds.** The hung-request detection logic and the existing stall window and absolute cap are out of scope and must remain unchanged.
- **Guardrails are inviolable.** No guardrail may be weakened. (Per repo invariants: agents never push to protected branches; all agent actions are logged to `audit_log`; worktree isolation holds.)
- **Capabilities page is a public API surface.** `docs/capabilities.md` must reflect the new behavior in the same PR, and the drift check must pass.
- **Build and full test suite must pass.**

## Risks and Open Questions

- **Resume loops on slow-but-progressing stories.** A story that checkpoints partial progress, then stalls again, could consume all attempts re-dispatching across the cap. The attempt cap bounds this, but `[ASSUMPTION]` the existing cap's default is tuned for this recovery use, not only for manual retries — worth confirming the default value is sensible for auto-resume before shipping.
- **Counter scope correctness.** A non-persisted, run-scoped counter must not leak across stories within a run or reset incorrectly mid-run. `[ASSUMPTION]` the counter is keyed per-story-within-run, not a single global run counter — confirm the intended granularity, since a shared counter would let one flaky story exhaust another's budget.
- **Interaction between stall-kill and hung-request-kill on the same story.** Both kill types feed the same resume path and the same counter. `[ASSUMPTION]` both decrement the same attempt budget; confirm that is desired vs. tracking them separately.
- **"Last stream event" availability at kill time.** Capturing the last stream event assumes it is reliably retained up to the moment of the kill, including for the fully-silent-subprocess case where there may be *no* stream event. `[ASSUMPTION]` the silent-subprocess case records a null/"none" sentinel rather than failing the audit write.
- **Checkpoint freshness.** Resuming from a checkpoint assumes the checkpoint reflects meaningful, recent progress. A stale checkpoint could resume work that re-stalls immediately — mitigated, not eliminated, by the attempt cap.
- **Definition of "checkpoint-committed."** The line between a committed checkpoint (resume) and dirty work (fail) must be unambiguous in the existing checkpoint machinery. `[ASSUMPTION]` an existing, reliable signal already distinguishes these and no new checkpoint state is required.

## Success Criteria

A stalled or hung-request-killed story with a checkpoint is **automatically re-dispatched from its checkpoint within the same run via the existing handoff, with no manual re-run**, bounded by the attempt cap. Specifically:

1. **Resume happens automatically** — no human re-run is required to continue a recoverable story.
2. **Continues, not restarts** — the resumed worker's prompt includes the handoff and builds on prior work.
3. **Cap exhausted → failed** — when the attempt cap is reached, the story is left failed and does not loop.
4. **No checkpoint → failed, not dirty** — a story with no checkpoint commit is left failed rather than resumed on uncommitted work.
5. **Bound is run-scoped** — a non-persisted, run-scoped counter enforces the in-run attempt limit and does not carry across runs.
6. **Diagnostics recorded on every kill** — each stall and hung-request kill records audit detail distinguishing hung-request-no-response from silent-subprocess, the last stream event before the kill, and the resume attempt number.
7. **No parallel recovery path** — recovery flows through the existing manual-retry preparation path with a non-clean resume; the checkpoint/handoff/auto-retry-budget machinery is reused.
8. **Detection and thresholds unchanged** — hung-request detection, the stall window, and the absolute cap are untouched; no guardrail is weakened.
9. **Docs current** — `docs/capabilities.md` documents the automatic in-run resume and the capabilities drift check passes.
10. **Green build** — the full build and test suite pass.
