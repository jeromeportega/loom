# Robust Epic Finalization and Guard-Compatible Release Flow

## The Problem

Loom can complete all the hard work of an epic — every story done, the integration gate green — and still report the epic as a **failure** because of a publish-step mishap. Two failures were observed while dogfooding loom on itself:

1. **A green epic stranded as failed.** During rolling integration, the remote epic branch diverged from the local one. When `EpicFinalizer` tried to push the integrated branch, the push was rejected as non-fast-forward; force push is (correctly) blocked by the policy guard; loom then marked the entire epic `failed`. A complete, gate-green epic was reported as a failure — and there is **no recovery command**: `reconcile` only targets in-progress, gate-blocked epics; `retry` is per-story; there is no re-finalize action.

2. **Releases can't run inside a loom repo.** Cutting a records-only version release requires pushing the bump commit to `main`. Loom's own protected-branch guard blocks that push for everyone, including the operator. The documented release flow cannot run; a hand-made release branch and PR is the only path.

The unifying failure mode: **infrastructure/publish friction is being conflated with genuine failure**, and the operator has no clean path through either case.

## Target Users

- **Primary — the loom operator** running epics and cutting releases inside a loom-governed repo. They need a green epic to reach `done`, and a release to ship, without fighting the guard or hand-crafting branches.
- **Secondary — loom maintainers dogfooding loom on itself**, who hit these exact failures and need the lifecycle to tell the truth about what actually went wrong.
- **Anti-persona — the worker agent.** Nothing here loosens what workers may do. The protected-branch guard and force-push prohibition remain fully in force for them.

## Proposed Solution

Make finalization and release **publish-failure tolerant** without weakening any guard:

- Finalize to a **fresh, finalizer-owned branch ref** so the PR always opens from a clean branch that rolling integration never touched — eliminating the non-fast-forward collision at its source.
- Introduce a **recoverable, non-terminal epic state** for "work complete, only publish remains," distinct from terminal `failed`.
- Give the operator a **recovery command** that drives such an epic to `done`.
- Provide a **guard-compatible release path** so version releases ship through a PR rather than a direct push to `main`.

## Key Capabilities

1. **Collision-free finalize push.** `EpicFinalizer` pushes the integrated epic branch to a fresh, uniquely named ref it owns — never reusing a ref rolling integration may have diverged. No force push, ever.
2. **Recoverable lifecycle state.** When all stories are done and the gate passed but push/PR fails, the epic lands in a clearly labeled recoverable state, not terminal `failed`.
3. **Honest status surfaces.** Status output communicates that the work is complete and only the publish step remains.
4. **Operator recovery command.** A way to drive a stranded green epic to `done` after the fact — open the PR from the already-integrated, gate-green branch, record the epic PR URL, flip the epic to `done`.
5. **Guard-compatible release.** Cut a records-only version release without a hand-made release branch or a blocked push to `main`.
6. **Documentation parity.** The releasing runbook documents the chosen flow so the written process actually works inside a loom repo.

## Constraints

- **Do not weaken the protected-branch guard for worker agents.**
- **No force push anywhere.**
- **Preserve the honest lifecycle distinction:** `failed` = real infrastructure failure; `rejected` = human decision. The new recoverable state must not blur these.
- **Integration gate behavior is unchanged.**
- **Do not break existing `reconcile` behavior** for the gate-blocked case.
- Reuse the existing versioning script for any version bump.
- Per repo policy, any user-visible CLI command or policy knob added here must be reflected in `docs/capabilities.md` in the same PR.

## Risks and Open Questions

- **Recovery surface — extend `reconcile` vs. add a `finalize` command.** The brief permits either. `[ASSUMPTION]` A dedicated `loom finalize` (or `reconcile --finalize`) reads more clearly than overloading `reconcile`, which today means "unblock a gate-blocked epic." Final choice deferred to the PM/architect, but the two recovery semantics should stay distinguishable to the operator.
- **Release approach — fold-into-epic-PR vs. dedicated `loom release` command.** The brief requires choosing exactly one. `[ASSUMPTION]` A standalone `loom release` (bump via the existing script → open release PR → push tag after merge) is more broadly useful than coupling the version bump to an epic PR, since records-only releases occur independently of epics. Decision owned by PM/architect.
- **Tag push after merge.** A guard-compatible release still needs the post-merge tag push to succeed; confirm tag refs are not caught by the protected-branch guard, or define how the operator pushes the tag. `[ASSUMPTION]` Tag pushes are permitted by the guard; verify before relying on it.
- **Naming scheme for finalizer-owned refs.** Must be collision-proof across retries and concurrent epics; needs a deterministic, conflict-free convention. `[ASSUMPTION]` An epic-id-plus-finalize-suffix ref is sufficient.
- **State-name and migration.** Introducing a new lifecycle state may touch stored epic state, status rendering, and any state machine guards; existing epics in flight must not be misclassified.
- **Stale finalizer branches.** Fresh-ref-per-finalize may accumulate abandoned branches; cleanup policy is an open question (out of scope unless trivial).

## Success Criteria

1. A finalize whose epic-branch push would be non-fast-forward instead pushes to a fresh finalizer-owned ref and opens the PR successfully — **with no force push**.
2. An epic that is fully done and gate-green but cannot complete the publish step lands in a **recoverable, non-terminal state with a clear label**, not the terminal `failed` used for genuine failures; status surfaces show work complete / publish pending.
3. An **operator command** takes such an epic to `done` by opening the PR from the gate-green epic branch and recording the epic PR URL.
4. Cutting a **records-only version release no longer requires a hand-made release branch**, and the release runs under the protected-branch guard.
5. The **releasing runbook** documents a flow that works inside a loom repo and matches the implemented approach.
6. Existing `reconcile` (gate-blocked) behavior and the `failed`/`rejected` distinction are preserved.
7. **The full build and test suite pass.**
