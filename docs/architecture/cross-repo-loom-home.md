# Cross-Repo loom & loom-home — Architecture

> Status: shipped across epics 050–063.
> This is the anchor doc for the cross-repo initiative; epics were planned and delivered against it.

## Motivation

Loom previously hardcoded one assumption: **`cwd` is the repo.** Everything followed from it:

- Loom's artifacts — planning briefs/PRDs/architectures, `.loom_outputs/epic-NNN/`,
  decision traces — were **committed into the repo being worked on**, polluting its
  history with loom-internal state.
- State (SQLite), worktrees, and policy were all per-repo, rooted at the cwd.

Two needs drove past this:

1. **Stop polluting target repos** — loom is a guest that leaves only clean,
   reviewed code PRs, not artifacts strewn through the house.
2. **Work across multiple repos** — a single feature spanning a backend,
   a frontend, and a shared library; finding an endpoint definition in another service.

And one opportunity: loom's **accumulating context** (skills, lessons, decision traces,
the shared contract) is a compounding moat *if* consolidated, versioned, and
shareable across a team — rather than scattered per-repo and per-machine.

## What shipped

### loom-home control plane (epics 050–055)

**loom-home** is a git repo at a configured location holding loom's operational world.
A **workspace manifest** in loom-home references the target repo(s). Loom operates
*from* loom-home and acts *on* the referenced target repos.

#### What lives in loom-home (committed → shareable)

- Planning artifacts (briefs / PRDs / architectures) — relocated from the target repo.
- Epic/standalone-story outputs — stored under `repos/<slug>/<epic-id>/` in loom-home.
- The brain: extracted skills, lessons, durable decision traces, the improvement log.
- Team operational config (`team-config.yaml`) — model prefs, org-wide defaults.
- The state database (`loom.db`) — stored under `loom-home/repos/<slug>/loom.db`, gitignored.

#### What stays machine-local (gitignored within loom-home)

- The SQLite state DB (per-machine runtime state).
- Worktrees (`.loom/worktrees`, `.loom/integration`) — attach to the target repo,
  machine-local.
- In-flight leases / ephemeral run state.

#### Target repos stay clean

After loom-home migration, only real code PRs land in target repos. No loom artifacts
are committed to a target repo. Delivered artifacts live in the loom-home control plane;
target repositories receive only code pull requests.

### Workspace manifest (epics 052–053)

`<loom_home>/workspace.yaml` records every repo registered with this loom installation.
Each entry carries: `slug` (derived from the git remote URL and project name —
the canonical identity key), `path` (absolute filesystem path at registration time),
and `remote_url` (git remote URL, may be `null`).

Two registration paths:
- `loom init` writes an entry explicitly and registers the repo in the workspace manifest.
- `resolveActiveRepo` auto-registers the repo on first use if no entry with that slug exists.

Registration is idempotent: a second `loom init` or subsequent call for an already-registered
slug is a no-op.

### Config precedence (FR-6)

Loom composes one effective policy from three layers in fixed precedence (lowest to highest):

```
loom-home team config (base)  ←  target-repo policy.yaml (override)  ←  env vars (secrets / final override)
```

- **`team-config.yaml`** in loom-home sets organisation-wide defaults.
- **`policy.yaml`** is the per-repo override at `.loom/policy.yaml`.
- **`LOOM_*` env variables** are the highest layer for CI/CD or per-deployment overrides.

Merge semantics by field type: scalars — higher layer wins; maps — deep key-wise merge;
guard denylists — union across all layers; guard allowlists — intersection across all layers.

### State database migration (epics 054–055)

The SQLite state database (`loom.db`) relocated from `.loom/loom.db` to
`loom-home/repos/<slug>/loom.db`. On first run after upgrade, loom automatically moves
every row with zero data loss. WAL sidecar files are checkpointed before the move;
cross-filesystem moves use copy-then-verify. An atomic mkdir-based lock prevents
double-migration. Subsequent runs skip migration (idempotent).

The planning scratch (brief, PRD, architecture, epic YAML) relocated similarly to
`loom-home/repos/<slug>/planning/`.

### Cross-repo execution (epics 056–063)

A single brief can coordinate work across N registered repos (any number ≥ 2).
Each story carries an optional `repo` field (a manifest slug); stories with no `repo`
resolve to the primary repo.

**A single-repo epic produces one pull request. A cross-repo epic produces one
pull request per repository, landed in topological (dependency) order with
all-ready-or-none staging and forward-revert rollback.**

#### Ordered landing

The `CrossRepoCoordinator` partitions stories into per-repo stages, builds a dependency
DAG from story-level `dependencies`, topologically sorts the stages so every producer
repo lands before its consumers, and dispatches each stage through the Supervisor's
`repoFilter` seam.

Cross-repo cycle rejection: before any epic transitions to `approved`, loom validates
the repo dependency graph for cycles. Cyclic epics are rejected at `loom approve`
with a named error before any worker dispatches.

#### All-ready-or-none staging gate

Before any PR is merged to `main`, `assessLandingReadiness` verifies that every repo
has an open PR with a green integration gate and a green consumer-repo gate. If any
repo is not ready, landing is blocked entirely.

#### Forward-revert rollback

If a merge fails after one or more repos have already landed, loom opens forward-revert
PRs (`git revert --no-edit -m 1 <mergeCommitSha>`) for every merged repo in reverse
dependency order (consumer before producer), recovering the affected repos to their
pre-landing state without rewriting history. The rollback is idempotent and resumable
from `revert_pending`.

#### Single-repo backward compatibility

Single-repo epics are byte-identical to before — no manifest change, no worktree-path
change, no branch-name change, no extra PR. The generalization is invisible when only
one repo is in scope.

### Cross-repo read access

Workers can explicitly pull a bounded, read-only slice from a registered sibling
repository via `loom retrieve search` and `loom retrieve read`. Context is pull-only —
never injected ambiently. Three hard constraints: read-only, registered-only
(manifest scoping), and secret-excluded.

### Migration command (epic 057)

`loom migrate [--dry-run] [--relocate-committed-artifacts]` turns the invisible
auto-migration into an explicit, idempotent, operator-facing operation. Ensures
loom-home exists, runs state-database and planning-scratch migration, registers the
repo in the workspace manifest, then prints a migration report.

## Invariants

- **Target repos stay clean** — only real code PRs land in them; no loom artifacts
  committed to a target repo.
- **Secrets are never committed** (env-only).
- Guard engine, EpicFinalizer/PR flow, and worktrees all work via loom-home + target
  references.
- **Single-repo behavior is unchanged** apart from artifacts relocating out of the
  target repo.
- **Per-repo policy and guardrails are enforced structurally**: each story worktree
  loads its own repo's `policy.yaml`.

## What is NOT in scope (deferred)

- Mission Control (interactive web board) — not shipped.
- Fleet management (N independent projects interactive UI) — not shipped.
- Federated team-wide run visibility (cloud Postgres mirror) — not shipped.
- Sharing DB-resident learnings to a team remote — not shipped.
- Jira intake adapter — not shipped.
