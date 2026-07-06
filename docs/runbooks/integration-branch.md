# Integration Branch Runbook

How to manage rolling integration branches and respond to the lag warning.

---

## Overview

When `policy.agents.integration_branch=rolling`, loom creates a live `epic/<id>` branch up front and merges each story back the moment it completes — so parallel story agents build on real integrated code rather than colliding only at finalize. The integration branch must stay reasonably current with `main` for this to be effective.

---

## Syncing the integration branch with main

```bash
loom sync <epic-id> [--main-branch <name>]
```

Merges the latest `main` (or the branch named by `--main-branch`) into the epic's rolling integration branch on demand. Only applicable when `integration_branch=rolling`.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Integration branch HEAD is already or becomes a descendant of `main` HEAD |
| `1` | Merge conflict or git error — integration branch left clean (merge aborted) |

On conflict, the merge is aborted and the integration branch is left in a clean state. The diagnostic is printed to stderr. Resolve the conflict on `main` (or the relevant branches) and re-run `loom sync`.

**Example:**

```bash
loom sync epic-003
# Synced epic/epic-003 with main: merged 7 commit(s).

loom sync epic-003 --main-branch develop
# Sync using a non-default upstream branch
```

---

## The lag warning

`loom status` emits a `⚠` warning when an epic's integration branch is behind `main` by more than `policy.agents.integration_branch_lag_threshold` commits (default `10`).

The warning also appears in `loom status --json` under the `integration_lag` field:

```json
{
  "integration_lag": {
    "commits_behind": 14,
    "threshold": 10,
    "warn": true
  }
}
```

The warning fires only when `integration_branch=rolling`. Single-branch or `off` epics are unaffected.

### Responding to the lag warning

```bash
loom sync <epic-id>
```

Run this whenever you see the lag warning. It takes seconds when there are no conflicts.

### Tuning the threshold

```yaml
# .loom/policy.yaml
agents:
  integration_branch_lag_threshold: 20   # warn only when 20+ commits behind
```

Set higher for repos with frequent `main` commits (e.g. a fast-moving monorepo) to reduce noise.

> **Planning-phase stalls:** if `loom status` shows a `⚠ stale-planning` hint (planner idle in `planning` status), that is unrelated to the integration branch — see the [stop-and-retry runbook](stop-retry.md#stalled-planner-recovery) for guidance.

---

## Pre-conditions for loom sync

`loom sync` requires:

1. The epic exists in the database.
2. The integration worktree at `.loom/integration/<epic-id>` exists — it is created when `loom run` first dispatches the epic with `integration_branch=rolling`. If the worktree is missing, run the epic first.
3. The `main` branch (or `--main-branch` value) exists and is fetchable.

If any pre-condition fails, the command exits 1 with a human-readable error on stderr.

---

## Audit trail

```bash
loom audit
```

Git merge operations from `syncWithMain` are recorded in the audit log. Use `loom audit` to review all events for the current project. To filter by a specific story's dispatch and integration events, use `loom audit --story <story-id>`.
