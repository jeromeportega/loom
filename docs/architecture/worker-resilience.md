# Worker resilience — timeouts, checkpoints, handoff & retry

How loom keeps a long-running story from losing work, kills only genuinely
stuck workers, and lets a fresh worker resume after any failure. This replaces
the original behavior — a single hardcoded 30-minute wall-clock `SIGTERM` with
no pre-kill commit, which discarded in-flight work and killed long-but-productive
stories.

## The problem it solves

A worker is one long-lived agent CLI subprocess running inside the story's git
worktree. The old design:

- killed every worker at a fixed 30 minutes regardless of whether it was making
  progress (a large multi-service story and a one-line doc edit got the same
  budget);
- `SIGTERM`'d the immediate child only, so the agent's own subprocesses (a test
  runner, a build) could be orphaned, and a child that ignored `SIGTERM` could
  hang the supervisor forever;
- never committed in-flight edits before the kill, so a timeout discarded the
  whole worktree (we lost 17 modified files this way once).

## Progress-aware timeout (`WorkerTimeoutGuard`)

`WorkerTimeoutGuard` (`packages/loom-core/src/orchestrator/WorkerTimeoutGuard.ts`)
replaces the single timer with two ceilings:

- **Stall kill** — fires after `story_stall_minutes` of *zero output activity*.
  The clock resets on **any stdout/stderr chunk**, which is the one liveness
  signal common to every backend (claude-cli, cursor-cli, the mock) and one that
  stays live during a long streaming test run. (Edit-class `tool_intent` traces
  are claude-only, so they are at most a refinement, never the sole signal.)
- **Absolute cap** — fires after `story_absolute_cap_minutes` total regardless of
  activity. The backstop against a worker that streams forever in a useless loop.

Both are **scaled per story** by `story_timeout_multipliers[estimated_complexity]`,
so a `large` story gets more budget than a `trivial` one. The resolution happens
per-assignment inside the worker (the worker is a single reused instance, so the
budget cannot live on its constructor); an explicit `WorkerAssignment.stallMs` /
`absoluteCapMs` override always wins.

The guard kills the worker's **process group** (workers are spawned `detached`,
so the child is its own group leader) and escalates `SIGTERM → SIGKILL` after a
grace window, so grandchildren die and an unresponsive child can never hang the
run. A one-shot near-deadline warning is emitted as a `worker_timeout_warn` audit
row.

All timers/clock/kill sources are injectable, mirroring `WorkerWatchdog`, so the
logic is unit-tested without real time
(`packages/loom-core/src/__tests__/WorkerTimeout.test.ts`).

## Commit-on-exit checkpoint

Before reporting `failed` on a timeout or token-budget kill, the worker runs
`checkpointUncommitted()` in the worktree:

- guards on `git status --porcelain` (no empty checkpoints);
- clears a stale `.git/index.lock` left by an interrupted git operation;
- commits with `git commit --no-verify -m "wip: <reason> checkpoint [loom]"`.

`--no-verify` is a **deliberate, scoped exception** to the usual "never skip
hooks" rule: the target repo's pre-commit hooks could reject the commit and we
would lose the exact work we are trying to save. The commit is clearly marked
`[loom] wip` and is squashed/redone on the real retry. This converts a
catastrophic loss into a resumable commit that `countCommits()` reports.

## Crash-resilient resume — per-story handoff docs

On a `failed`/`blocked` story the Supervisor materializes
`<projectRoot>/.loom/handoff/<story-id>.md` via
`StoryHandoff` (`packages/loom-core/src/orchestrator/StoryHandoff.ts`),
assembled entirely from **durable** sources that survive a hard `SIGKILL`:

- `git log <baseSha>..HEAD` on the story branch (the per-commit record — this is
  the "built up on every commit" trail, for free);
- the [`decision_traces`](decision-traces.md) reasoning timeline (`getByStory`);
- the audit log + the persisted `log_tail`.

The doc mirrors the team `/handoff` skill shape (Goal / Current state / Key
decisions / Artifacts-by-reference / Next steps) but is produced automatically
and references artifacts by path rather than copying them. It lives in the main
project root (sibling of `.loom/guidance/`), so it survives worktree removal on a
clean retry.

`policy.agents.handoff` tunes the cost, per repo, in `.loom/policy.yaml`:

| Value | Behavior |
| --- | --- |
| `off` | No handoff doc, no resume injection (legacy behavior) |
| `telemetry` | **Default.** Zero extra tokens — pure assembly from persisted state |
| `summarized` | Adds an LLM compaction pass (more tokens; opt-in) |

### Resume injection

`buildWorkerPrompt` gains an `includeHandoff` option that mirrors the
operator-guidance block: when set **and** a handoff file exists, it appends a
"you are RESUMING — continue from these commits, do not start over" block.

The gate is purely file presence: a first attempt has no handoff file, so the
prompt stays byte-identical to the baseline. The Supervisor **clears** the
handoff file on success, establishing the invariant *"a handoff file exists ⇒
this story has unfinished work to resume."* A non-clean retry therefore resumes
intelligently; a clean retry removes the file and starts fresh.

## Phased pipeline (`policy.agents.phases`)

The stall + cap budgets above bound a *single* agent spawn. A genuinely large
story can still want more wall-clock than one spawn should hold — and a crash
late in a long single spawn loses everything since the last commit. The phased
pipeline (opt-in, `policy.agents.phases: on`) runs a story as **discrete agent
spawns, each with its own fresh timer**:

1. **Implement** — the baseline spawn (byte-identical prompt to single-spawn
   mode). Builds the feature and commits it.
