# Finalize Reconciliation & Gate-Block Surfacing

## Overview

Loom's epic completion path has two live failure modes that both trace to a single gap: the lifecycle cannot *represent* "blocked but resumable" or *repair* "merged but not recorded." A gate-blocked epic is indistinguishable from one actively working, and an epic merged outside the finalize flow (epic-003 via PR 6) is stranded at `in_progress` forever with no operator escape hatch. This PRD specifies two capabilities — a read-only derived `blocked` indicator and a write-path `reconcile` command — built on one shared finalize/reconcile core service, so an operator can both see what needs attention and repair it with a single explicit command.

## Goals

1. **Make gate-blocked epics visible.** A gate-blocked epic (`in_progress + gate`) reports `blocked: true` / `blocked_reason: "integration_gate"` on all four read surfaces, with zero phase leakage on normal `in_progress` epics. *Metric: 4/4 surfaces expose the signal; 0 surfaces expose `finalize_phase` for non-gate `in_progress`.*
2. **Repair stranded epics safely.** An operator can drive a genuinely-merged-but-unrecorded epic to `done` with one command, and the system never produces a false `done`. *Metric: epic-003 reaches `done` with `epic_pr_url` set via `loom reconcile epic-003 --pr <PR-6 url>`; unverifiable epics remain non-`done` in 100% of cases.*
3. **Preserve existing completion semantics.** The derived signal and reconcile path introduce no drift in stored `status`, in-progress-for-resume behavior, or the `loom run` resume candidate set. *Metric: resume candidate set is byte-identical before/after for the same DB state.*

## User Stories

- **(Must)** As a loom operator, I want to see at a glance which epics are gate-blocked and awaiting my action, so that completion-dependent work doesn't hang invisibly.
- **(Must)** As a loom operator, I want to repair a genuinely-merged-but-unrecorded epic with a single explicit command, so that a stranded epic like epic-003 can reach `done` without manual DB surgery.
- **(Must)** As a loom operator, I want reconcile to refuse when it cannot verify a real merge, so that I never get a false `done`.
- **(Should)** As downstream automation (Supervisor done-gate, `loom run` resume, status pollers), I want the new fields to be purely additive, so that I consume `blocked` without any change to the `status` string contract or resume semantics.

## Functional Requirements

**Derived `blocked` indicator (read)**

- **FR-1:** For any epic where `status == in_progress` AND `finalize_phase == gate`, the system computes additive response fields `blocked: true` and `blocked_reason: "integration_gate"`. The signal is computed at read time, never stored.
- **FR-2:** The reported `status` string remains `in_progress` for gate-blocked epics; the DB `status` value is unchanged.
- **FR-3:** The `blocked` signal is surfaced consistently on all four read surfaces: `loom status` CLI, `loom_get_status` MCP, the API status rollup route, and the API fleet route.
- **FR-4:** `loom_get_status` (which today suppresses `finalize_phase` unless `status == finalizing`) and the web rollup (which omits `finalize_phase` entirely) are taught to expose the derived `blocked` signal **only** for the `in_progress + gate` case. A normal `in_progress` epic exposes no `blocked` field and no `finalize_phase`.

**`reconcile` entry point (write)**

- **FR-5:** A new `loom reconcile <epic-id> [--pr <url>]` CLI command and a matching `loom_reconcile_epic` MCP tool both wrap the single shared core service; neither surface contains divergent reconcile logic.
- **FR-6:** *PR-URL path* — when `--pr <url>` is supplied, reconcile verifies via `gh pr view` that the PR state is `merged` AND that its head/base refs match the epic's branch and base (`main`) before recording anything.
- **FR-7:** *Ancestry path* — when no URL is supplied, reconcile checks whether the epic branch is merged into the base branch via git ancestry.
- **FR-8:** **Fail closed.** When `gh` or `git` is unavailable or offline, reconcile refuses and does not mark the epic `done`. It never assumes merged. Error messaging distinguishes "offline/unavailable" from "PR not merged."
- **FR-9:** **Ordered write on verified merge.** On a verified merge the service executes, in this order: (1) record `epic_pr_url`, (2) clear `finalize_phase`, (3) write an `epic_reconciled` row to `audit_log`, (4) flip the epic to `done`. The audit row is written before the call returns.
- **FR-10:** **Refuse on unverifiable merge.** An unmerged or unverifiable epic stays non-`done`; reconcile never produces a false `done`.
- **FR-11:** **Idempotent on already-resolved.** Reconcile invoked on an epic that is already `done` or already has a non-null `epic_pr_url` is a safe noop — it does not re-record. *(Resolves the open idempotency question: noop, applied consistently across CLI and MCP.)*
- **FR-12:** When the ancestry path false-negatives (no merge ancestor found), the refusal message hints that a squash-merged epic should be re-run with `--pr <url>`.

**Docs & live validation**

- **FR-13:** `docs/capabilities.md` is updated in the same PR with the `loom reconcile` CLI subcommand row, the `loom_reconcile_epic` MCP tool row, and the gate-blocked indicator as a user-visible status behavior.
- **FR-14:** After landing, `loom reconcile epic-003 --pr <PR-6 url>` is run via the PR-URL path to drive the real stranded epic to `done`.

## Non-Functional Requirements

- **NFR-1 (Invariant preservation):** The ordered write must preserve the existing invariant that a `done` epic always has a non-null `epic_pr_url` — `epic_pr_url` is written before any `done` write.
- **NFR-2 (Additive contract):** `blocked` / `blocked_reason` are new, additive fields. The `status` string contract does not change on any surface.
- **NFR-3 (No resume drift):** The in-progress-for-resume semantics and the `loom run` resume candidate set are unchanged by either capability.
- **NFR-4 (Audit before return):** Per the loom invariant, the `epic_reconciled` action is logged to `audit_log` before control returns to the caller.

## Epics

This PRD is delivered as **one epic** — both capabilities sit on the same shared finalize/reconcile core service and ship together.

- **epic-007 — Finalize Reconciliation & Gate-Block Surfacing**

## Out of Scope

- Auto-reconciliation or any background reconciler. Every reconcile requires an explicit operator invocation **and** a verified merge.
- Changing the gate-block → `in_progress` resume-recovery path.
- Auto-detecting squash-merge (the operator supplies `--pr` for squash-merged epics).
- Altering any finalize-phase overlay beyond exposing the gate-blocked case.
