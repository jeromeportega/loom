---
title: "Epic 11 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 11 Review: Multi-Product Orchestration

Reviewing the `ProjectRegistry`, `loom status --all`, the `MachineConfig` /
`GlobalLimiter` machine-wide worker cap, and the Supervisor integration.

Two issues were caught during the build and fixed before this review. The rest
are documented limitations.

## Caught and fixed during the build

**A. The `loom init` test would have polluted the developer's real `~/.loom`.**
`loom init` now registers the repo in `<loomHome>/projects.json`. The init
test spawns `loom` as a real subprocess — so without isolation, every test run
would write the test's throwaway temp dir into the developer's actual
`~/.loom/projects.json`. Caught while reasoning about test isolation, before
running the suite. Fixed: `loomHome()` honours a `LOOM_HOME` environment
variable, and the init test sets it to a temp dir. `LOOM_HOME` is also a
genuine feature — it lets a machine relocate loom state.

**B. `loom init` could fail if the machine registry is not writable.**
Registration was a bare `new ProjectRegistry().register(...)` call. A read-only
or unwritable `~/.loom` would throw and abort `loom init` entirely — even
though the repo itself initialized fine. Fixed: the call is wrapped in
try/catch; registration is a convenience, and `loom init` now prints a notice
and proceeds.

## Findings — documented

### Medium

**1. `loom status --all` opens each project's DB read-write.**
- It uses `createDatabase`, which runs the (idempotent) migration — so a status
  read briefly takes a write lock per project. A true read-only open is avoided
  on purpose: SQLite cannot open a WAL-mode database read-only without write
  access to the `-shm` file, and loom DBs are WAL. In practice WAL plus the 5s
  busy timeout makes this invisible, and a status read never corrupts or blocks
  a running supervisor — but it is not, strictly, a read.

**2. The `GlobalLimiter` heartbeat backstop is one hour.**
- A *crashed* supervisor's slots are reclaimed immediately — its pid is dead and
  `process.kill(pid, 0)` says so. A *wedged* supervisor — alive but stuck —
  holds its slots until its heartbeat is one hour stale. The long window is
  deliberate: a healthy supervisor blocks on a worker (and so does not
  heartbeat) for many minutes at a time, and must never have a live slot stolen.
  pid-death is the real mechanism; the hour is a backstop for the rare hang.

### Low

**3. A run blocked on the global cap polls every 1.5s.**
- When the machine is at its worker cap, a waiting run rechecks for a free slot
  every `globalPollMs` (1.5s default). It is a poll, not an event — a freed slot
  is noticed within ~1.5s. Negligible against multi-minute worker runs.

**4. The registry keys projects by absolute path.**
- Moving a registered repo orphans its entry (old path gone → pruned on the next
  `--all`). Re-run `loom init` in the new location. The registry has no notion
  of repo identity beyond the path.

## Downstream impact matrix

| Finding | Epic 12 (research) | Epic 14 (pi dashboard) |
|---|---|---|
| A test pollution (fixed) | — | — |
| B init robustness (fixed) | — | — |
| #1 read-write status | — | the dashboard's `--all`-style aggregation inherits this |
| #2 heartbeat backstop | — | — |
| #3 poll interval | — | — |
| #4 absolute paths | — | dashboard multi-product list keys on the same paths |

Note: Epic 11 *resolves* Epic 14's open finding #4 — the single-product
dashboard now has a `ProjectRegistry` to enumerate, so widening
`DashboardModel` to `projects[]` is unblocked.

## What's solid

- **The limiter is a gate, not a rewrite.** The Supervisor's dispatch loop
  gained a slot acquire/release *around* the existing dispatch. When no limiter
  is configured every new branch is guarded by `if (limiter)`, so behaviour is
  byte-identical to before — the 200+ pre-existing tests passing unchanged is
  the proof, plus an explicit "no limiter changes nothing" test.
- **Crash-safety uses the right primitive.** Reclaim is built on pid-liveness
  (`process.kill(pid, 0)`), not a lease-renewal protocol or wall-clock leases —
  no clock sync, no renewal cadence to tune. The heartbeat is a backstop, not
  the mechanism.
- **The IMMEDIATE transaction is the correctness lynchpin.** `acquire` does
  read-count-then-insert inside a `BEGIN IMMEDIATE` transaction, so two loom
  processes cannot both observe `count = cap - 1` and both insert. The
  cross-instance test exercises exactly this.
- **The cap is scoped per machine — correctly.** A global worker cap exists to
  protect *one machine's* shared Claude session, so it belongs in per-machine
  config (`<loomHome>/config.json`), not per-repo policy. Each machine sets its
  own; `LOOM_HOME` can relocate it. (This is what the user asked for — the
  design already had it.)
- **The wait-don't-exit fix is real.** A run that *starts* while the machine is
  already at cap must not exit having done nothing — it waits for a slot. Tested
  directly: a blocker holds the only slot, releases it mid-run, the run still
  completes its story.
- **`loom status --all` composes, it does not duplicate.** It loops the
  registry and reuses the same per-project renderer as plain `loom status` —
  no second status implementation.

## Verdict

Epic 11 is sound and the build is green (264 tests). The machine-wide limiter
is correct under concurrency and crash-safe, and it is genuinely opt-in — a
machine with no `config.json` behaves exactly as before. No blocker; the
documented findings are all acceptable trade-offs.
