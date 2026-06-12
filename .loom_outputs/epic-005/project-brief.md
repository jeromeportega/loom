# Honest Status Lifecycle and Observability

## The Problem

Loom's status surfaces lie by omission at exactly the moments an operator depends on them. The defects are documented in an earlier epic-011 field report (items 7, 8, 9, 10, 11, 15, 16, 17) and reproduced verbatim in loom's own v0.6.0 dogfood run, so they are corroborated across two independent runs.

The flagship defect (#17): `EpicStatusSchema` has no state between `in_progress` and `done` (`packages/loom-core/src/types.ts:21`). During the multi-minute finalization tail that `EpicFinalizer.finalize()` walks — merge story branches → integration gate → cleanup → push → generate PR body → `gh pr create` (`EpicFinalizer.ts:226`–`630`) — `loom status` already renders `✅ done` with a green gate while `gh pr list` is still empty. The operator reads "done," concludes the run finished, and goes looking for a PR that does not exist yet. The same ordering bug produces #15: the finalizer captures `prUrl` (`EpicFinalizer.ts:593`) but never persists it on the epic, so `loom run` ends with `Run \`loom status\` for per-story detail and PR links.` (`packages/loom-cli/src/commands/run.ts:469`) while `loom status` only carries story-level `pr_url`, which is empty under the per-epic PR strategy.

Beyond the lifecycle gap, the status payloads misreport in three further ways: long operations show no progress, infra crashes are indistinguishable from human rejections, and completion copy makes claims about a DAG it never inspected. Each is a place where an operator acts on false information.

## Target Users

- **Primary — the loom operator** running `loom run` / `loom status` (CLI) or `loom_get_status` / `loom_start_epic` (MCP, from Claude Code or Cursor) and deciding, from those surfaces alone, whether a run is finished, stuck, or failed.
- **Secondary — the reviewer / downstream consumer** who follows the run-end PR URL to review the epic, and any automation polling `loom_get_status` to track fleet state.
- **Anti-persona — the web-dashboard user.** `loom web` is explicitly out of scope here (see Non-Goals); changes that only improve the dashboard do not satisfy this brief.

## Proposed Solution

Make every status surface tell the truth at the moments that matter, by mirroring the existing `planning` / `planning_phase` pattern (`types.ts:27`, `EpicStore.beginPlanning`/`updatePlanningPhase`) for finalization, recording the epic PR URL where the surfaces can read it, surfacing already-stored phase data, and correcting the taxonomy and payload shapes so a status is never ambiguous or fabricated. No status renames beyond the two additions; no changes to gate or retry mechanics.

## Key Capabilities

1. **Finalizing lifecycle (#17).** Add a `finalizing` epic status plus a `finalize_phase` field (`merging → gate → review → pushing → opening_pr`), driven from `EpicFinalizer.finalize()`. Flip to `done` only once the PR URL is recorded.
2. **Epic PR URL of record (#15).** Persist the epic PR URL (new `epics` column or status-payload field); `loom run` prints it at run end; `loom status` and `loom_get_status` render it.
3. **Planning-phase visibility (#8).** Surface the already-stored `planning_phase` (`brief → prd → architecture → epic yaml → QA`) in the `loom status` table and the MCP status payload, instead of an opaque `(planning…)`.
4. **Re-attachable MCP planning entry point (#7).** `loom_start_epic` returns a handle immediately — async-start-and-poll via the existing status tools, or at minimum return the epic id within seconds while planning continues in-process, strictly documented.
5. **Truthful failure taxonomy (#9).** A planning run killed by infra (e.g. invalid-model exit) lands as a distinct `failed` status with the error recorded and retrievable — not `rejected` (which today means a human declined). Backfill placeholder `(planning…)` titles once the real title is known.
6. **Payload hygiene (#10, #11).** Confirm the v0.5.0 retry-row collapse (`listLatestByEpic` + `history` array) holds on every path including CLI `--json`, closing any remaining duplicate-row leaks. Default `loom_get_status` to the current project; make cross-project federation opt-in via an explicit parameter (today it federates by default — `handlers.ts:280`).
7. **DAG-accurate completion copy (#16).** Worker completion copy must reflect the story's real position in the dependency graph (terminal vs has-dependents) and whether it changed code — replacing the unconditional `downstream stories may proceed with handoff context` (`BaseCliWorker.ts:378`).

## Constraints

- **Tech stack:** TypeScript / Node 20+; `zod` schemas in `types.ts`; `better-sqlite3` state.
- **Schema changes go through migrations** in `packages/loom-core/src/state/` — the additive `ALTER TABLE` + `SCHEMA_VERSION` bump pattern in `Database.ts` (currently v14). A new epic column means v15.
- **Tests live in `__tests__/`** next to each touched module (house rule + repo invariant).
- **`docs/capabilities.md` must be updated** for `loom status`, `loom_get_status`, and the epic-lifecycle description in the same PR (workspace rule; the rows at lines 90–91 are already present and must be revised).
- **Coordination with the concurrent "resilient story execution" epic.** That sibling also edits `EpicFinalizer.ts` (reordering artifact promotion relative to the gate — note `promoteArtifacts` is called in two places today, `EpicFinalizer.ts:431` and `:455`) and the Supervisor (retry/backoff). This epic's finalizer changes are confined to **status transitions + PR URL recording**; the sibling owns **step ordering**, so the diffs compose. Both epics touch `docs/capabilities.md` — **assign one owner story for that file in this epic.**

## Risks and Open Questions

- **`EpicFinalizer.ts` is a shared edit surface with the sibling epic.** Even with the status-vs-ordering split, both touch `promoteArtifacts` call sites and the `FinalizeResult` flow. `[ASSUMPTION]` the architect should define the `finalize_phase` write points as a thin overlay (status writes around the existing steps) so they don't move when the sibling reorders. Confirm with the sibling's owner.
- **`finalize_phase` storage shape is undecided.** The brief allows "new column or status payload field." `[ASSUMPTION]` a dedicated `finalize_phase` column on `epics` (mirroring `planning_phase`) is the lowest-surprise choice; the PR URL likely warrants its own column rather than overloading the story-level `pr_url`.
- **`finalize_phase` for non-PR exit paths.** `finalize()` has many early returns — `skipped` (per-story / no stories), `gated` (block-mode flips back to `in_progress`), `partial`, push-gate `confirm`, no-remote, remote-not-allowed (`EpicFinalizer.ts:227`–`539`). Open question: which of these set `finalizing`, and what terminal status each lands in. The `done`-requires-PR-URL invariant must not strand a legitimately PR-less but successful run.
- **#7 async vs documented-blocking.** A true async handle is a larger change than returning the epic id early. `[ASSUMPTION]` returning the epic id within seconds while planning continues in-process is the minimum acceptable bar; full async start can be a follow-on. Needs the PM's call on which the PRD targets.
- **#9 `failed` and the EpicYaml plan-time enum.** The DB epic status is the source of truth, but `EpicYamlSchema.status` (`types.ts:445`) is a separate enum (`planned|approved|in_progress|done|rejected`). Open question: does plan-time YAML need `failed` too, or is it DB-only? `[ASSUMPTION]` DB-only — infra failure is a runtime fact, not a plan-time one.
- **#10 duplicate rows may already be closed.** v0.5.0's `history`-array collapse (capabilities.md:85) covers `loom_get_status`; the residual risk is CLI `--json` or any path not routed through `listLatestByEpic`. Verify before writing new collapsing logic.
- **#16 needs the DAG and a "changed code" signal at completion time.** Terminal-vs-has-dependents is derivable from the planner's `dependencies`; "changed code" maps to the existing `commitCount` (`BaseCliWorker.ts:353`). `[ASSUMPTION]` the worker has the story graph in scope at the completion-copy site; if not, it must be threaded in.

## Success Criteria

- During a live finalize, `loom status` shows `finalizing` with the current phase and **never** `done` without a recorded PR URL.
- `loom run` output ends with the epic PR URL (not "run `loom status` for PR links").
- `loom status` and `loom_get_status` render the epic PR URL.
- During planning, `loom status` shows the current phase rather than `(planning…)`.
- `loom_start_epic` returns a usable handle (epic id) within seconds; the run is re-attachable via the existing status tools.
- An infra-killed planning run lands as `failed` with the error message retrievable — not `rejected`; backfilled placeholder titles show the real title once known.
- `loom_get_status` defaults to current-project scope, with one row per story (no duplicate `blocked` + `done`); federation is reachable only via the explicit parameter.
- Terminal-story completion copy names no nonexistent downstream stories and reflects whether the story changed code.
- Schema deltas land as `state/` migrations with a `SCHEMA_VERSION` bump; each touched module has a co-located `__tests__/` test; `docs/capabilities.md` rows for `loom status`, `loom_get_status`, and the epic-lifecycle description are updated, owned by a single story.

## Non-Goals

No web-dashboard work; no new notification channels; no changes to integration-gate semantics or retry/backoff mechanics (the sibling "resilient story execution" epic owns those); no renaming of existing statuses beyond adding `finalizing` and `failed`.
