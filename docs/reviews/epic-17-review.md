---
title: "Epic 17 — Staff Engineer Review"
reviewer: Claude (Opus 4.7)
date: 2026-05-22
status: reviewed
---

# Epic 17 Review: PR strategy & branch consolidation

Reviewing the `pr_strategy` policy field, the worker's per-epic short-circuit
in `BaseCliWorker.maybeOpenPr`, the schema-v8 `base_sha` capture, and the new
`EpicFinalizer` that merges story branches into `epic/<epic-id>` and opens one
PR.

One issue was caught at build time and fixed before commit; the rest are
documented limitations.

## Caught and fixed during the build

**A. `agent_id: null` was the wrong shape for audit records.** The new
finalize-conflict / finalize-success audit entries used `agent_id: null`, but
`AuditLog.record` takes `agent_id?: string` (optional, not nullable). The TS
compiler caught it. Fixed by switching to `agent_id: undefined` (or omitting
the field). A real type bug, never reached runtime.

## Findings — documented

### Medium

**1. `epic/<id>` is force-recreated on every finalize.**
- Re-running `loom run` after a successful epic merge upstream recreates the
  branch at the captured `base_sha` and re-merges the story commits. `gh pr
  create` refuses duplicates, but it's noise on the local branch list and an
  extra divergent ref against `main` upstream. Acceptable as v1; the cleanup
  is "skip finalize when the epic PR is already merged upstream," which needs
  a `gh pr view` poll. Tracked in `docs/known-limitations.md`.

**2. Merge-conflict fallback is per-story drop, not per-epic abort.**
- When two story branches conflict during merge, the conflicting story is
  *dropped* from the epic PR (the story branch retains the work). The epic PR
  still opens with everything else. This is the right default for "epic
  delivered, one story needs human attention" but the wrong default if you
  want all-or-nothing atomic merges. Users who need atomic semantics should
  set `pr_strategy: per-story`. Documented.

### Low

**3. Story branches stay local in per-epic mode.**
- Workers commit but don't push their story branches. If the developer's
  laptop is lost mid-run before finalize completes, the story-level work is
  gone (only the epic branch + PR are durable once finalize runs). The
  trade-off — less upstream noise vs. less off-machine backup — is the right
  call for loom's "deliver epics" framing, but it's an awareness item.

**4. No `loom finalize <epic-id>` CLI yet.**
- Finalize fires automatically at end-of-epic. If a user wants to manually
  re-run finalize on an epic (e.g., after resolving a conflict by hand), there
  is no direct CLI. Workaround: `loom run` re-runs the supervisor, which
  picks up the in-progress epic and re-finalizes once it reaches done.
  Adequate; a dedicated command is polish.

## Downstream impact matrix

| Finding | Epic 18 (review pass) | Epic 19 (learning) |
|---|---|---|
| A `agent_id: null` (fixed) | — | — |
| #1 force-recreate | Epic 18's LLM-written PR body needs to be idempotent on the same diff (it largely is) | — |
| #2 per-story drop | The review pass should know which stories actually shipped; finalize records both `merged` and `conflicted` in audit + return value | — |
| #3 local branches | The PR description agent reads the *epic* branch, never the story branches — already aligned | — |
| #4 no `loom finalize` | Pairs naturally with the future `loom review` CLI from 18-004 | — |

## What's solid

- **The seam is reused, not replaced.** The per-story PR flow in
  `BaseCliWorker.maybeOpenPr` is byte-identical for `pr_strategy: per-story`
  users — only the new `if (prStrategy === 'per-epic')` short-circuit changes
  behavior. The existing test suite would have caught any regression; it did
  not, because there was none.
- **Dependency-ordered merge.** Topological sort over the planner's declared
  `story.dependencies`. Cycles fall back to input order. Root stories (no
  unmet deps) merge first; dependents merge into their already-merged base.
  The merge graph reflects how the work was planned, not how it happened to
  finish.
- **`base_sha` is captured stably.** Only on the first dispatch of an epic
  (the first root-story worktree's `wt.baseSha`). Never overwritten. The
  finalizer always builds `epic/<id>` from this same SHA, so the epic branch
  is deterministic regardless of how `main` moves during the run.
- **No-remote degrades cleanly.** Finalizer creates `epic/<id>` locally, runs
  the merges, and stops cleanly before push + `gh pr create`. Returns a
  status with a human-readable note rather than failing.
- **Behavior change is deliberate and reversible.** `per-epic` becomes the
  default — a real change for existing users — but the `per-story` setting
  preserves the old behavior. `both` exists for transition / paranoid review.
  Three knobs cover the workflow space.
- **Tests cover both modes.** `Supervisor + EpicFinalizer (per-epic PR
  strategy)` makes real `--allow-empty` commits on each story worktree,
  then asserts the `epic/epic-001` branch exists. The per-story-mode test
  asserts no epic branch is created when no finalizer is configured.

## Verdict

Epic 17 is sound and the build is green (227 core / 301 total tests). The
default behavior change is the real risk to call out — anyone on per-story
PRs from older loom runs needs to either set `pr_strategy: per-story`
explicitly or accept the new shape. That's a one-line policy update,
prominently documented in the README and the `loom init` template.
