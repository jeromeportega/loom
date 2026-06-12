---
title: "Epic 10 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 10 Review: Onboarding & Control

Reviewing `loom doctor`, the README, the `loom stop` control signal, and
checkpoints — the day-one experience and the brakes.

Two real bugs were caught by smoke tests during the build and fixed before this
review (see "Caught and fixed"). The remaining findings are documented limitations.

## Caught and fixed during the build

**A. Epics ran newest-first.** `selectEpics` used `EpicStore.listByStatus`, which
orders `created_at DESC` — so a two-epic run processed `epic-002` before `epic-001`.
Wrong for dependency flow and for `--checkpoint=epic` semantics. Fixed: `selected` is
sorted ascending by id.

**B. Resume could not find a halted epic.** A halted epic has status `in_progress`,
but `selectEpics` only picked `approved` epics — so `loom run` after a checkpoint
found nothing. Fixed: `in_progress` epics are runnable (that *is* what resume means).

Both were found by an end-to-end checkpoint smoke test — the kind of integration bug
unit tests with a single epic would not surface.

## Findings — documented

### Medium

**1. `loom stop` is graceful only — no hard abort.**
- `loom stop` lets in-flight stories finish, then halts dispatch. There is no
  `loom stop --now` that kills running workers. A worker mid-story can run for many
  minutes after `loom stop`.
- Deliberate for MVP: hard-killing a `claude` subprocess leaves a half-done worktree
  and is its own can of worms (the `WorkerRunner` would need cancellation support).
  Documented as a follow-up.

**2. The control signal assumes a single supervisor per repo.**
- `loom_control` is one row. Two concurrent runs in the same repo (e.g. `loom run`
  plus an MCP background dispatch) would share one stop flag, and each `run()` resets
  it to `running` at start. Single-run-per-repo is the documented assumption.

### Low

**3. `--checkpoint=story` forces concurrency 1.**
- To make "run one story then pause" precise, story-checkpoint mode caps concurrency
  at 1. A developer stepping story-by-story gets no parallelism — correct for the
  use case, but worth knowing.

**4. `--checkpoint=epic` with interleaved cross-epic dependencies.**
- Checkpoint=epic works the first unfinished epic exclusively. If a story in epic-001
  depends on an epic-002 story (cross-epic dependency — rare; the PM keeps deps
  within an epic), that story would block until a later run reaches epic-002.
  Documented; keep dependency chains within an epic.

**5. The README's repo URLs are placeholders.**
- `github.com/loom-ai/loom` is a placeholder in `package.json` and the README.
  `docs/RELEASING.md` flags this — and the LICENSE decision — as pre-publish steps.

## Downstream impact matrix

| Finding | Epic 9 (Shared skills) |
|---|---|
| A epic ordering (fixed) | — |
| B resume (fixed) | — |
| #1 graceful-only stop | — |
| #2 single supervisor | the shared-skill eval-merge CI must assume one runner |
| #3 checkpoint concurrency | — |
| #4 cross-epic deps | — |

## What's solid

- **Checkpoints reuse resumability rather than adding machinery.** A checkpoint is
  just "stop dispatching at this boundary and return" — the Supervisor was already
  resumable (completed stories are skipped), so `--checkpoint` needed no long-lived
  blocking, no new process model. Stop at a boundary, `loom run` to continue.
- **The trust ladder is real.** `--checkpoint=story` → `--checkpoint=epic` → no flag
  is a genuine progression from cautious to autonomous — the seed of the future
  `policy.agents.autonomy` config.
- **`loom stop` is cross-process by construction.** A separate `loom stop`
  invocation writes a DB row; the running supervisor polls it between dispatches.
  Simple, no IPC, no signals.
- **Control-first onboarding.** Per the UX review, the README leads with the brakes
  before the magic, and `loom run` prints `loom stop` in its own output — control
  the user cannot miss.
- **`loom doctor` is honest about severity.** Node/git missing → exit non-zero;
  claude/gh missing → warning (you can still `loom init`). It does not cry wolf.
