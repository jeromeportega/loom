# Fix `loom revert`: Remove Lingering Worktrees Before Deleting Branches

## The Problem

`loom revert` of an epic crashes on any epic that has lingering git worktrees. The `EpicReverter` deletes the epic and story branches via `git branch -d/-D` without first removing the worktrees that still have those branches checked out. Git refuses with `cannot delete branch '<name>' used by worktree`, and the revert aborts partway through.

This is not an edge case: it is the common path for any epic that was **stopped or blocked and never finalized**, leaving an integration worktree at `.loom/integration/<epic-id>` and one or more story worktrees at `.loom/worktrees/<story-id>` in place. Today the operator must manually `git worktree remove` each one before retrying — undocumented cleanup that defeats the purpose of a single revert command.

## Target Users

- **Primary:** loom operators reverting an epic that did not finalize cleanly (stopped, blocked, or abandoned mid-flight).
- **Secondary:** loom contributors who rely on `revert` to reset repo state between test runs and dogfooding cycles.

## Proposed Solution

Make `EpicReverter` worktree-aware. Before deleting any branch, remove the worktree(s) that have it checked out and prune stale worktree metadata, so branch deletion always operates on branches no worktree is holding. The revert then completes in one command with no manual cleanup.

## Key Capabilities

1. Remove the epic's integration worktree at `.loom/integration/<epic-id>` before deleting the epic branch.
2. Remove each lingering story worktree at `.loom/worktrees/<story-id>` before deleting its story branch.
3. Run `git worktree prune` to clear stale metadata before branch deletion.
4. Use **non-force** worktree removal when the worktree is clean.
5. Tolerate an already-removed worktree: treat a missing worktree as success, not an error, so revert is idempotent and resumable after a partial prior run.

## Constraints

- **Scope:** A focused, single-module change to `EpicReverter` plus one test. No changes to the revert CLI surface, policy engine, or other modules.
- **Removal ordering is load-bearing:** worktree removal → prune → branch delete. Reversing this reproduces the original crash.
- **Path conventions are fixed:** integration worktrees live at `.loom/integration/<epic-id>`, story worktrees at `.loom/worktrees/<story-id>`. The fix must derive paths from epic/story IDs accordingly.
- Prefer non-force removal so unexpected uncommitted work in a worktree is surfaced rather than silently discarded.

## Risks and Open Questions

- **Dirty worktree behavior is unspecified.** The brief mandates non-force removal "where the worktree is clean" but does not say what to do when a worktree has uncommitted changes. `[ASSUMPTION]` Non-force removal will fail on a dirty worktree; the intended behavior is to let that failure surface (abort with a clear message) rather than force-remove and lose work. This should be confirmed before implementation.
- `[ASSUMPTION]` The reverter can enumerate story IDs for the epic from existing planning/state metadata; if not, discovering which story worktrees exist may require scanning `.loom/worktrees/`.
- `[ASSUMPTION]` "Prune" maps to `git worktree prune`. A single prune after removals is sufficient; per-worktree pruning is not required.
- Partial-failure semantics: if removal succeeds for some worktrees but a later branch delete fails, the repo is left in an intermediate state. The idempotency capability (#5) is intended to make re-running revert safe, but the desired all-or-nothing vs. best-effort contract is not stated.

## Success Criteria

- Reverting an epic that has a lingering integration worktree succeeds with no manual worktree cleanup — covered by a new **regression test** that sets up an epic with a lingering integration worktree, runs revert, and asserts both the worktree and its branch are gone.
- Reverting an epic with lingering story worktrees deletes their branches without the `cannot delete branch used by worktree` error.
- Re-running revert after a worktree is already removed completes without error (idempotent).
- Clean worktrees are removed without `--force`.
- No regression to reverting an epic that has **no** lingering worktrees (the previously-working path still passes).
