# Stop and Retry Runbook

How to stop running workers and re-dispatch failed or blocked stories.

---

## Stopping a run

### Graceful supervisor halt

```bash
loom stop [--reason "<text>"]
```

Raises the stop signal for the whole run. The supervisor finishes every in-flight story and dispatches no more. Before raising the signal, loom attempts a bounded WIP checkpoint commit (`wip: stop checkpoint [loom]`, `--no-verify`) in every in-flight worktree so a worker about to be terminated leaves a resumable commit rather than discarding its edits. Each checkpoint is capped at 30 s; a hung git is abandoned — the stop always proceeds regardless of checkpoint outcome.

Resume later with `loom run` — completed stories are skipped.

### Stop one epic's workers

```bash
loom stop --epic <epic-id> [--reason "<text>"]
```

SIGTERMs every running worker in that epic while leaving other epics running. Exits non-zero if the epic id is not found.

### Stop a specific story worker

```bash
loom stop <story-id> [--reason "<text>"]
```

SIGTERMs the worker for one story. After sending SIGTERM, loom polls synchronously until the story's DB status reaches a terminal state (`done` or `failed`), checking every 250 ms. Maximum wait is 30 s; on timeout the story is force-written to `failed` and the command exits 1.

> **Why synchronous?** Before `--and-retry` can enqueue a fresh run, the previous attempt must be confirmed terminal. The synchronous poll eliminates a race where `loom retry` sees the story as still `running` and rejects it.

---

## Stop and immediately retry

```bash
loom stop <story-id> --and-retry [--reason "<text>"]
```

Combines a synchronous stop with an immediate retry enqueue:

1. Sends SIGTERM to the story's worker process.
2. Polls until the story reaches `done` or `failed` (up to 30 s).
3. Calls `loom retry <story-id> --force` to re-dispatch.

Exits 0 only when both the stop and the retry enqueue succeed. Exits 1 on timeout or retry failure — in that case run `loom retry <story-id>` manually.

> **`--and-retry` is not supported with `--epic`.** Stop individual story IDs and retry them separately.

> **Multiple story IDs with `--and-retry`:** when multiple story IDs are supplied, loom stops and retries each one in sequence — stop → poll → retry for the first ID, then the same for the next, and so on. All stories are attempted regardless of individual failures; the command exits 1 at the end if any stop timed out or retry enqueue failed.

---

## Retrying a failed or blocked story

### Resume retry (default)

```bash
loom retry <story-id> [--reason "<text>"]
```

Keeps the prior branch and checkpoint; feeds the handoff document back to the resumed worker. Lease-aware: if a live supervisor holds the epic, the story is reset to `pending` and that run re-dispatches it. Otherwise `loom retry` builds a Supervisor itself and dispatches the epic.

### Clean retry

```bash
loom retry <story-id> --clean [--reason "<text>"]
```

Tears down the story's worktree and branch (and the worktrees of every story stacked on it) so the story re-runs from scratch.

### Force retry (bypass running-state guard)

```bash
loom retry <story-id> --force [--reason "<text>"]
```

Bypasses the running-state guard. Normally `loom retry` rejects a story that is still marked `running` in the DB — the guard prevents racing two workers on the same story. Use `--force` when you have already killed the worker process (e.g. via `loom stop <story-id>`) and the DB has been confirmed terminal by the synchronous poll, but you want to retry without using `--and-retry`.

`loom stop --and-retry` calls `loom retry --force` internally after confirming terminal state.

---

## Audit trail

Every stop and retry is audit-logged:

| Action | When written |
|---|---|
| `stop_agent` | SIGTERM sent to a specific worker |
| `stop_epic` | `loom stop --epic` call (one aggregate row per epic) |
| `stop_checkpoint` | Per-worktree checkpoint result (checkpointed: true/false) |
| `story_retry` | `loom retry` dispatch or queue-path reset |

Query with:

```bash
loom audit --story <story-id>
```

---

## Stalled planner recovery

`loom status` emits a `⚠` hint when an epic has been in `planning` status for longer than `policy.agents.stale_planning_minutes` minutes (default `30`) with no update. This indicates the planner may have stalled.

In `loom status --json`:

```json
{
  "stale_planning": {
    "idle_minutes": 45,
    "threshold_minutes": 30,
    "warn": true
  }
}
```

Check whether the planner process is still running (`loom status --watch`). If it has stalled:

```bash
loom stop
loom reject <epic-id> --reason "stale planner"
loom weave "<brief>"
```

`loom reject` accepts epics in both `planned` and `planning` status — you can reject a stalled planner without waiting for planning to complete.

To tune the threshold:

```yaml
# .loom/policy.yaml
agents:
  stale_planning_minutes: 60   # allow 60 minutes before warning
```

---

## Common recovery patterns

### Story failed with no obvious error

```bash
loom stop story-001-003 --and-retry
```

Or if you want a clean slate:

```bash
loom retry story-001-003 --clean
```

### Worker hung and unresponsive

```bash
loom stop story-001-003
# stop blocks until the story is confirmed terminal (up to 30 s)
loom retry story-001-003
```

### Epic stuck with multiple failed stories

```bash
loom stop --epic epic-001
# then retry each story individually as needed
loom retry story-001-002
loom retry story-001-003 --clean
```
