# Robust Epic Finalization and Guard-Compatible Release Flow

## Overview

Loom currently conflates infrastructure and publish friction with genuine failure: a fully-completed, gate-green epic can be marked `failed` when its finalize push is rejected as non-fast-forward (force push being correctly blocked by the guard), and there is no recovery command to rescue it. Separately, loom's own protected-branch guard blocks the operator from cutting a records-only version release, so the documented release flow cannot run inside a loom-governed repo. This PRD makes finalization and release **publish-failure tolerant without weakening any guard**: finalize pushes to a fresh, finalizer-owned ref; publish-pending work lands in a recoverable non-terminal state; an operator command drives stranded green epics to `done`; and a guard-compatible release path ships version bumps through a PR.

## Goals

1. **A gate-green epic never reports as `failed` due to publish friction.** Metric: a finalize push that would be non-fast-forward instead succeeds to a fresh finalizer-owned ref and opens the PR, with **zero force pushes**; 100% of done-and-gate-green epics land in `done` or a recoverable state, never terminal `failed`.
2. **Operators can recover a stranded green epic with one command.** Metric: a single recovery command takes a publish-pending epic to `done`, opening the PR from the gate-green branch and recording the epic PR URL.
3. **Records-only releases ship inside a loom repo under the guard.** Metric: a version release completes with **zero hand-made release branches** and **zero direct pushes to `main`**, running under the protected-branch guard.
4. **The lifecycle tells the truth about what went wrong.** Metric: `failed` is reserved for genuine infrastructure failure and `rejected` for human decisions; the new publish-pending state is distinct, labeled, and never assigned to in-flight epics by migration.

## User Stories

- **As a loom operator,** I want a gate-green epic whose publish step fails to land in a clearly-labeled recoverable state, so that I know the work is done and only publishing remains. *(Must)*
- **As a loom operator,** I want a recovery command that drives a stranded green epic to `done`, so that I don't have to hand-craft branches or re-run an entire epic. *(Must)*
- **As a loom operator,** I want to cut a records-only version release through a PR rather than a blocked push to `main`, so that the release ships inside a loom repo without fighting the guard. *(Must)*
- **As a loom maintainer dogfooding loom,** I want status surfaces to distinguish "work complete / publish pending" from real failure, so that the lifecycle reflects what actually happened. *(Should)*
- **As an operator following the docs,** I want the releasing runbook to match the implemented flow, so that the written process actually works inside a loom repo. *(Should)*

## Functional Requirements

- **FR-1** `EpicFinalizer` pushes the integrated epic branch to a **fresh, uniquely-named finalizer-owned ref**; it never reuses a ref that rolling integration may have touched.
- **FR-2** The finalizer-owned ref name is **deterministic and collision-proof** across retries and concurrent epics (e.g., epic-id plus a finalize suffix).
- **FR-3** Finalization **never issues a force push** under any condition; a non-fast-forward situation is resolved by the fresh ref (FR-1), not by overriding the remote.
- **FR-4** When all stories are `done` and the integration gate passed but push/PR fails, the epic enters a **new recoverable, non-terminal state** that is distinct from both terminal `failed` and `rejected`.
- **FR-5** Status output for a recoverable epic surfaces a **clear "work complete / publish pending" label**, not a failure indication.
- **FR-6** An **operator recovery command** drives such an epic to `done` by: opening the PR from the already-integrated, gate-green branch; recording the epic PR URL; and flipping the epic state to `done`.
- **FR-7** The recovery command is **distinguishable to the operator from `reconcile`**, and existing `reconcile` (gate-blocked) behavior is unchanged.
- **FR-8** Introducing the new state must **not misclassify epics already in flight**; persisted state and any state-machine guards handle the new state additively.
- **FR-9** A **guard-compatible release path** cuts a records-only version release by: bumping the version via the **existing versioning script**; opening a **release PR** (no direct push to `main`); and pushing the tag after merge.
- **FR-10** The release path runs **under the protected-branch guard** with no hand-made release branch and no blocked push to `main`; tag-ref push is confirmed permitted by the guard (or the operator step to push it is defined).
- **FR-11** `docs/capabilities.md` and the **releasing runbook** are updated in the same PR to reflect any new CLI command/policy knob and the implemented release flow.

## Non-Functional Requirements

- **NFR-1** The protected-branch guard and force-push prohibition remain **fully in force for worker agents**; nothing here loosens what workers may do.
- **NFR-2** **No force push anywhere** in any new or modified flow.
- **NFR-3** The honest lifecycle distinction is preserved: `failed` = real infrastructure failure, `rejected` = human decision; the new recoverable state must not blur these.
- **NFR-4** **Integration gate behavior is unchanged.**

## Epics

This brief addresses **two separately-deliverable failures** with two independently-shippable solutions, so it breaks into two epics:

- **epic-001 — Collision-free finalization, recoverable lifecycle state, and operator recovery command.** Covers FR-1 through FR-8 and NFR-1 through NFR-4. Resolves Failure 1 (a green epic stranded as `failed`).
- **epic-002 — Guard-compatible release flow and documentation parity.** Covers FR-9 through FR-11. Resolves Failure 2 (releases can't run inside a loom repo). Independently deliverable: records-only releases occur on their own cadence, decoupled from epics.

## Out of Scope

- Garbage-collection / cleanup policy for stale finalizer-owned branches (revisit only if trivial).
- Any change to integration-gate logic or behavior.
- Loosening protected-branch or force-push restrictions for worker agents.
- Release types beyond the records-only version bump (e.g., multi-package or non-records releases).
- Coupling the version bump into an epic PR (the standalone release path is chosen instead).
