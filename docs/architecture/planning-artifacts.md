# Why planning artifacts are committed to the repo

When loom plans an epic, four documents land in the working tree:

| File | Author | Purpose |
|---|---|---|
| `epics/<id>/brief.md` | Mary (Analyst) | Refined brief, restated for clarity |
| `epics/<id>/prd.md` | John (PM) | Product requirements + acceptance criteria |
| `epics/<id>/architecture.md` | Winston (Architect) | Component decomposition, tech notes |
| `epics/<id>/epic.yaml` | John (PM) | Machine-readable story breakdown |

These are not transient scratch files. Loom expects them to be **committed
to the same git history as the code they produce**. This page documents why.

## The primary reason: replay and audit

A loom run is an LLM-driven engineering process. The planner's outputs
shape every downstream worker decision. Six months later, when someone asks
"why did loom build it this way?", the only useful answer is "here is what
the planner said it would build."

That answer needs to live in the same place as the code: in `git log`. Not
in a SQLite row on the laptop of the operator who happened to run it, not
in a chat transcript, not in a wiki page that drifts away from the code.

Concretely, committing the artifacts gives us:

1. **Per-epic provenance.** `git log -- epics/epic-042/` shows exactly how
   the plan evolved before it was approved and how it survived (or didn't)
   the actual implementation. Plan revisions diff against prior plan
   revisions.
2. **PR-grade review surface.** Reviewers reading the worker's PRs can
   open the brief and PRD alongside the diff. The acceptance criteria the
   workers were given are at `epics/<id>/prd.md`, not in a stale Notion
   page.
3. **Replay.** Re-running an epic against a different model or with a
   different policy means feeding the planner the same brief. The brief is
   in the repo; the run is reproducible without needing the original
   operator's machine.
4. **Cross-machine visibility.** Loom runs are still per-machine today
   (issue #19), but planning artifacts in the repo cross machines via the
   normal git path. Anyone who pulls the branch sees what was planned.

## Secondary reasons

These don't drive the design but they do reinforce it.

### Worker worktrees need a committed baseline

Each story worker operates in its own `.loom/worktrees/<story-id>/`
checkout. That worktree is a branch off a real commit. If the planning
artifacts only exist as scratch files on the operator's laptop, the
worker's worktree doesn't see them — git worktree only carries committed
state. Putting the artifacts in the working tree and committing them
before dispatch is what makes them visible to every worker, every time.

### Plan history is itself signal

Plans get revised — the operator rejects a plan, the brief is refined,
the planner re-runs. Each revision lives in git history. When a future
operator runs `loom epic` on a similar brief, the diff between past
revisions is real evidence of what the planning loop converges on for
that kind of problem.

### The bench and eval pipelines depend on it

The benchmark methodology (`docs/testing/bench-methodology.md`) treats
the planning artifacts as inputs to scoring — when a run is classified
as a planning-mode failure vs. a worker-mode failure, the classifier
reads the planning artifacts off disk. That signal flow only works if
the artifacts are predictably on disk in a predictable place.

## What is NOT committed

For symmetry, the things loom does *not* commit:

| Artifact | Lives in | Reason |
|---|---|---|
| Worker stdout streams | `.loom/loom.db` (SQLite) | Volume; per-machine; not signal-bearing six months later |
| Skill candidates (generated) | `~/.loom/skills/generated/` | Per-machine until promoted via the cloud skills loop |
| Operator guidance notes | `.loom/guidance/<story-id>.md` | Per-run; intentionally ephemeral side-channel |
| Decision traces | `.loom/loom.db` (SQLite) | Operator-only debugging surface; structured replay belongs in DB |

The `.loom/` directory is in `.gitignore`. Everything in `epics/` is
not. That boundary is the one this page exists to explain.

## Operator-facing implications

- **Don't add `epics/` to `.gitignore`.** This is the most common
  accidental misconfiguration.
- **Treat brief/PRD/architecture edits like code review.** A revised
  PRD is a real change to what the workers will be told to build.
- **When rejecting a plan, leave the rejected artifacts on the branch.**
  `loom reject` flips the status; the artifacts stay in git history as
  evidence of what was tried.
- **The web dashboard surfaces these for review.** Navigate to a
  `planned` epic in `loom web` — the brief, PRD, architecture, and
  epic YAML render inline above the Approve button so the operator can
  read the plan without leaving the dashboard.
