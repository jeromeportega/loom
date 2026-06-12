# Resilient Story Execution

## The Problem

loom's execution layer treats every worker death as a story defect. When a single flaky dependency fails — most acutely `cursor-agent` losing its connection — the affected story is marked a failure, consuming its failure budget and demanding operator intervention. The v0.6.0 dogfood run (findings log 2026-06-10, items N5–N13) documented the cost: one transient connection loss burned hours of wall-clock time and forced hand-written recovery scripts, because loom cannot distinguish *the work was wrong* from *the infrastructure blinked*.

Three correctness gaps compound the fragility:

- **Timers trust the wall clock.** A closed laptop (suspend/resume) makes worker duration math believe a worker stalled, killing healthy work.
- **Stop is destructive.** `loom stop` SIGTERMs in-flight workers with no checkpoint, discarding uncommitted progress.
- **The gate may not cover the shipped tree.** `EpicFinalizer` runs the integration gate *before* promoting artifacts, so the gate's verdict can describe a tree different from the one the PR carries.

The cost lands on a single operator running an unattended dogfood: a flaky connection, a closed laptop, or a manual stop each currently demands manual recovery.

## Target Users

- **Primary — the loom operator** running an unattended or semi-attended dogfood. They need a run that survives transient infra faults without babysitting, and clear signal when a *real* failure needs their attention.
- **Secondary — the loom maintainer** debugging post-mortem. They need attempts labeled by cause (infra vs. work) in the audit log to reason about what actually went wrong.
- **Anti-persona — the operator wanting tunable retry policy.** Backoff constants are engine-tuned and deliberately *not* exposed as policy knobs; anyone seeking dashboard controls or distributed-lease redesign is out of scope.

## Proposed Solution

Make the execution layer **self-healing for infra-class failures while keeping genuine work failures loud**, and close the three correctness gaps. Three coordinated parts:

1. **Classify and auto-retry infra failures.** Detect known infra signatures on worker death, record the cause in a dedicated attempt-classification column, and auto-retry in-place with bounded backoff — without consuming the story's failure budget.
2. **Operator-initiated retry.** A `loom retry` CLI command, lease-aware so it never double-dispatches.
3. **Time and shutdown correctness.** Monotonic timers that survive sleep, a bounded checkpoint commit before stop, and a reordered finalizer so the gate covers exactly the promoted tree.

The sleep-recovery path deliberately reuses the Part 1 classifier: a slept worker is one more `infra_failure` flowing through the same column, budget, and backoff.

## Key Capabilities

1. **Infra-signature detection** on worker death for four signatures: `cursor-agent` connection loss, spawn `ENOENT`, the `cli-config.json` rename race (N12), and exit-before-any-output — wired to the existing streaming signals (`parseStreamLine`, `WorkerTimeoutGuard`).
2. **Bounded auto-retry** on a fixed schedule (30s / 2m / 8m, cap 3 attempts, no complexity scaling) with ±20% full-jitter from an injectable seeded source. Infra retries don't touch the failure budget; an explicit operator `loom retry` resets both the story and a fresh auto-retry budget.
3. **Attempt classification** in a separate state column (`infra_failure` vs. null/`work_failure`) plus an audit-log detail — *not* a new agent-status enum value (owned by the sibling epic).
4. **Spawn staggering** — 1–2s jitter on concurrent `cursor-agent` spawns to clear the `~/.cursor/cli-config.json` rename herd.
5. **`loom retry <story-id> [--clean]`** built on the existing `StoryRetryService`, using the queue approach: if a live epic lease exists, reset-to-ready and let the lease-holder dispatch; only self-dispatch when no lease is held.
6. **Sleep-proof timers** — monotonic `process.hrtime.bigint()` for all duration math, with heartbeat-based suspend detection (wall-clock jump > 6× poll interval). On detected sleep, re-arm all timers from the resume instant and route the worker through the shared infra-retry path.
7. **Checkpoint-on-stop** — a bounded (30s/worker) WIP-commit attempt in each in-flight worktree before SIGTERM, using the existing timeout-path commit machinery; stop proceeds regardless of checkpoint outcome.
8. **Gate-before-promotion reorder** — move `promoteArtifacts` ahead of the integration gate in `EpicFinalizer.finalize()`, collapsing block-mode to a single promotion site.

