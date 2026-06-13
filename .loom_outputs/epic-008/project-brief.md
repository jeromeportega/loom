# Finalize Reconciliation & Gate-Block Surfacing for the Loom Orchestrator

## The Problem

Two distinct failures in loom's completion path leave epics permanently stranded and invisibly stuck. Both are live today.

1. **Stranded-done failure (live, epic-003).** epic-003 was merged via PR 6 *outside* loom's finalize flow, so `epic_pr_url` was never recorded. The Supervisor done-gate only flips an epic to `done` when `epic_pr_url` is non-null. With no URL and no out-of-band path to record one, epic-003 is stuck at `in_progress` forever. There is currently no operator escape hatch to reconcile a genuinely-merged-but-unrecorded epic.

2. **Invisible-blocked failure.** When the integration gate blocks an epic in block mode, the epic is flipped to `in_progress` for resume while `finalize_phase` stays set to `gate`. Every status surface reports it as plain `in_progress`, so a gate-blocked epic is indistinguishable from one that is actively working. Anything awaiting completion hangs with no signal that operator action is required.

These share a root cause — the completion lifecycle has no way to *represent* or *repair* "merged but not recorded" and "blocked but resumable" states — so they are solved together over one core service.

## Target Users

- **Primary — Loom operators.** The human running loom (currently dogfooding) who needs to (a) see at a glance which epics are gate-blocked and awaiting action, and (b) repair a stranded epic with a single explicit command.
- **Secondary — Downstream automation.** The Supervisor done-gate, the `loom run` resume logic, and any tooling polling the status surfaces. These consume the same fields and must not regress.
- **Anti-persona — Unattended/auto-reconciliation.** This is *not* a background reconciler. Nothing should ever flip an epic to `done` without an explicit operator invocation *and* a verified merge.

## Proposed Solution

Build **two capabilities backed by one shared core service** in the finalize/reconcile path.

**Capability 1 — Derived `blocked` indicator (read-only).** For any epic where `status == in_progress` AND `finalize_phase == gate`, surface a derived signal as **new, additive** response fields: `blocked: true` and `blocked_reason: "integration_gate"`. The reported `status` string stays `in_progress`, unchanged. The signal is computed, not stored — the DB `status` remains `in_progress`, and the in-progress-for-resume semantics plus the `loom run` resume candidate set are untouched.

**Capability 2 — `reconcile` entry point (write).** A new `loom reconcile <epic-id> [--pr <url>]` CLI command and a matching `loom_reconcile_epic` MCP tool, both wrapping the shared core service. It verifies a genuine merge before recording anything, then records the URL, clears the block, audits, and flips to `done` — in that order — or refuses.

## Key Capabilities

1. **Surface `blocked` consistently across all four read surfaces:** `loom status` CLI, `loom_get_status` MCP, the API status rollup route, and the API fleet route. Note that `loom_get_status` today suppresses `finalize_phase` unless `status == finalizing`, and the web rollup omits `finalize_phase` entirely — both must be taught to expose the derived `blocked` signal for the `in_progress + gate` case **only**, without leaking the phase for normal `in_progress` epics.
2. **Two verification paths in reconcile:**
   - *PR-URL path* — verify via `gh pr view` that PR state is `merged` AND that its head/base refs match this epic's branch and base (`main`).
   - *Ancestry path* — when no URL is given, check whether the epic branch is merged into the base branch via git ancestry.
3. **Fail closed.** When `gh` or `git` is unavailable or offline, reconcile refuses — it never assumes merged.
4. **Ordered, invariant-preserving write on verified merge:** record `epic_pr_url` **before** any `done` write (preserving the invariant that a `done` epic always has a non-null `epic_pr_url`) → clear `finalize_phase` (so the epic is no longer derived as blocked) → write an `epic_reconciled` row to `audit_log` before returning → flip the epic to `done`.
5. **Refuse on unverifiable merge; idempotent on already-resolved.** Never produce a false `done`. Reconcile on an epic that is already `done` or already has `epic_pr_url` is a safe noop/refusal, not a re-record.
6. **Update `docs/capabilities.md` in the same PR:** the `loom reconcile` CLI subcommand row, the `loom_reconcile_epic` MCP tool row, and the gate-blocked indicator as a user-visible status behavior.
7. **Live validation:** after landing, run `loom reconcile epic-003 --pr <PR-6 url>` via the PR-URL path to drive the real stranded epic to `done`.

