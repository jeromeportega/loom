# Resilient Story Execution

## Overview

loom's execution layer cannot tell *the work was wrong* from *the infrastructure blinked*: every worker death is charged to the story as a defect, burning its failure budget and demanding operator intervention. The v0.6.0 dogfood run (findings N5–N13) showed the cost — a single transient `cursor-agent` connection loss consumed hours of wall-clock time and forced hand-written recovery. This epic makes the execution layer self-healing for infra-class failures while keeping genuine work failures loud, and closes three correctness gaps: wall-clock timers that misfire on laptop suspend, a destructive `loom stop` that discards uncommitted progress, and a finalizer that gates a tree different from the one the PR ships.

## Goals

1. **Infra faults self-heal without operator babysitting.** All four documented infra signatures (connection-loss, spawn `ENOENT`, cli-config rename race, exit-before-output) are classified `infra_failure`, auto-retried with bounded backoff, and the story still lands — without consuming the failure budget.
2. **Genuine work failures stay loud.** A worker exiting non-zero *after* producing output is never reclassified as infra; it consumes the failure budget and surfaces exactly as today. Asserted by test.
3. **Operator recovery needs zero hand-written scripts.** `loom retry <story-id>` resets and re-dispatches a failed story end-to-end, lease-aware so it never double-dispatches.
4. **Time and shutdown are correct.** A simulated suspend (>6× poll interval) does not kill a streaming worker; `loom stop` leaves a checkpoint commit in every in-flight worktree; and the integration gate runs on the exact tree the PR carries.

## User Stories

- **Must** — As the **loom operator** running an unattended dogfood, I want transient infra faults to auto-retry without burning the failure budget, so that a flaky connection or closed laptop doesn't demand manual recovery.
- **Must** — As the **loom operator**, I want a `loom retry <story-id>` command, so that I can recover a failed story end-to-end without writing recovery scripts.
- **Must** — As the **loom maintainer** debugging post-mortem, I want each attempt labeled by cause (infra vs. work) in the attempt column and audit log, so that I can reason about what actually went wrong.
- **Should** — As the **loom operator**, I want `loom stop` to checkpoint in-flight work before terminating, so that an intentional stop doesn't discard uncommitted progress.

## Functional Requirements

- **FR-1** — On worker death, detect four infra signatures — `cursor-agent` connection loss, spawn `ENOENT`, the `cli-config.json` rename race, and exit-before-any-output — wired to the existing streaming signals (`parseStreamLine`, `WorkerTimeoutGuard`). The classifier must admit new signatures cheaply.
- **FR-2** — Auto-retry a detected `infra_failure` in-place on a fixed schedule (30s / 2m / 8m; cap 3 attempts; no complexity scaling) with ±20% full-jitter drawn from an injectable seeded source. Infra retries do not touch the story's failure budget.
- **FR-3** — Record attempt cause in a dedicated state column (`infra_failure` vs. null/`work_failure`) plus an audit-log detail. This is a separate column, **not** a new agent-status enum value (owned by the sibling epic).
- **FR-4** — A worker exiting non-zero *after* producing output is a work failure: it consumes the failure budget and is never reclassified as infra.
- **FR-5** — Stagger concurrent `cursor-agent` spawns with 1–2s jitter to clear the `~/.cursor/cli-config.json` rename herd.
- **FR-6** — `loom retry <story-id> [--clean]`, built on the existing `StoryRetryService`: if a live epic lease exists, reset-to-ready and let the lease-holder dispatch; self-dispatch only when no lease is held. Output text states that retry grants a *fresh* auto-retry budget, and resets both the story and that budget.
- **FR-7** — Use monotonic `process.hrtime.bigint()` for all duration math, with heartbeat-based suspend detection (wall-clock jump > 6× poll interval). On detected sleep, re-arm all timers from the resume instant and route the worker through the shared infra-retry path.
- **FR-8** — Before SIGTERM, `loom stop` attempts a bounded (30s/worker) WIP-commit in each in-flight worktree using the existing timeout-path commit machinery; stop proceeds regardless of checkpoint outcome.
- **FR-9** — In `EpicFinalizer.finalize()`, move `promoteArtifacts` ahead of the integration gate so the gate runs on the promoted tree, collapsing block-mode to a single promotion site (no double commit).
- **FR-10** — All retry/backoff constants live in one source location; no new policy knobs are exposed.

## Non-Functional Requirements

- **NFR-1 — Determinism.** All timer and jitter work uses injectable clock/timer/seed sources extending the existing `WorkerTimeoutGuard` injectable-`now` pattern; tests perform no real sleeps.
- **NFR-2 — Test isolation.** Each infra signature is simulated via the `spawnChild` seam in `BaseCliWorker` (no real CLI), and **each of the four signatures gets its own asserted classification + retry test** — not one rolled-up case.
- **NFR-3 — State persistence.** The new attempt-classification column is added through a `packages/loom-core/src/state/` migration on the `better-sqlite3` store.

## Epics

This PRD breaks into a **single epic**: *Resilient Story Execution*. The three parts (classify-and-auto-retry, operator retry, time/shutdown correctness) are one cohesive change to the execution layer — the sleep-recovery path deliberately reuses the Part 1 classifier, and operator retry builds on the same state column and budget semantics. It is not separable shipping units.

## Out of Scope

- Tunable retry/backoff policy knobs, dashboard controls, or distributed-lease redesign (engine-tuned by design; anti-persona).
- A new agent-status enum value for infra failures — owned by the sibling "status lifecycle & observability" epic.
- `EpicFinalizer` status transitions and PR-URL recording — owned by the sibling epic; this epic's finalizer diff is confined to promotion-vs-gate ordering.
- Fixing the MCP orphaning hazard for `loom_retry_story` from a one-shot stdio client — documented as a known hazard only; the real fix is the shared CLI path.
- Exhaustive infra-signature coverage beyond the four documented signatures — new modes will surface in future dogfood runs and be added incrementally.