2. **Verify** — a *fresh* spawn (so a fresh stall/cap budget) whose prompt is
   narrowed to "the implementation is already committed; run the full build +
   test suite and fix failures — do not re-architect."

At each phase boundary the worker checkpoint-commits any residue and fires
`onPhaseBoundary`, which the Supervisor maps to a handoff refresh. So a crash
*during verify* resumes from the committed implement work instead of losing the
story. The review pass (Epic 18) still runs after verify, unchanged.

This pairs with the worker persona guidance — run **targeted** tests while
iterating in the implement phase, the **full** suite in the verify phase — and
the PM convention of appending a dedicated full-suite verification story to any
multi-service epic. Default is `off`: a single spawn does implement+verify
together, preserving the bench baseline.

## Safe retry — per-epic lease + `StoryRetryService`

A failed story is retried by re-running its epic (the Supervisor is resumable —
completed stories are skipped, non-success stories get a fresh agent). Two
hazards make the naive path unsafe, both now closed.

### Per-epic dispatch lease (`LeaseStore`)

The MCP server (`loom serve`), the web dashboard, and `loom run` can all
dispatch. Without coordination, two of them could dispatch the *same* epic's
stories into the *same* idempotent worktree at once. `Supervisor.run()` now
acquires a `loom_lease` row (`packages/loom-core/src/state/LeaseStore.ts`)
per epic for the duration of dispatch, heartbeats it in the dispatch loop, and
releases it in a `finally`. An epic another live supervisor already holds is
**deferred** (reported as skipped, audited as `dispatch_deferred`) rather than
double-dispatched. Independent epics still run fully in parallel — the lease is
keyed by `epic_id`, not global.

Identity is a per-`LeaseStore` `owner` token, **not** the pid: two supervisors
in one process (an MCP dispatch + a same-process retry) hold distinct owners and
still exclude each other. The pid + hostname are recorded only so a crashed
holder's lease can be reclaimed — same-host via a `process.kill(pid, 0)`
liveness probe, cross-host via heartbeat staleness (modeled on `GlobalLimiter`).

### `StoryRetryService`

`StoryRetryService` (`packages/loom-core/src/orchestrator/StoryRetryService.ts`)
is the one shared entry point behind the MCP `loom_retry_story` tool and the web
Retry button. It *prepares* state and leaves dispatch to the caller (which owns
the policy + worker wiring):

- **Guards** — refuses a story that is still `running` (stop it first), and an
  epic a live supervisor currently holds the lease for (wait or stop it).
- **Resume retry** (default) — keeps the prior attempt's branch + checkpoint
  commit. The Supervisor's worktree-reuse + handoff injection continue the work.
- **Clean retry** (`clean: true`) — tears down the story's worktree + branch
  **and those of every story transitively stacked on it**, resets those
  dependents off `SUCCESS` so they re-run from a rebuilt base, and clears their
  handoff docs. This cascade is the subtle part: a dependent that already
  succeeded on top of a now-deleted branch must be re-run, not reused.
- Flips the epic back to `in_progress` so `selectEpics` re-includes it, and
  audits the retry.

## Ergonomics — orphan pruning & stall visibility

### Orphaned-worktree pruning (`WorktreeJanitor`)

Over a run's lifetime `.loom/worktrees/` can accumulate trees a crash left
behind. `WorktreeJanitor` (`packages/loom-core/src/orchestrator/WorktreeJanitor.ts`)
classifies each on-disk tree against the agent table:

- `no-agent` — a worktree dir with no DB record at all (a half-created or
  abandoned tree). Safe to remove; its branch is kept in case it holds commits
  loom never recorded.
- `completed` — the story's latest agent is `done` (merged). Reported for a
  deliberate `loom`-side cleanup, but **not** auto-pruned.
- `failed` / `blocked` / `running` / `pending` / `pr_open` — never an orphan.
  Failed and blocked are deliberately KEPT so a resume retry can continue.

`Supervisor.run()` auto-prunes the **`no-agent`** orphans at end of run (gated
by `policy.agents.prune_orphan_worktrees`, default `on`). `completed` trees are
deliberately left to the EpicFinalizer, which removes them only after a
successful merge — pruning them here would discard work when a per-epic merge
conflicts and the story's commits live only on its branch.

### Stall & worktree info in status surfaces

A running story whose worker has emitted a `worker_timeout_warn` (stall/cap/
budget) or `worker_watchdog_warn` (analysis-only) audit row is flagged as
**stalled** with the reason, derived via `AuditLog.latestActionForAgent`.
`loom_get_status` (MCP), `loom status` (CLI), and the web dashboard now surface
each story's `worktree_path` / `branch_name` and the stall reason, so an operator
can see "this story is about to be killed" and `cd` straight into the tree.

## Policy reference

```yaml
agents:
  # Progress-aware story timeout (minutes). Scaled per story by complexity.
  story_stall_minutes: 12          # kill after this long with zero output
  story_absolute_cap_minutes: 60   # hard ceiling regardless of activity
  story_timeout_multipliers:
    trivial: 0.5
    small: 0.75
    medium: 1
    large: 2
  # Crash-resilient resume handoff.
  handoff: telemetry               # off | telemetry | summarized
  # Phased pipeline — implement + verify as separate, freshly-timed spawns.
  phases: off                      # off | on
  # Auto-prune agent-less orphaned worktrees at end of run.
  prune_orphan_worktrees: on       # off | on
```

All keys are additive with safe defaults — an existing `.loom/policy.yaml` keeps
working unchanged.

## Delivery note

loom is consumed by downstream repos as the globally-installed `loom-ai` npm
package, not from source. After changing this behavior, build + version-bump +
reinstall the global CLI/MCP before it takes effect for consumers.
