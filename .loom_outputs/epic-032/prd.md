# Stall-Resilient Execution: Automatic In-Run Resume & Stall Diagnostics

## Overview

Loom can already *detect* a stalled or hung worker fast — epic-030 shipped a tighter liveness bound that terminates a hung model-request stream. But detection only stops the bleeding; it does not heal the run. Today a killed story is left failed until a human notices and manually re-runs it, which defeats unattended autonomous operation. This feature closes the loop: when a worker is killed by a stall or hung-request detection *and* its work was checkpoint-committed, loom automatically re-dispatches the story from its checkpoint **within the same run**, reusing the existing handoff so the resumed worker continues rather than restarts. The behavior is bounded by the existing automatic-resume attempt-cap knob, enforced by a run-scoped, non-persisted counter. In parallel, every stall and hung-request kill records richer audit diagnostics so operators and maintainers can diagnose and tune failures after the fact.

## Goals

1. **Recover recoverable stalls without human intervention.** A stalled/hung-killed story with a checkpoint resumes automatically within the same run. *Metric:* zero manual re-runs required for any checkpoint-backed stall recovery in an unattended run.
2. **Bound recovery so genuinely-stuck stories fail cleanly.** Auto-resume never loops indefinitely. *Metric:* a story that re-stalls every attempt stops at the existing attempt cap and is left failed — no runaway budget consumption.
3. **Make every kill diagnosable.** Operators can tell *why* a worker was killed and how recovery has progressed. *Metric:* 100% of stall/hung-request kills carry audit detail distinguishing the failure mode, the last stream event, and the resume attempt number.
4. **Ship without weakening detection or guardrails.** *Metric:* hung-request detection, stall window, and absolute cap are byte-for-byte unchanged; all repo invariants and the capabilities drift check still pass.

## User Stories

- **(Must)** As a **loom operator running an unattended epic**, I want a story killed by a stall or hung request to resume itself from its checkpoint, so that my run completes on its own instead of parking until I notice.
- **(Must)** As a **loom operator**, I want a resumed worker to continue from prior committed work rather than start over, so that recovery does not waste the progress already made.
- **(Must)** As a **loom operator**, I want a story with no checkpoint to fail rather than resume on uncommitted work, so that recovery never builds on a dirty, unverified state.
- **(Must)** As a **loom maintainer tuning thresholds**, I want audit-grade diagnostics on every kill, so that I can calibrate the liveness bound, stall window, and attempt cap against real failure patterns.
- **(Should)** As a **loom operator**, I want the auto-resume attempt limit to apply per-run only, so that a flaky story in one run starts fresh in the next.

## Functional Requirements

- **FR-1** — On a stall kill or hung-request kill where the worker's work was **checkpoint-committed**, loom MUST automatically re-dispatch the story from that checkpoint within the same run, with no manual re-run.
- **FR-2** — The re-dispatch MUST reuse the existing handoff mechanism so the resumed worker's prompt includes prior context and continues prior work rather than restarting from scratch.
- **FR-3** — Recovery MUST flow through the **existing manual-retry preparation path** with a non-clean (resume) disposition. No parallel or duplicate recovery code path may be introduced.
- **FR-4** — Auto-resume MUST be bounded by the **existing automatic-resume attempt-cap policy knob**. On cap exhaustion, the story MUST be left failed and MUST NOT be re-dispatched again.
- **FR-5** — The attempt bound MUST be enforced by a **run-scoped, non-persisted counter** that does not carry across runs. `[ASSUMPTION]` The counter is keyed per-story-within-run (not a single global run counter), so one flaky story cannot exhaust another's budget — to be confirmed against the existing knob's intent before shipping.
- **FR-6** — When **no checkpoint commit** exists for a killed story, loom MUST leave the story failed and MUST NOT resume on uncommitted work. The committed-vs-dirty distinction MUST rely on the existing checkpoint signal. `[ASSUMPTION]` an existing, reliable signal already distinguishes these; no new checkpoint state is introduced.
- **FR-7** — Every stall kill and hung-request kill MUST record audit detail capturing: (a) the failure mode — *hung-request-with-no-response* vs. *fully-silent-subprocess*; (b) the **last stream event** seen before the kill; and (c) the **resume attempt number** this kill corresponds to.
- **FR-8** — For the fully-silent-subprocess case where no stream event exists, the audit write MUST record a null/"none" sentinel for the last stream event rather than fail the audit write. `[ASSUMPTION]` confirmed as the intended behavior.
- **FR-9** — Both stall-kills and hung-request-kills MUST feed the same resume path and decrement the same attempt counter. `[ASSUMPTION]` shared budget is desired; to be confirmed vs. tracking the two kill types separately.
- **FR-10** — `docs/capabilities.md` MUST be updated in the same PR to document automatic in-run resume, and the capabilities drift check MUST pass.

## Non-Functional Requirements

- **NFR-1 (Guardrail integrity)** — No guardrail may be weakened. Agents never push to protected branches, worktree isolation holds, and every agent action — including each auto-resume re-dispatch and each diagnostic record — is logged to `audit_log`.
- **NFR-2 (Detection immutability)** — The hung-request detection logic, the stall window, and the absolute cap MUST remain unchanged; this feature builds strictly on top of detection.
- **NFR-3 (Reuse over reinvention)** — The implementation MUST build entirely on the existing checkpoint, handoff, auto-retry-budget, and manual-retry-preparation machinery.

## Epics

This PRD is delivered as **one epic**: *Automatic In-Run Resume & Stall Diagnostics* — wiring stall/hung-request kills into the existing manual-retry preparation path under a run-scoped attempt cap, plus the per-kill audit diagnostics. The recovery behavior and the diagnostics ship together because the diagnostics (attempt number, failure mode) are what make the bounded recovery observable and tunable.

## Out of Scope

- Any change to hung-request detection, the stall window, or the absolute cap (epic-030 surface).
- Persisting the resume attempt counter across runs.
- Resuming from uncommitted/dirty worker state when no checkpoint exists.
- Tuning or changing the **default value** of the attempt-cap knob (flagged as a risk to confirm, not a deliverable here).
- New checkpoint state or a new checkpoint mechanism — the feature relies on the existing committed-vs-dirty signal.
- A separate recovery code path, retry queue, or cross-run recovery scheduler.
- Operator-facing UI/CLI surfacing of diagnostics beyond the audit trail (audit records are the V1 surface).
