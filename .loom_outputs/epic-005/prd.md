# Honest Status Lifecycle and Observability — PRD

## Overview

Loom's status surfaces (`loom run`, `loom status`, `loom_get_status`, `loom_start_epic`) lie by omission at exactly the moments an operator relies on them. The flagship case: `EpicStatusSchema` has no state between `in_progress` and `done`, so during the multi-minute finalization tail (`EpicFinalizer.finalize()`: merge → gate → cleanup → push → PR body → `gh pr create`) the operator already sees `✅ done` while no PR exists. Five further defects compound this: the epic PR URL is captured but never persisted, the already-stored planning phase is hidden behind an opaque `(planning…)`, the MCP planning entry point blocks instead of returning a handle, infra crashes masquerade as human rejections, and worker completion copy makes unconditional claims about a dependency graph it never inspected. This PRD makes every status surface tell the truth — by mirroring the existing `planning`/`planning_phase` pattern for finalization, recording the epic PR URL where the surfaces read it, and correcting the failure taxonomy and payload shapes — without touching gate or retry mechanics.

## Goals

1. **No false "done."** During a live finalize, `loom status` shows `finalizing` with its current phase and never renders `done` without a recorded PR URL. *Metric: in a live finalize run, zero observed `done` readings precede a recorded PR URL.*
2. **PR URL of record everywhere.** `loom run` ends with the epic PR URL; `loom status` and `loom_get_status` render it. *Metric: 100% of successful PR-producing runs surface the epic PR URL on all three surfaces (no "run `loom status` for PR links" fallback).*
3. **Truthful taxonomy and payloads.** An infra-killed planning run lands as `failed` (not `rejected`) with the error retrievable; `loom_get_status` defaults to current-project scope with one row per story. *Metric: an infra-killed run reports `failed` with a non-empty error; no duplicate `blocked`+`done` rows on any path including CLI `--json`.*
4. **Accurate progress and completion copy.** Planning shows the current phase; terminal-story completion copy names no nonexistent downstream stories. *Metric: planning status reflects the active phase (`brief`/`prd`/`architecture`/`epic yaml`/`QA`); zero terminal stories emit "downstream stories may proceed" copy.*

## User Stories

- **(Must)** As the loom operator, I want `loom status` to show a distinct `finalizing` state with its phase, so that I don't conclude a run finished and go hunting for a PR that doesn't exist yet.
- **(Must)** As the loom operator, I want `loom run` to end with the epic PR URL, so that I can go straight to the review without a second command.
- **(Must)** As the loom operator, I want an infra-killed planning run to read `failed` with the error retrievable, so that I can tell a crash apart from a human rejection.
- **(Should)** As the loom operator, I want planning status to show which persona is running, so that a long planning phase isn't an opaque `(planning…)`.
- **(Should)** As an MCP caller (Claude Code / Cursor), I want `loom_start_epic` to return the epic id within seconds and be re-attachable via the status tools, so that I'm not blocked through planning.
- **(Should)** As an automation polling `loom_get_status`, I want current-project scope by default with opt-in federation, so that I get one clean row per story and don't accidentally pull fleet-wide state.
- **(Could)** As the loom operator, I want terminal-story completion copy to reflect the story's real DAG position and whether it changed code, so that the copy never invents downstream work.

## Functional Requirements

