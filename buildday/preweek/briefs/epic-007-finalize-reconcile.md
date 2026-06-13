# Epic 007 — Finalize reconciliation + gate-block surfacing

## Problem

When the integration gate blocks in `block` mode, the EpicFinalizer parks the
epic at `finalize_phase='gate'` and sets `status` back to `in_progress` with a
note (`EpicFinalizer.ts:502-521`). The intended recovery is "fix the issue and
re-run finalize," which loom can resume. But two real failures fall through:

1. **Gate-blocked epics are invisible.** `in_progress` + `finalize_phase='gate'`
   renders identically to a still-working epic in every status surface
   (`loom status`, `loom_get_status`, `/api/status`, `/api/fleet`). The
   operator can't tell a blocked epic from a running one. Anything that waits
   on completion (mission control, scripts, watchers) hangs indefinitely.
2. **Out-of-band completion strands the epic forever.** If the operator merges
   the epic PR by hand instead of re-running finalize, `epic_pr_url` is never
   recorded, so the Supervisor's done-gate (`done ⇒ epic_pr_url != null`) can
   never fire. The epic shows `in_progress` permanently even though it's merged.

Real instance: **epic-003** (Fleet Commander) — gate false-failed, was merged
via PR #6 by hand, and has been stuck `in_progress` ever since.

## Goals

1. **Surface gate-blocked epics distinctly** so they're never confused with
   in-progress work — WITHOUT breaking the intentional `in_progress`-for-resume
   semantics (the "fix and re-run finalize" recovery must still work).
2. **Reconcile out-of-band completion** — a verified path to bring an epic
   whose PR was merged outside loom's finalizer to `done`, preserving the
   `done ⇒ epic_pr_url != null` invariant.

## Acceptance criteria

- **Distinct blocked signal:** a gate-blocked epic (`status='in_progress'` AND
  `finalize_phase='gate'`) is reported with a clear derived `blocked` indicator
  (e.g. a `blocked`/`blocked_reason` field) across `loom status`,
  `loom_get_status`, `/api/status`, and `/api/fleet`, so mission control shows
  "blocked at integration gate" rather than "in progress." Do NOT change the
  resume path or invent a status value that breaks `loom run` resume.
- **Reconcile entry point:** `loom reconcile <epic-id> [--pr <url>]` (CLI) and
  `loom_reconcile_epic` (MCP) that VERIFY the `epic/<id>` branch is actually
  merged into the base branch (or accept an explicit merged PR url that is
  confirmed merged), record `epic_pr_url`, and let the epic reach `done`. An
  `epic_reconciled` audit row is written.
- **No false done:** reconcile MUST refuse to mark an epic `done` if its branch
  is not actually merged and no verified PR is supplied. Test this explicitly.
- **Apply to epic-003 as live validation:** after the feature lands, run
  reconcile on epic-003 → it reaches `done` with the real merged PR recorded.

## Non-functional / test requirements (enforce these)

- **Real-path tests, not fixtures (this is mandatory).** At least one test for
  the blocked-surfacing MUST import the REAL status path (`loom_get_status`
  and/or the real `createApp` for `/api/fleet`) and assert a gate-blocked epic
  is reported as blocked — not a hand-built fixture app. This is the
  "built-but-not-wired" guard from prior epics.
- Reconcile tests: (a) stranded epic + merged branch → `done` with
  `epic_pr_url` set and the invariant held; (b) unmerged epic + no PR → reconcile
  refuses, epic stays non-done.
- `npm run build` + full suite green (gate runs `npm ci && npm test`).
- `docs/capabilities.md` updated in the same PR (CLAUDE.md invariant) with the
  new `loom reconcile` / `loom_reconcile_epic` rows and the blocked indicator.

## Non-goals

- Do not change the gate-block → `in_progress`-for-resume behavior; the
  supported recovery (fix + re-run finalize) must keep working.
- No auto-reconcile / auto-merge — reconcile only acts on a verified merge.
- No new long-running scanners or background jobs.