## Constraints

- **Stack:** TypeScript / Node 20+; `better-sqlite3` state; the new column goes through `packages/loom-core/src/state/` migrations. Tests live in `__tests__/` next to each touched module.
- **Determinism:** all timer and jitter work must use injectable clock/timer/seed sources — no real sleeps in tests. Extend the existing `WorkerTimeoutGuard` injectable-`now` pattern.
- **Test isolation:** use the `spawnChild` seam in `BaseCliWorker` to simulate each infra signature without a real CLI. **Each of the four signatures gets its own asserted classification + retry test** — not one rolled-up case.
- **Loudness invariant:** a worker exiting non-zero *after* producing output is a work failure — never reclassified as infra, consumes the failure budget, surfaces exactly as today. Asserted by test.
- **Engine-tuned, not policy:** all retry/backoff constants live in one source location; no new policy knobs.
- **Sibling-epic coordination:** the "status lifecycle & observability" epic also edits `EpicFinalizer.ts` (status transitions + PR-URL recording) and `docs/capabilities.md`. This epic's finalizer diff is confined to promotion-vs-gate ordering; exactly one owner story carries the minimal capabilities diff.

## Risks and Open Questions

- **Misclassification risk.** If an infra signature overlaps a genuine work failure's output, loom could silently swallow a real defect. The loudness invariant test is the guardrail, but the four signatures may not be exhaustive — new infra failure modes will surface in future dogfood runs. `[ASSUMPTION]` the four documented signatures cover the dominant N5–N13 cases; the classifier should be structured to admit new signatures cheaply.
- **Sleep-detection threshold.** The > 6× poll-interval heuristic (>30s at the 5s default) separates sleep from scheduler jitter. `[ASSUMPTION]` a closed laptop always produces a jump well beyond 30s; very brief suspends could fall below the threshold and be treated as jitter — acceptable since sub-30s gaps don't meaningfully threaten timer math.
- **Gate-on-promoted-tree trade-off.** Reordering means a gate *failure* leaves promoted-artifact commits on the epic branch. This is accepted: the branch is loom-owned and block-mode withholds the PR. Open: confirm no downstream consumer reads the epic branch expecting a gate-clean state.
- **MCP orphaning hazard.** Calling `loom_retry_story` from a one-shot stdio client orphans the in-process supervisor it spawns. This epic documents the hazard on the tool rather than fixing it; the real fix is the shared CLI path. `[ASSUMPTION]` documentation is sufficient interim mitigation.
- **Concurrent-epic merge conflict.** Two epics editing `EpicFinalizer.ts` and `docs/capabilities.md` simultaneously risks conflicts. Mitigated by confining each epic's diff to its declared surface, but ordering of merges is an open coordination question.
- **Budget-reset semantics.** `[ASSUMPTION]` operators understand that `loom retry` grants a *fresh* auto-retry budget (not just a single re-dispatch); this should be surfaced in the command's output text.

## Success Criteria

- Each of the four simulated infra signatures (connection-loss, spawn `ENOENT`, cli-config rename race, exit-before-output) is classified `infra_failure`, auto-retried with backoff, and the story still lands — driven via the `spawnChild` seam, each as its own asserted test.
- Attempts show the `infra_failure` classification in the attempt column and audit log, distinct from real story failures; a genuine non-zero-exit-with-output failure consumes the failure budget and is **not** reclassified.
- `loom retry <story>` resets and re-dispatches a failed story end-to-end with no hand-written scripts — including the queue path where an idle supervisor holds the epic's lease (reset + supervisor pickup).
- A simulated suspend (mocked monotonic-vs-wall divergence > 6× poll interval) does not kill a streaming worker; all timers re-arm and the slept worker flows through the shared infra-retry path.
- `loom stop` leaves a checkpoint commit in every in-flight worktree; a hung checkpoint does not block the stop.
- The integration gate demonstrably runs on a tree that already contains the promoted artifacts, and the block-mode path performs exactly one promotion (no double commit).
- `docs/capabilities.md` is updated by the single owner story: the retry row gains the CLI form and the `loom stop` row notes the checkpoint commit. No new knob rows.
