# Remove BMAD Scaffolding — Loom Prunes Its Own Vendored Skills

## Overview

Loom's repository carries ~44 vendored `bmad-*` skills in each of two IDE-command directories (`.agents/skills/` and `.claude/skills/`), a holdover from when loom planned via a third-party (BMAD) workflow. Loom now plans and builds itself with its own personas (`packages/loom-core/personas/`) and five ported, loom-native review/verify skills under `skills/`; the autonomous worker pipeline never loads the IDE-command directories. This epic dogfoods loom to prune its own scaffolding: delete every `bmad-*` directory from both IDE-command folders, preserve all `loom-*` commands and loom-native skills/personas, reconcile the `docs/` tree so nothing references a removed skill, and ship one clean PR with no source or behavior changes to loom-core/cli/mcp/web.

## Goals

1. **Leaner, legible skill surface** — `.agents/skills/` and `.claude/skills/` contain only `loom-*` entries; zero `bmad-*` directories remain in either folder.
2. **Docs consistency** — `git grep -i bmad` over `docs/` returns nothing that references a removed skill.
3. **No regression in autonomous capability** — `npm run build` and `npm run test` are green across all workspace packages; no test references a removed bmad skill.
4. **Documented decision** — one clean PR whose body explains the 5-of-44 ported rationale and confirms the removal drops manual IDE commands, not autonomous capability.

## User Stories

- **Must** — As a loom maintainer, I want the vendored `bmad-*` directories gone so the repo's skill surface is unambiguously loom-native and lighter to maintain.
- **Must** — As a new contributor or evaluator, I want docs that reference only skills that still exist, so loom's actual architecture is legible at a glance.
- **Should** — As a reviewer of the PR, I want the rationale (5 ported, ~39 removed manual IDE commands) stated explicitly, so the loss of IDE slash commands is a documented decision, not a surprise.

## Functional Requirements

- **FR-1** — Delete every `bmad-*` directory under `.agents/skills/` (~44).
- **FR-2** — Delete every `bmad-*` directory under `.claude/skills/` (~44).
- **FR-3** — Preserve every `loom-*` slash command in both directories (`loom-approve`, `loom-epic`, `loom-status`, `loom-ux-designer`, and any others); make no change under `skills/` or `packages/loom-core/personas/`.
- **FR-4** — Grep the `docs/` tree for `bmad` and update every hit so no document references a removed skill. Known references include `docs/architecture/index.md`, `docs/reviews/epic-2-review.md`, `docs/testing/runbook.md`, `docs/operations/bootstrap.md`, `docs/research/live-agent-guidance.md`, and `docs/capabilities.md`.
- **FR-5** — In `docs/capabilities.md`, remove rows for vendored BMAD skills and make no other edits to that page.
- **FR-6** — Run a repo-wide `git grep -i bmad` (beyond `docs/`) and update any `loom-*` command, code comment, README, config, or CI reference that names a removed skill; deletion of a directory alone is insufficient if a `loom-*` internal still references it.
- **FR-7** — Confirm via grep across the test tree that no test, fixture, or snapshot references a removed bmad skill; do not rely on a green run alone.
- **FR-8** — Deliver as a single PR whose body states that only 5 of ~44 skills were ported (the review/verify skills) and that the removed ~39 were operator-facing IDE slash commands never used by loom's autonomous pipeline.

## Epics

- **epic-001 — Remove BMAD scaffolding and reconcile docs.** One cohesive deletion-plus-docs change; the brief describes a single shipping unit (one clean PR).

## Out of Scope

- Any source or behavior change to loom-core, loom-cli, loom-mcp, or loom-web.
- Removing or altering `packages/loom-core/personas/` or the five ported `skills/` (adversarial-review, edge-case-hunter, failure-investigator, lesson-extractor, doc-distiller).
- Porting any additional bmad skills — the decision stands that 5 ported skills are enough.
- Splitting the work across multiple PRs.
