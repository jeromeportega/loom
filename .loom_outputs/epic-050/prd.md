# PRD: loom-home — Relocate Committed Artifacts to a Control-Plane Repository

## Overview

Today loom commits its own operational artifacts — `project-brief.md`, `prd.md`, `architecture.md`, and `epic.yaml` under `.loom_outputs/<epic-id>/` — onto the epic branch of the *target* repository it is building. This pollutes the target repo's history and per-epic pull requests with planning documents that reviewers do not need, so the commit log no longer cleanly reflects product changes. This PRD covers **Phase 1, first slice** of the cross-repo / loom-home design (`docs/architecture/cross-repo-loom-home.md`): introduce **loom-home**, a separate git repository at a configurable location that holds loom's committed artifacts, and route artifact writes and commits there instead of into the target repo — and deliberately nothing more. Net effect: loom-home accumulates planning/artifact history with provenance; the target repo's epic branch and PR contain only code.

## Goals

1. **Target repo stays code-only.** After this change, zero loom operational artifacts are committed to the target repo's epic branch — proven by an automated test.
2. **Artifacts relocate with traceability.** 100% of per-epic artifacts that currently land in `.loom_outputs/<epic-id>/` are written into loom-home and committed to loom-home's own git history, each set recording provenance (target repo + epic).
3. **Zero behavior regression.** Single-repo planning, dispatch, the integration gate, the per-epic PR, worktrees, and the guard engine continue to pass unchanged; the full build and test suite are green.

## User Stories

- **(Must)** As a **loom operator**, I want loom's planning artifacts kept out of my repo's history so that my git log and PRs contain only real product changes.
- **(Must)** As a **reviewer of a loom-generated PR**, I want the PR to contain only code so that I can evaluate the change on its merits without wading through generated documents.
- **(Should)** As a **loom operator**, I want loom-home created and initialized automatically when it is missing so that I don't have to set it up manually before my first epic.
- **(Should)** As a **loom operator** running loom across several repos into one loom-home, I want each artifact set to record which repo and epic it came from so that the accumulated history stays traceable.
- **(Could)** As a **loom operator**, I want to override the loom-home location via a single config setting so that I can place it where my workspace layout requires.

## Functional Requirements

- **FR-1** — loom resolves a loom-home location that is configurable and defaults to a sibling directory at the workspace root (e.g. target repo `~/repos/app` → loom-home `~/repos/loom-home`).
- **FR-2** — `[ASSUMPTION]` The workspace root is defined as the immediate parent directory of the target repo; the resolution logic and its override path are specified precisely and covered by tests.
- **FR-3** — If no loom-home exists at the resolved location, loom creates the directory and runs `git init` on it.
- **FR-4** — If a directory already exists at the resolved location: if it is a git repo, loom reuses it; if it exists but is **not** a git repo, loom follows a defined, documented behavior (init-in-place vs. error) rather than failing ambiguously. `[ASSUMPTION]` Reuse when it is already a git repo.
- **FR-5** — The per-epic outputs (`project-brief.md`, `prd.md`, `architecture.md`, `epic.yaml`) that currently land in `.loom_outputs/<epic-id>/` are written into loom-home instead of the target repo.
- **FR-6** — During planning and finalize, loom commits the epic's artifacts to **loom-home's own git history**, not onto the target repo's epic branch.
- **FR-7** — Each artifact set records provenance — the target repo and the epic it belongs to — via a defined, pinned-down mechanism (e.g. commit-message convention, metadata file, and/or directory layout) so loom-home history is traceable across many source repos.
- **FR-8** — After this change, no loom operational artifacts are committed into the target repo's epic branch or PR — verified by an automated test asserting a code-only target-repo diff.
- **FR-9** — Exactly one configuration knob is added: the loom-home location, with the sibling-at-workspace-root default. No broader config hierarchy is introduced.
- **FR-10** — Failure/rollback semantics between target-repo operations and the loom-home commit are defined, so a finalize that succeeds on one side but fails on the other does not silently leave the epic in an undefined split state.
- **FR-11** — `docs/capabilities.md` is updated to describe loom-home artifact relocation, and the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1 (Guardrail integrity)** — No guardrail is weakened. loom-home is a separate repository with separate git history; its commits must not interfere with the target repo's git operations.
- **NFR-2 (Behavior parity)** — Single-repo planning, dispatch, the integration gate, the per-epic PR, worktrees, and the guard engine behave identically to before, now with artifacts routed to loom-home.
- **NFR-3 (No history rewrite)** — Existing `.loom_outputs/<epic-id>/` already committed in target repos are left in place; no migration or history rewrite is performed.

## Epics

This PRD is delivered as **one epic**: *Relocate committed loom artifacts to a loom-home control-plane repository.* The work is a single cohesive change — location resolution, on-demand init, write routing, commit-to-loom-home with provenance, and the docs/test updates that prove it — with no independently shippable second unit.

## Out of Scope

Explicitly deferred to follow-on epics:

- Relocating the SQLite state DB (machine-local state and worktrees stay where they are — already gitignored, not committed).
- The full workspace manifest beyond the single loom-home location setting.
- The three-layer config hierarchy (team vs. per-repo vs. env).
- Any cross-repo read or execution.
- A migration command for already-committed artifacts.
- Mission Control and fleet.
- loom's own dogfood cutover to a loom-home — `[ASSUMPTION]` a one-time manual step taken after this lands and is adopted, leaving existing `.loom_outputs/` in loom's history untouched.
