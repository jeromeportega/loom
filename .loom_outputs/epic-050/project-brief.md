# loom-home: Relocate Committed Artifacts to a Control-Plane Repository

## The Problem

Today, loom commits its own operational artifacts into the very repository it is working on. Every epic writes its per-epic outputs — `project-brief.md`, `prd.md`, `architecture.md`, and `epic.yaml` under `.loom_outputs/<epic-id>/` — into the target repo and commits them onto the epic branch. As a result:

- The target repo's git history is polluted with loom's planning artifacts, not just real code.
- The per-epic pull request mixes generated planning documents with the code change a reviewer actually needs to evaluate.
- A repo's commit log no longer cleanly reflects "what changed in this product"; it reflects "what loom did while building it."

The party harmed is the **operator running loom on a real codebase** (and any reviewer of that codebase's PRs): they inherit operational noise in a history they expect to contain only product changes.

This brief covers **Phase 1, first slice** of the cross-repo / loom-home design in `docs/architecture/cross-repo-loom-home.md`. It establishes the loom-home location and moves committed artifacts there — and deliberately nothing more.

## Target Users

- **Primary — loom operators.** Engineers who run loom against their own repositories and want those repos' history and pull requests to contain only real code.
- **Secondary — reviewers of loom-generated PRs.** They benefit from PRs that are code-only and therefore reviewable on their merits.
- **Secondary — the loom project itself (dogfooding).** After adoption, loom's own repo gets a loom-home and stops accumulating `.loom_outputs/` from the next epic onward — a clean cutover.
- **Anti-persona — the cross-repo power user.** Someone expecting state relocation, a full workspace manifest, three-layer config, or cross-repo execution *in this slice*. Those are explicit follow-ons; this epic must not start them.

## Proposed Solution

Introduce **loom-home**: a separate git repository, at a configurable location, that holds loom's committed artifacts. During planning and finalize, loom writes each epic's artifacts into loom-home and commits them to **loom-home's own git history** — instead of writing and committing them onto the target repo's epic branch.

The location defaults to a sibling directory at the **workspace root** (the parent directory where the user keeps their repos): e.g. if the target repo is `~/repos/app`, loom-home resolves to `~/repos/loom-home`. If loom-home does not exist at the resolved location, loom **creates and `git init`s it**. Each artifact set records **provenance** — which target repo and which epic it belongs to — so loom-home's accumulated history stays traceable across many source repos.

Net effect: loom-home accumulates the planning and artifact history; the target repo's epic branch and PR contain only code changes.

## Key Capabilities

1. **Resolve a loom-home location** — configurable, defaulting to a sibling directory at the workspace root.
2. **Create and initialize loom-home on demand** — if absent at the resolved location, create the directory and `git init` it.
3. **Route artifact writes to loom-home** — the per-epic outputs that currently land in `.loom_outputs/<epic-id>/` are written into loom-home instead of the target repo.
4. **Commit artifacts to loom-home's own git history** — during planning and finalize, not onto the target repo's epic branch.
5. **Record provenance** — each artifact set captures its target repo and epic so loom-home history is traceable.
6. **Keep the target repo code-only** — no loom operational artifacts are committed into the target repo after this change.
7. **Add a single config setting** for the loom-home location (location only — no broader config hierarchy).

## Constraints

- **Single setting only.** Add exactly one configuration knob: the loom-home location, with the sibling-at-workspace-root default. Do **not** build the three-layer config hierarchy (team vs per-repo vs env) from the design doc — that is a follow-on. Secrets are unaffected.
- **No history rewrite.** Existing `.loom_outputs/<epic-id>/` already committed in the target repo are left in place as history. No dedicated migration command in this epic.
- **Committed artifacts only move.** Machine-local state (the SQLite database) and worktrees are already gitignored and not committed; they stay exactly where they are. Only the *committed* artifacts relocate.
- **Behavior parity.** Single-repo planning, dispatch, the integration gate, the per-epic PR, worktrees, and the guard engine all continue to work unchanged — now with artifacts routed to loom-home.
- **Guardrail integrity.** Do not weaken any guardrail. loom-home is a separate repository with separate git history; its commits must not interfere with the target repo's git operations.
- **Docs currency.** Update `docs/capabilities.md` to describe loom-home artifact relocation and pass the capabilities drift check (per repository convention that user-visible features update that page in the same PR).

## Out of Scope

Explicitly deferred to follow-on epics: relocating the SQLite state DB; the full workspace manifest beyond the loom-home location; the three-layer config hierarchy; any cross-repo read or execution; a migration command for already-committed artifacts; Mission Control and fleet.

## Risks and Open Questions

- **Workspace-root resolution ambiguity.** "Sibling at the workspace root" assumes loom can reliably determine the parent directory the user treats as their repo root. `[ASSUMPTION]` The workspace root is the immediate parent of the target repo; if a user nests repos differently, the default may resolve to an unexpected location. Resolution logic and its override path should be specified precisely.
- **loom-home name/path collision.** A directory already named `loom-home` at the resolved location may exist but not be a git repo, or may belong to something else. `[ASSUMPTION]` If it exists and is already a git repo, loom reuses it; if it exists but is not a git repo, behavior must be decided (init-in-place vs error).
- **Concurrent / multi-repo writes.** If loom runs against multiple target repos that resolve to the *same* loom-home, concurrent commits could contend. `[ASSUMPTION]` This slice assumes sequential, single-operator use; provenance disambiguates *content* but not *commit-time concurrency*.
- **Finalize partial failure.** If artifacts are written to loom-home but the loom-home commit fails (or vice versa), the epic could end in a split state. The failure/rollback semantics between target-repo operations and loom-home commits should be defined.
- **Provenance format.** The exact mechanism for recording "which target repo + which epic" (commit message convention, a metadata file, directory layout) is unspecified and should be pinned down — it determines long-term traceability.
- **Dogfood cutover timing.** loom's own repo adopts a loom-home "after this lands and is adopted." `[ASSUMPTION]` The cutover is manual and occurs once, with `.loom_outputs/` already in loom's history left untouched.

## Success Criteria

1. loom resolves a loom-home location that is configurable and defaults to a sibling directory at the workspace root; if missing at the resolved location, loom creates and `git init`s it.
2. The per-epic artifacts that currently land in `.loom_outputs/<epic-id>/` are written into loom-home and committed to **loom-home's own git history**, with provenance recording the target repo and epic.
3. The target repo's epic branch and pull request contain **only code** — no loom artifacts are committed into the target repo after this change, **proven by a test**.
4. Existing already-committed artifacts in the target repo are left untouched — no history rewrite.
5. Single-repo planning, dispatch, integration gate, per-epic PR, worktrees, and guardrails are unchanged in behavior; no guardrail is weakened.
6. loom-home commits do not interfere with the target repo's git operations.
7. `docs/capabilities.md` documents loom-home artifact relocation and the capabilities drift check passes.
8. The full build and test suite pass.