## Constraints

- **Squash-merge reality.** epic-003 / PR 6 was squash-merged, so the epic branch is **not** a git ancestor of `main`; an ancestry check will false-negative. Squash-merged epics must be reconciled via the verified PR-URL path. epic-003 live validation must use that path with PR 6. Base ref to verify against is `main`.
- **Additive only.** The `blocked`/`blocked_reason` fields are new and additive; the `status` string contract does not change.
- **No behavioral drift in resume.** The intentional in-progress-for-resume semantics and the `loom run` resume candidate set must be unchanged.
- **Single shared service.** Both CLI and MCP forms wrap one core service; both capabilities share the same finalize/reconcile core (no divergent logic per surface).
- **Audit before return** (per loom invariant: all agent actions logged to `audit_log` before returning to the caller).

## Risks and Open Questions

- **Idempotency semantics undecided.** Brief says reconcile on an already-`done`/URL-set epic is "a safe noop *or* refusal." PM/architect must pick one and make it consistent across CLI and MCP. *(Open question for John.)*
- **`gh` availability and auth.** `[ASSUMPTION]` The operator environment has `gh` installed and authenticated for the PR-URL path. If not, that path fails closed — acceptable, but operators need a clear error message distinguishing "offline/unavailable" from "PR not merged."
- **Squash-merge detection vs. operator guidance.** The ancestry path will false-negative on squash-merged epics. `[ASSUMPTION]` Reconcile does *not* auto-detect squash-merge; the operator is expected to supply `--pr`. Consider whether a refusal on the ancestry path should hint "if this was squash-merged, re-run with --pr <url>."
- **Branch/base ref matching.** `[ASSUMPTION]` The epic's expected branch and base are derivable from epic state for the head/base ref comparison in the PR-URL path. Verify this is recorded before relying on it.
- **Phase-leak surface area.** Teaching `loom_get_status` and the web rollup to expose the derived signal risks accidentally leaking `finalize_phase` for non-gate `in_progress` epics. The derived signal must be gated strictly to `in_progress + gate`.

## Success Criteria

- [ ] **Live repair:** `loom reconcile epic-003 --pr <PR-6 url>` drives epic-003 to `done` with `epic_pr_url` set to the PR 6 URL, via the PR-URL path.
- [ ] **Blocked visible everywhere:** a gate-blocked epic (`in_progress + gate`) reports `blocked: true` / `blocked_reason: "integration_gate"` on all four surfaces (`loom status` CLI, `loom_get_status` MCP, API status rollup, API fleet), with `status` still `in_progress`.
- [ ] **No phase leak:** a normal `in_progress` epic exposes no `blocked` field and no `finalize_phase` across those surfaces.
- [ ] **DB & resume unchanged:** the derived signal does not alter stored `status`, in-progress-for-resume semantics, or the `loom run` resume candidate set.
- [ ] **Fail closed:** with `gh`/`git` unavailable or offline, reconcile refuses and does not mark `done`.
- [ ] **Ordered writes:** on a verified merge, `epic_pr_url` is written before the `done` write, `finalize_phase` is cleared, and an `epic_reconciled` audit row is written before return.
- [ ] **Refusal / noop:** an unmerged, unverifiable epic stays non-`done`; an already-`done`/URL-set epic is a safe noop/refusal with no re-record.
- [ ] **Anti-stub test passes:** at least one test imports the **real** `loom_get_status` handler AND the **real** `createApp` serving the API fleet route, drives a gate-blocked epic through them, and asserts both report `blocked` — not a hand-built fixture app.
- [ ] **Reconcile tests pass:** a reconcile-success test (stranded-but-merged epic → `done` with `epic_pr_url` set) and a reconcile-refusal test (unmerged/unverifiable epic stays non-`done`).
- [ ] **Docs current:** `docs/capabilities.md` updated in the same PR with the `loom reconcile` CLI row, the `loom_reconcile_epic` MCP row, and the gate-blocked status behavior.

### Explicit Non-Goals

- Do **not** change the gate-block → `in_progress` resume-recovery path.
- **Never** auto-reconcile: every reconcile requires an explicit operator invocation and a verified merge.
- Do **not** alter other finalize-phase overlays beyond exposing the gate-blocked case.
