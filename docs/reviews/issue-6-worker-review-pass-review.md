---
title: "Issue #6 — Staff Engineer Review (worker review pass + loom review CLI)"
reviewer: Claude (Opus 4.7)
date: 2026-05-23
status: reviewed
scope: "story-018-002 (worker-side review pass with off / comment / block-and-revise) and story-018-004 (loom review CLI + dashboard surfacing)."
---

# Issue #6 Review — Worker Review Pass + `loom review`

The Epic 18 foundation shipped `CodeReviewAgent` as a tested building block
with no production caller. This change makes it live: workers run a review
pass on their diff after committing and before opening a PR; reviews surface
in agent state, audit log, PR comments, and the MCP status response; and a
new `loom review <story|branch>` CLI re-runs the review on demand.

## What shipped

### story-018-002 — worker review pass

- **`policy.agents.review_strategy: 'off' | 'comment' | 'block-and-revise'`**
  + `review_max_revisions` (default 2). Wired through both the `loom run`
  path and the MCP `loom_approve_plan` path via `workerFactory`.
- **`BaseCliWorker.run` now has a review step.** After commits exist, before
  PR open:
  - `'off'`: skipped entirely, `review.status = 'skipped'`.
  - `'comment'`: review runs; on findings, render PR-comment body and
    attach via `gh pr comment` after PR creation.
  - `'block-and-revise'`: re-prompt the worker (via `buildWorkerPrompt(...,
    revisionContext)`) up to `maxReviewRevisions` times if blockers persist.
- **`WorkerResult.review`** carries the outcome out of the worker. Supervisor
  persists `review_status` / `review_summary` to `agents` and writes an audit
  row (`action: 'code_review_pass'`) per pass.
- **Schema v9**: `agents.review_status` + `agents.review_summary` columns
  added; existing DBs migrate via the additive `ALTER TABLE` pattern.

### story-018-004 — loom review CLI + dashboard surfacing

- **`loom review <target>`** CLI subcommand. Target is either a story id
  (`story-NNN-MMM`) — looked up in `agents` for branch/worktree — or a
  branch name (ad-hoc review of a hand-authored branch). Optional
  `--severity blocker,should-fix` filter for output. When target is a
  story, updates `agents.review_status` and writes an audit row (with
  `manual: true` in detail).
- **`loom_get_status` MCP response** now includes `review_status` and
  `review_summary` per story when set. Pi's dashboard reads these via the
  existing MCP polling; no pi-side code is required to surface the badge.
- **`StatusTree` typed shape** updated so MCP consumers get the new fields.

## Findings

### Medium

**1. PR-comment attachment is best-effort.** If `gh pr comment` fails after
`gh pr create` succeeded, the PR exists without the review attached. The
worker swallows the failure rather than rolling back the PR or marking the
agent failed — that's the correct trade-off (the review is also visible in
the audit log and via `loom review --severity ...`), but operators may
expect the comment to always show up. Acceptable for v1; consider logging
"review attached" / "review attachment failed" in the worker summary later.

**2. Block-and-revise re-prompts use the SAME story prompt with a revision
appendix.** A fresh worker spawn re-reads the original story spec, then
sees the review findings appended. There is no incremental "you previously
did X; now fix Y" framing — the worker sees the diff context only through
git, not through the prompt. Acceptable: the spawned agent will read the
worktree state itself, and forcing the worker to fix things on the same
branch (not start over) is the contract enforced by the prompt suffix.

**3. The CodeReviewAgent feeds the full unified diff regardless of size.**
Foundation review (Issue #6 ancestor) called this out; still true. A 5k-line
diff will overflow context. Mitigation: the worker review runs against ONE
story's commits, which are typically scoped, so the practical risk is
small. Long-term: diff chunking belongs in Epic 16 (cost governance).

**4. `loom review <branch>` for a hand-authored branch has limited story
context.** When the target is a bare branch name (not a story id), the
agent gets a placeholder description and no acceptance criteria. The review
still works (it sees the diff), but quality is lower than the worker path
where the story spec drives the review focus. Acceptable: this command's
primary use is auditing loom-generated branches, where the story-id path
gives full context.

### Low

**5. `setReview` writes a row even for the manual `loom review` path.**
This is deliberate so a user-triggered review updates the dashboard, but
it means a flaky manual run could change the persisted review status. Not
a regression — if you ran `loom review`, you wanted to record the outcome.

**6. The block-and-revise loop counts revisions, not LLM cost.** A team
with `maxReviewRevisions = 5` and unresolved blockers will pay for five
worker re-runs. Surfaced as a `revisions` count in the audit row + status;
will fold into the cost dashboard (Issue #5 / Epic 16).

### Out of scope

- Per-finding accept/dismiss tracking — that's Issue #7 / Epic 19 (review
  skill learning), which builds on this.
- LLM cost surfacing for the review pass — Issue #5 / Epic 16.
- Diff chunking for large epics — Issue #5 / Epic 16.

## Tests

- `WorkerReview.test.ts` (new): 5 cases exercising every branch of
  `runReviewPass` against a stubbed BaseCliWorker subclass with a real git
  worktree (no real CLI spawn).
- `Supervisor.test.ts` (extended): 2 cases verifying the Supervisor
  persists `review_status` / `review_summary` to `agents` and writes a
  `code_review_pass` audit row when the worker returns a review; no audit
  row when the worker returns `review=undefined`.

317 tests across the four packages pass.

## Files changed

- `packages/loom-core/src/state/Database.ts` (schema v9 + migration)
- `packages/loom-core/src/state/AgentStore.ts` (setReview)
- `packages/loom-core/src/types.ts` (AgentRecord + StatusTree + policy fields)
- `packages/loom-core/src/orchestrator/BaseCliWorker.ts` (review pass + helpers)
- `packages/loom-core/src/orchestrator/WorkerRunner.ts` (ReviewOutcome type)
- `packages/loom-core/src/orchestrator/workerFactory.ts` (review wiring)
- `packages/loom-core/src/orchestrator/workerPrompt.ts` (revisionContext)
- `packages/loom-core/src/orchestrator/Supervisor.ts` (persist + audit)
- `packages/loom-cli/src/commands/run.ts` (CodeReviewAgent construction)
- `packages/loom-cli/src/commands/review.ts` (new — loom review CLI)
- `packages/loom-cli/src/commands/init.ts` (yaml template)
- `packages/loom-cli/src/index.ts` (subcommand registration)
- `packages/loom-mcp/src/tools/handlers.ts` (review wiring + status fields)
- `packages/loom-core/src/__tests__/WorkerReview.test.ts` (new)
- `packages/loom-core/src/__tests__/Supervisor.test.ts` (extended)