- **FR-1 — Finalizing lifecycle (#17).** Add a `finalizing` epic status and a `finalize_phase` field (`merging → gate → review → pushing → opening_pr`), driven from `EpicFinalizer.finalize()` as a thin status overlay around the existing steps. Status flips to `done` only once the epic PR URL is recorded. Non-PR exit paths (`skipped`, `gated`, `partial`, push-gate `confirm`, no-remote, remote-not-allowed) land in defined terminal statuses without stranding a legitimately PR-less successful run.
- **FR-2 — Epic PR URL of record (#15).** Persist the epic PR URL (dedicated storage, not the story-level `pr_url`). `loom run` prints it at run end; `loom status` and `loom_get_status` render it.
- **FR-3 — Planning-phase visibility (#8).** Surface the already-stored `planning_phase` (`brief → prd → architecture → epic yaml → QA`) in the `loom status` table and the MCP status payload, replacing the opaque `(planning…)`.
- **FR-4 — Re-attachable MCP planning entry point (#7).** `loom_start_epic` returns the epic id within seconds while planning continues in-process; the run is re-attachable via the existing status tools. The in-process-continuation behavior is documented explicitly. `[ASSUMPTION]` Per the brief, returning the epic id early is the minimum acceptable bar for V1; full async start is a follow-on.
- **FR-5 — Truthful failure taxonomy (#9).** Add a `failed` epic status distinct from `rejected` (human declined). A planning run killed by infra (e.g. invalid-model exit) lands as `failed` with the error message recorded and retrievable. Placeholder `(planning…)` titles are backfilled with the real title once known. `[ASSUMPTION]` `failed` is DB-only; the plan-time `EpicYamlSchema.status` enum is not extended (infra failure is a runtime fact, not a plan-time one).
- **FR-6 — Payload hygiene (#10, #11).** Verify the v0.5.0 retry-row collapse (`listLatestByEpic` + `history` array) holds on every path, including CLI `--json`, closing any remaining duplicate-row leaks. Default `loom_get_status` to the current project; make cross-project federation opt-in via an explicit parameter.
- **FR-7 — DAG-accurate completion copy (#16).** Worker completion copy reflects the story's real position in the dependency graph (terminal vs. has-dependents) and whether it changed code (via `commitCount`), replacing the unconditional "downstream stories may proceed with handoff context."
- **FR-8 — Schema migration.** Schema deltas (`finalize_phase`, epic PR URL, and any `failed`/error storage) land as additive `ALTER TABLE` migrations in `packages/loom-core/src/state/` with a `SCHEMA_VERSION` bump (v14 → v15).
- **FR-9 — Capabilities doc + tests.** `docs/capabilities.md` rows for `loom status`, `loom_get_status`, and the epic-lifecycle description are updated, owned by a single story. Each touched module has a co-located `__tests__/` test.

## Epics

This PRD is **one epic**: a cohesive observability/lifecycle correction across a shared set of status surfaces and one schema migration. It is not separable into independently shippable units — the `finalizing` lifecycle, the PR URL of record, and the payload corrections are mutually reinforcing and share the v15 migration. It deliberately excludes step-ordering and retry/backoff, which the concurrent "resilient story execution" epic owns.

- **epic-001 — Honest Status Lifecycle and Observability**

## Out of Scope

- Any `loom web` dashboard work (anti-persona).
- New notification channels.
- Changes to integration-gate semantics or retry/backoff mechanics (owned by the sibling "resilient story execution" epic).
- Renaming existing statuses beyond adding `finalizing` and `failed`.
- Step-ordering changes in `EpicFinalizer.ts` (`promoteArtifacts` call-site moves) — owned by the sibling epic; this epic's finalizer edits are confined to status transitions + PR URL recording.
- Full async/handle-based `loom_start_epic` (follow-on; V1 returns the epic id early in-process).

---

Now performing Headless task B: the epic/story breakdown. This is a multi-service epic (touches `loom-core` types/state, `loom-cli`, `loom-mcp`, and `docs`), so it gets a final cross-cutting verification story.

```json
{
  "epics": [
    {
      "epic_id": "epic-001",
      "title": "Honest Status Lifecycle and Observability",
      "priority": "must-have",
      "prd_ref": ".loom/planning/prd.md",
      "requirements": ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6", "FR-7", "FR-8", "FR-9"],
      "stories": [
        {
          "id": "story-001-001",
          "title": "Schema migration v15: finalize_phase, epic PR URL, and epic error",
          "description": "Add additive columns to the epics table for finalize_phase, the epic PR URL of record, and a runtime error message, via an ALTER TABLE migration in packages/loom-core/src/state/ with a SCHEMA_VERSION bump from v14 to v15. Extend EpicStatusSchema with finalizing and failed, and add the finalize_phase value type, in types.ts.",
          "acceptance_criteria": [
            "SCHEMA_VERSION is bumped to v15 in Database.ts and the migration runs additively on an existing v14 DB without data loss",
            "epics table gains columns for finalize_phase, epic PR URL, and a runtime error message",
            "EpicStatusSchema includes finalizing and failed; a finalize_phase type (merging|gate|review|pushing|opening_pr) is defined in types.ts",
            "EpicYamlSchema.status is left unchanged (failed is DB-only)",
            "A co-located __tests__/ test asserts the v14→v15 migration applies and the new zod statuses parse"
          ],
          "estimated_complexity": "medium",
          "dependencies": []
        },
        {
          "id": "story-001-002",
          "title": "Finalizing lifecycle and PR-URL recording in EpicFinalizer",
          "description": "Drive the finalizing status and finalize_phase transitions (merging → gate → review → pushing → opening_pr) from EpicFinalizer.finalize() as a thin status overlay around existing steps, and persist the captured prUrl on the epic. Flip to done only once the PR URL is recorded; map each non-PR early-return path (skipped, gated, partial, push-gate confirm, no-remote, remote-not-allowed) to a defined terminal status without stranding a PR-less successful run.",
          "acceptance_criteria": [
            "finalize() writes finalizing + the corresponding finalize_phase around each step without moving the existing step logic",
            "The epic status becomes done only after the epic PR URL is persisted",
            "The captured prUrl is persisted to the new epic PR-URL storage",
            "Every early-return path lands in a documented terminal status and no successful PR-less path is left stranded",
            "A co-located __tests__/ test covers the phase transitions and the done-requires-PR-URL invariant"
          ],
          "estimated_complexity": "large",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-003",
          "title": "Surface finalizing, finalize_phase, planning_phase, and PR URL across CLI + MCP",
          "description": "Render the new finalizing status with its phase, the already-stored planning_phase, and the epic PR URL across loom status and loom_get_status. Make loom run print the epic PR URL at run end instead of the 'run loom status for PR links' fallback.",
          "acceptance_criteria": [
            "loom status shows finalizing with the current finalize_phase, and shows the active planning_phase instead of (planning…)",
            "loom_get_status payload includes finalize_phase, planning_phase, and the epic PR URL",
            "loom run output ends with the epic PR URL for PR-producing runs",
            "A co-located __tests__/ test asserts the rendered/serialized fields for finalizing, planning, and PR URL"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-002"]
        },
        {
          "id": "story-001-004",
          "title": "Truthful failure taxonomy and re-attachable loom_start_epic",
          "description": "Record an infra-killed planning run as failed (distinct from human rejected) with the error message retrievable, and backfill placeholder (planning…) titles with the real title once known. Make loom_start_epic return the epic id within seconds while planning continues in-process, re-attachable via the existing status tools, with the behavior documented.",
          "acceptance_criteria": [
            "An infra-killed planning run lands as failed with a non-empty, retrievable error message — not rejected",
            "Placeholder (planning…) titles are replaced with the real title once it is known",
            "loom_start_epic returns the epic id within seconds and the run is re-attachable via loom_get_status / loom status",
            "The in-process-continuation behavior of loom_start_epic is documented",
            "A co-located __tests__/ test covers the failed-vs-rejected distinction and early epic-id return"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-005",
          "title": "Payload hygiene: current-project default, opt-in federation, retry-row collapse, DAG completion copy",
          "description": "Default loom_get_status to the current project and make cross-project federation opt-in via an explicit parameter. Verify the listLatestByEpic + history retry-row collapse holds on every path including CLI --json and close any duplicate-row leak. Replace BaseCliWorker's unconditional completion copy with DAG-accurate copy reflecting terminal-vs-has-dependents and whether the story changed code (commitCount).",
          "acceptance_criteria": [
            "loom_get_status defaults to current-project scope; federation requires an explicit parameter",
            "No duplicate blocked+done rows appear on any path, including CLI --json (one row per story with a history array)",
            "Terminal-story completion copy names no nonexistent downstream stories and reflects whether the story changed code",
            "A co-located __tests__/ test covers default scoping, no-duplicate-rows, and the completion-copy variants"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-006",
          "title": "Update docs/capabilities.md for the lifecycle and status changes",
          "description": "Revise the existing docs/capabilities.md rows for loom status (line ~90) and loom_get_status (line ~91) and the epic-lifecycle description to reflect finalizing/failed statuses, finalize_phase and planning_phase visibility, the epic PR URL of record, and the current-project-default scoping. Single owner for this file in the epic.",
          "acceptance_criteria": [
            "The loom status and loom_get_status rows describe finalizing, failed, finalize_phase, planning_phase, and the epic PR URL",
            "The epic-lifecycle description reflects the finalizing→done (PR-URL-gated) transition and failed-vs-rejected taxonomy",
            "The loom_get_status row documents current-project-default scope with opt-in federation",
            "docs/capabilities.md is the only place this epic edits that file (single-owner)"
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-003", "story-001-004", "story-001-005"]
        },
        {
          "id": "story-001-007",
          "title": "Full build + test suite and fix cross-cutting regressions",
          "description": "Run the full build and the entire test suite across all workspace packages and fix any cross-service regressions introduced by the lifecycle, schema, CLI, MCP, and worker changes.",
          "acceptance_criteria": [
            "The full build passes",
            "The entire test suite passes",
            "Any cross-cutting regression surfaced by the whole-suite run is fixed"
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-002", "story-001-003", "story-001-004", "story-001-005", "story-001-006"]
        }
      ]
    }
  ]
}
```
