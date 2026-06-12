---
title: "Epic 3 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 3 Review: Story Dispatch

Reviewing the WorktreeManager, the WorkerRunner abstraction (ClaudeCodeWorker +
MockWorkerRunner), the worker prompt, and the Supervisor, with an eye on downstream
impact on Epics 4–6.

## Findings

### High — fixed in this pass

**1. Worker `git push` bypassed `policy.git.allowed_remotes`.**
- `ClaudeCodeWorker.maybeOpenPr()` pushed the story branch to the default remote
  without consulting policy. The Epic 1 guard engine blocks a *worker's* push to a
  non-allowed remote, but loom's *own* push (to open the PR) skipped that check.
- **Impact**: a team that set `allowed_remotes: []` (or a restrictive allowlist)
  would still have loom push their code to `origin`.
- **Fix**: `ClaudeCodeWorker` now takes `allowedRemotes`; before pushing it resolves
  the remote URL and matches it against the patterns. No match → the branch stays
  local and the story still completes (`done`, branch ready). `loom run` passes
  `policy.git.allowed_remotes`. With the default policy (`allowed_remotes: []`),
  loom produces local branches and does not push — safe by default; add your remote
  to `allowed_remotes` to enable PRs.

### High — documented, operational requirement

**2. Worker guardrails require `loom` to be on PATH.**
- Workers run via `claude --permission-mode bypassPermissions` — deliberately, because
  the loom guard hook is the structural safety net. But that hook's command is
  `loom guard hook`. If `loom` is not on the worker's PATH, the hook cannot execute
  and workers run **unguarded**.
- **This is the single most important operational prerequisite.** It is now called out
  prominently in `docs/testing.md` and `docs/known-limitations.md`: install loom
  globally (`npm link` / `npm i -g`) before running real workers.
- **Epic 6 follow-up**: `loom init` should write an absolute path to the loom binary
  into the hook command, removing the PATH dependency entirely.

### Medium — fixed in this pass

**3. Epics were marked `done` even when their stories failed.**
- The Supervisor unconditionally set every processed epic to `done`. An epic with
  failed/blocked stories would misleadingly read as complete.
- **Fix**: an epic becomes `done` only when every story succeeded; otherwise it stays
  `in_progress`. Combined with the resumable supervisor (completed stories are skipped),
  re-running `loom run` cleanly retries just the failed stories.

### Medium — documented, deferred

**4. Worktrees are never cleaned up.**
- The Supervisor creates a worktree per story and never removes one. `.loom/worktrees/`
  grows by one directory per story, forever.
- Intentional for now — the user needs the worktrees to review un-merged work.
  `WorktreeManager.remove()` exists; a `loom clean` command (remove worktrees for
  merged/closed stories) is the planned follow-up.
- **Action**: documented in known-limitations.

**5. `ClaudeCodeWorker` is a large integration seam loom cannot CI-test.**
- The `claude` subprocess spawn and the push / `gh pr create` flow only run against a
  real environment. `buildWorkerPrompt` and the result-interpretation logic *are*
  unit-tested; the Supervisor is fully tested via `MockWorkerRunner`.
- This mirrors Epic 1's hook seam — structured defensively (every failure path falls
  back to a sane `WorkerResult`), and documented.

### Low — minor, deferred

**6. A retried story reuses its old worktree.**
- After a failed story, re-running `loom run` creates a fresh agent record but
  `WorktreeManager.create()` is idempotent — it returns the existing (half-done)
  worktree. The worker fixes forward rather than starting clean. Acceptable; documented.

**7. `loom status` shows every agent attempt.**
- Retries create new agent rows; `listByEpic` returns them all, so a retried story
  appears twice in `loom status`. Cosmetic. Documented (carried from Epic 1 #9).

## Downstream impact matrix

| Finding | Epic 4 (MCP) | Epic 5 (Skills) | Epic 6 (IDE) |
|---|---|---|---|
| #1 push policy | — | — | — (fixed) |
| #2 loom on PATH | — | — | **`loom init` should write an absolute hook path** |
| #3 epic status | `loom_get_status` reflects it correctly | — | — |
| #4 worktree cleanup | a `loom clean` MCP tool later | — | — |
| #5 worker seam | — | skills inject into the same prompt | — |
| #6, #7 | — | — | — |

## What's solid

- **`WorkerRunner` seam**: the Supervisor never spawns a process directly. Dependency
  ordering, the concurrency cap, failure propagation, and resumability are all tested
  with `MockWorkerRunner` — no `claude` CLI needed.
- **Structural worktree isolation**: each story runs on its own branch in its own
  worktree. Git itself forbids a worktree from checking out a branch already checked
  out elsewhere — so a worker physically cannot touch `main`.
- **Dependency-aware branching**: a dependent story's worktree branches from its
  dependency's branch, so the worker starts with the dependency's committed code.
- **Resumable**: `loom run` skips stories already completed; failed epics stay
  `in_progress` and a re-run retries only what failed.
- **Cycle safety**: `validateEpicSet` now rejects dependency cycles at planning time,
  so the Supervisor can never deadlock on one; an unreachable dependency degrades
  cleanly to `blocked` rather than hanging.
- **Real git, real tests**: `WorktreeManager` is tested against actual `git worktree`
  operations in throwaway repos, including the macOS realpath edge case.
