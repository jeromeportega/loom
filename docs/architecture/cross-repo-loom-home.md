# Cross-Repo loom & loom-home — Design

> Status: design / direction agreed. Phasing locked; Phase 1 is the next build.
> This is the anchor doc for the cross-repo initiative; epics are planned against it.

## Motivation

Today loom hardcodes one assumption: **`cwd` is the repo.** Everything follows from it:

- Loom's artifacts — planning briefs/PRDs/architectures, `.loom_outputs/epic-NNN/`,
  decision traces — are **committed into the repo being worked on**, polluting its
  history (every epic this session added four `.loom_outputs/` files to the loom repo).
- State (SQLite), worktrees, and policy are all per-repo, rooted at the cwd.

Two needs push past this:

1. **Stop polluting target repos** — loom should be a guest that leaves only clean,
   reviewed code PRs, not artifacts strewn through the house.
2. **Eventually work across multiple repos** — a single feature that spans a backend,
   a frontend, and a shared library; finding an endpoint definition in another service.

And one opportunity: loom's **accumulating context** (skills, lessons, decision traces,
the shared contract) is a compounding moat *if* it's consolidated, versioned, and
shareable across a team — rather than scattered per-repo and per-machine.

## North star & phasing (a de-risked staircase, not a big bang)

The scary parts of cross-repo are the **execution** problems (coordinated/atomic landing
across N repos, a gate that builds the consumer against the producer's change, cross-repo
contract handoff). We do NOT take those on first. We build the control plane first, which
is valuable immediately and is the foundation the hard parts need.

- **Phase 1 — loom-home control plane (single-repo).** Separate loom's artifacts, state,
  config, and brain into a `loom-home` repo; target repos stay clean; establish the
  workspace model. Valuable the day it ships (kills the pollution), dogfoodable on loom's
  own repo, and the foundation for everything. **No cross-repo execution yet.** ← NEXT BUILD
- **Phase 2 — multi-repo READ access.** Target repos in the workspace are searchable; agents
  retrieve context cross-repo (the "find the undocumented endpoint" case — the source
  code is the documentation, retrieved selectively on demand). Low risk: read-only.
- **Phase 3 — cross-repo EXECUTION.** Coordinated/atomic landing across repos, a cross-repo
  integration gate, producer→consumer interface contracts + ordering. The hard part — on a
  proven foundation.
- **Later — Mission Control** (the interactive board + EA supervisor + persona roster) and
  **fleet management** (N independent projects). Explicitly after the above.

Each phase is independently shippable and de-risks the next.

## Phase 1 design: loom-home

### The model
- **loom-home** is a git repo at a configured location holding loom's operational world.
- A **workspace manifest** in loom-home references the target repo(s). Phase 1: exactly one
  target repo (single-repo), so the manifest is trivial but the *seam* is established.
- This replaces `cwd = the repo`: loom operates *from* loom-home and acts *on* the
  referenced target repo.

### What moves INTO loom-home (committed → shareable)
- Planning artifacts (briefs / PRDs / architectures).
- Epic/standalone-story outputs (`.loom_outputs/...`).
- The brain: extracted skills, lessons, durable decision traces, the improvement log.
- Team operational config (model prefs, integration endpoints like the Jira base URL).

### What stays MACHINE-LOCAL (gitignored within loom-home)
- The SQLite state DB (per-machine runtime state).
- Worktrees (`.loom/worktrees`, `.loom/integration`) — these attach to the *target* repo
  and are machine-local.
- In-flight leases / ephemeral run state.

### Config hierarchy (resolves in layers)
1. **Secrets → env vars**, never committed (PAT/tokens; loom's existing `worker_auth` rule).
2. **Team operational config → loom-home** (committed; a new repo added later inherits it).
3. **Per-repo overrides → the target repo's `policy.yaml`** (protected branches, remotes,
   repo-specific overrides).

Resolution precedence: loom-home team config (base) ← target repo `policy.yaml` (override)
← env (secrets / final override).

### loom-home == the team-context repo
loom-home *is* the shareable knowledge base. It's a git repo, so pushing it to a team remote
yields the versioned, shared brain + config + artifact history. Phase 1 establishes it
locally; team-sharing is a natural consequence (and the moat — an accumulating context that
degrades without curation, which the future steward agents will tend).

### Migration
- `loom init` evolves to: initialize loom-home + register the target repo in the manifest.
- Existing single-repo `.loom/` state migrates into loom-home (artifacts/state relocate).
- Already-committed `.loom_outputs/` in target repos: leave as history, or an optional cleanup.
- A clear, tested migration path for existing loom users (including loom's own repo — which
  becomes the first loom-home dogfood).

### Invariants
- **Target repos stay clean** — only real code PRs land in them; no loom artifacts committed
  to a target repo after this.
- **Secrets are never committed** (env-only).
- Guard engine, EpicFinalizer/PR flow, and worktrees still work — now via loom-home + target
  references.
- **Single-repo behavior is unchanged** apart from artifacts relocating out of the target repo.

## How existing primitives generalize (for Phase 3, not built yet)
- Conflict-aware decomposition (epic-028, serialize on shared resource) → cross-repo
  dependency ordering (producer repo before consumer repo).
- Shared contract / file-ownership (epic-016) → cross-repo interface contracts.
- Build-up context (epic-029) → cross-repo context propagation.
- Bounded integrator + per-epic finalize → per-repo PRs with cross-repo ordering.

## Out of scope for Phase 1
- Cross-repo execution / coordinated landing (Phase 3).
- Cross-repo read access (Phase 2).
- Mission Control board, EA supervisor, persona roster, fleet management (later).
- The Jira / external-context import adapter (separate track).

## Open questions (resolve during Phase 1 planning)
- loom-home location default: a configured path? a sibling of the target repo? `~/loom-workspace`?
- State DB location: gitignored inside loom-home vs a per-machine path outside it.
- How loom-home references the target repo: relative path, absolute path, or git remote.
- Migration UX for existing loom repos (one-shot `loom migrate`?).
