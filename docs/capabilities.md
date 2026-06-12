# What loom can do — current capabilities

A plain-language inventory of every user-visible feature loom ships
**today**. This is the page operators read to learn what's possible;
GitHub release notes are too granular and too retrospective to serve as
the single source of truth.

**Last updated:** 2026-06-11 (`v0.5.0`: observability + planning-quality + operational-defaults release, PLUS archive runs from PR #55. New transient `integrating` agent status surfaces the bounded integrator's progress; `loom_get_status` now collapses retry attempts to one row per story with a `history` array, sums worker `total_cost_usd` and `total_requests` per story / epic, and surfaces planner request counts; `loom_get_audit_log` accepts a `story_id` filter that spans every retry + rolling-integrator rows; `epic_policy_rebound` audit row fires when the EpicFinalizer re-reads late-bound policy fields (allowed_remotes, test_command, integration_gate, push_gate, pr_attribution) at finalize entry — a snapshot is also persisted on `epics.policy_snapshot` at approve; `policy.agents.shared_contract` default flipped to `on` to prevent sibling-story same-file conflicts; integration-gate auto-detection now scopes to the smallest changed-files directory in monorepos; new `policy.agents.review_timeout_minutes` lifts the silent reviewer cap; integrator max-attempts default bumped from 1→2; machine-wide global limiter defaults to per-supervisor `max_concurrent` when `~/.loom/config.json` is unset; `loom init` writes `.vscode/settings.json` excludes so the IDE stops indexing `.loom/worktrees/**` and `.loom/integration/**`; per-request usage (column `agents.request_count` + `epics.planner_request_count`) reports cursor-cli spend in the org's per-request billing unit. **Plus archive a run** — `loom archive`/`loom unarchive`, `loom_archive_epic`, `loom status --archived`, and an Archive button + "Show archived" toggle in `loom web` — hides finished/abandoned epics from the default views and supervisor selection without deleting them.). **Plus the honest status lifecycle (epic-005):** epics now report `finalizing` (with a live `finalize_phase`) and `failed` (an infra failure carrying an `error` message, distinct from a human `rejected`); `finalizing → done` is gated on the durably-recorded epic PR URL (`epic_pr_url`), so a `done` epic always has a PR of record and a PR-less success never masquerades as complete; `planning_phase`, `finalize_phase`, `epic_pr_url`, and `error` are surfaced across `loom status` and `loom_get_status`; and `loom_get_status` now scopes to the current project by default with `all_projects=true` opt-in federation. **Plus the operator-trust hardening (epic-007):** `loom approve` gains an opt-in `--run` that chains into the `loom run` dispatch path (approve on its own still only flips status to `approved`); cursor_model validation adds an alias→advisory tier that warns (never fails) when the configured id is a `-`-boundary prefix of a listed id; `loom doctor` gains `--cross-epic-gate` (optionally `--epics <a,b>`) alongside `--dry-run-gate`; and a reserved epic row gets a derived placeholder title at submission time so status shows what kicked off a job before planning finishes. Date here is the last meaningful
capability change, not the last typo fix. **When you add a feature,
update this page in the same PR** — see
[Maintenance rules](#maintenance-rules) at the bottom.

---

## At a glance

Loom takes a one-paragraph brief, plans it through three personas
(Analyst → PM → Architect), and dispatches parallel story agents that
work in isolated git worktrees. Every action is policy-gated and
audit-logged. You stay in control via two human touchpoints: the brief
and the plan approval.

Two interfaces over the same engine:

- **MCP (recommended)** — primary interface; drives loom from Claude
  Code, Cursor, or any MCP-aware client.
- **CLI** — authoritative implementation; useful for scripts and shell
  habit.

---

## Planning

| Capability | How to use | Notes |
|---|---|---|
| **Plan an epic from a brief** | `loom epic "<brief>"` / `loom_start_epic` | Three personas in sequence: Mary (Analyst) → John (PM) → Winston (Architect). Writes brief, PRD, architecture, epic.yaml to `epics/<id>/`. **Always runs the brief-quality gate first** — the bundled `loom-brief-builder` rubric scores the brief and refuses anything below `policy.agents.min_brief_quality_score` (default 6/10), returning the critique so you can tighten the prompt. Pass `--force` (CLI) or `force: true` (`loom_start_epic`) to override the gate for that one invocation — the refiner still runs and its critique is audit-logged (`brief_gate_forced`) before planning. The override is a per-invocation escape hatch, not a disable switch; only the threshold is tunable per repo. |
| **Read the produced artifacts** | `loom_get_planning_artifacts` | Returns brief / PRD / architecture / epic YAML bodies. Web UI renders them inline above the Approve button for `planned` epics. |
| **Approve a plan** | `loom approve <epic-id> [--run]` / `loom_approve_plan` | Releases the epic for execution. Approve on its own does **not** dispatch workers — it flips the epic to `approved` and prints `Next: run loom run <epic-id> to dispatch`. Pass the opt-in `--run` flag (explicit epic id required) to chain straight into the same `loom run` dispatch path after approving; bare `loom approve --run` with no id is a usage error. |
| **Reject a plan** | `loom reject <epic-id> --reason "..."` / `loom_reject_plan` | Optional reason is audit-logged. |

## Execution

| Capability | How to use | Notes |
|---|---|---|
| **Dispatch story workers** | `loom run [epic-ids...]` | Iterates dependency-ordered stories, opens a git worktree per story, spawns the worker (claude / cursor-agent), commits to a story branch. The EpicFinalizer merges story branches onto `epic/<id>` and opens one PR. |
| **Honest epic lifecycle** | Automatic | An epic moves `planning` → `planned` → `approved` → `in_progress` → `finalizing` → `done`, and the status loom reports never claims more than what shipped. While `planning`, the live `planning_phase` (analyst / pm / architect) is exposed; while `finalizing`, the live `finalize_phase` (`merging` → `gate` → `review` → `pushing` → `opening_pr`) is exposed. **`finalizing → done` is PR-URL-gated:** the EpicFinalizer never writes `done` itself — `done` is set only after the epic PR URL of record (`epic_pr_url`) is durably persisted, so the invariant `done ⇒ epic_pr_url != null` always holds. A successful merge that produces no PR (push-gate `confirm`, no remote, or a remote outside `allowed_remotes`) stays in a defined non-`done` terminal state rather than masquerading as complete. **`failed` vs `rejected` are distinct terminal states:** `failed` is an *infrastructure* failure — a planner crash, OOM, provider error, or a finalize error — and carries the failure `error` message; `rejected` is a *human* decision (`loom reject`). A crash is never recorded as a rejection. |
| **Checkpoint after every story** | `loom run --checkpoint story` | Pauses between stories; review before the next dispatches. |
| **Checkpoint after every epic** | `loom run --checkpoint epic` | Pauses between epics; review the bundled PR. **Default recommendation.** |
| **Stream live worker output** | `loom run --verbose` | stdout/stderr to the terminal. |
| **Halt a run gracefully** | `loom stop` / `loom_stop_epic` | In-flight stories finish; no new dispatch. Before raising the stop signal, every in-flight worktree gets a bounded WIP checkpoint commit (`wip: stop checkpoint [loom]`, `--no-verify`, capped per worker) so a worker about to be terminated leaves a resumable commit rather than discarding its edits. Resume with `loom run`. |
| **Kill a specific worker** | `loom_stop_agent <story-id>` | SIGTERM the worker for one story; the story is marked failed. |
| **Steer a worker in flight** | `loom guide <story-id> "<message>"` / `loom_guide_agent` | Appends operator guidance to `.loom/guidance/<story-id>.md`. Requires `policy.agents.operator_guidance=on`. |
| **Worker-side pull of operator guidance** | `loom_pull_guidance` (MCP) | Cursor-backend complement to `loom_guide_agent`. |
| **Per-story token budget** | `policy.agents.budget_tokens_per_story` | When the worker's cumulative tokens exceed the cap, the subprocess is SIGTERM'd and the story marked failed. Requires `claude-cli` backend. |
| **Progress-aware story timeouts** | `policy.agents.story_stall_minutes` (default 12), `story_absolute_cap_minutes` (default 60), `story_timeout_multipliers` (per `estimated_complexity`) | Replaces the old fixed 30-min wall-clock kill. A worker is killed after the stall window of zero output (resets on any stdout/stderr) OR the absolute cap regardless. Kills the worker's process group with SIGTERM→SIGKILL escalation. Before any timeout/budget kill, uncommitted work is checkpoint-committed (`wip: … [loom]`, `--no-verify`) so a kill becomes a resumable commit. The stall reset depends on the backend streaming stdout: the `cursor-cli` backend runs `cursor-agent --output-format stream-json --stream-partial-output`, so incremental assistant output keeps the stall timer alive the same way `claude-cli`'s stream-json does — set `story_stall_minutes` generously relative to `story_absolute_cap_minutes` so a genuinely-working cursor worker is never false-killed between events. |
| **Crash-resilient resume handoff** | `policy.agents.handoff` (`off` \| `telemetry` \| `summarized`, default `telemetry`) | On a failed/blocked story loom writes `.loom/handoff/<id>.md` from durable telemetry (git log + decision traces + audit). A non-clean retry injects it so the resumed worker continues instead of starting over. `telemetry` costs zero extra tokens. |
| **Retry a failed/blocked story** | `loom retry <story-id> [--clean]` / `loom_retry_story <story-id> [--clean]` (MCP) / Retry & Clean-retry buttons in `loom web` | Re-dispatches one story. Resume retry (default) keeps the prior branch + checkpoint and feeds the handoff back; clean retry tears down the worktree/branch **and the trees of every story stacked on it** and starts fresh. Lease-aware: a live run re-dispatches it, otherwise the command dispatches the epic itself. Grants a fresh auto-retry budget. Guards a running story or a live per-epic dispatch lease. |
| **Phased worker pipeline** | `policy.agents.phases` (`off` \| `on`, default `off`) | When `on`, a story runs as separate implement → verify spawns, each with its own fresh timer and a checkpoint + handoff refresh at the boundary, so a crash mid-verify resumes from the committed implement work. |
| **Auto-prune orphaned worktrees** | `policy.agents.prune_orphan_worktrees` (`off` \| `on`, default `on`) | At end of run, removes agent-less `.loom/worktrees/<id>` dirs. Failed/blocked trees are kept for resume retry; completed trees are left to the EpicFinalizer. |
| **Architect shared contract** | `policy.agents.shared_contract` (`off` \| `on`, **default `on`** as of v0.5.0) | When `on`, the Architect (Winston) emits an epic-wide implementation contract at plan time — the shared interfaces/types parallel stories must agree on plus a per-story file-ownership map — to `.loom/contract/<epic-id>.md`, and every worker prompt for the epic is prefixed with it so isolated parallel agents stop inventing conflicting seams and editing each other's files. Default flipped to `on` after the multi-epic shared-client run, where sibling stories appending to one client file caused rolling-merge conflicts on every multi-story epic; the file-ownership map removes the conflicts at the source. Costs one extra planning call per run; set `off` to opt back out. |
| **QA test planning** | `policy.agents.qa_planning` (`off` \| `advisory`, default `off`) | When `advisory`, a QA persona (Tessa) runs after the Architect at plan time and writes a concrete, risk-based `test_plan` onto every story — the test levels, the happy/error/edge cases to cover, and the verification bar. Each worker prompt then carries its story's plan so agents build tests-first against an explicit definition of "verified" instead of guessing. Costs one extra planning call per run; `off` keeps the worker prompt byte-identical to the bench baseline. |
| **Integration gate** | `policy.agents.integration_gate` (`off` \| `warn` \| `block`, default `warn`), `test_command` | After the EpicFinalizer merges every story branch onto `epic/<id>`, runs the build/test suite on the integrated tree before opening the PR — the objective check that the feature isn't broken once all stories live together. Also fails when a story was dropped by a merge conflict (amputation). `warn` annotates the PR + audits on failure but still opens it; `block` withholds the PR, leaves `epic/<id>` local, and flips the epic back to `in_progress`. When `test_command` is unset, the gate auto-detects (`npm test` / `make test` / `pytest`) — as of v0.5.0 the auto-detector scopes to the smallest directory containing every changed file (via `git diff --name-only origin/main...HEAD`) so monorepo runs don't pick up an over-broad repo-root command that fails at collection time. Loom never auto-installs deps. |
| **Rolling integration branch** | `policy.agents.integration_branch` (`off` \| `rolling`, default `off`) | When `rolling`, loom creates a live `epic/<id>` branch up front, branches every worker from its current tip, and merges each story back the moment it completes — so parallel agents build on real integrated code instead of colliding only at finalize. A story whose merge conflicts is blocked (its work kept on `story/<id>` with a handoff) rather than silently dropped, and the conflict cascades to its dependents. The finalizer then reconciles, runs the integration gate in the integration worktree, and opens one PR. Requires `pr_strategy=per-epic` (ignored with a warning otherwise); `off` is byte-identical to the bench baseline. |
| **Bounded integrator** | `policy.agents.integrator` (`off` \| `on`, default `off`) | When `on` (with `integration_branch=rolling`), a story whose merge-back conflicts is handed to a bounded agent that resolves the conflict markers in the integration worktree; loom then commits the merge and re-runs the integration gate. The story is integrated only on a **green** gate — otherwise the merge is rolled back and the story falls through to the loud-block path, so the conflict is never silently dropped. Each round is one agent spawn + a full gate run, feeding the prior failure into the next prompt (block-and-revise). The attempts cap (default 2 as of v0.5.0; was 1) is an engine constant — one extra round gives the integrator real room to self-heal a transient gate failure. Requires `integration_branch=rolling` (ignored with a warning otherwise). |
| **Cross-story context notes** | `policy.agents.context_notes` (`off` \| `on`, default `off`) | When `on`, loom writes a short "what I built" note to `.loom/context/<story-id>.md` when a story succeeds (and, under the rolling branch, integrates) — its outcome summary, the commits it added, the files it touched, and key decisions from the reasoning trace. Each dependent story's worker prompt is then appended with its dependencies' notes, so a worker builds on the upstream decisions and surface area in narrative form (complementing the rolling branch, which carries the code, and the shared contract, the plan-time interfaces). A pure telemetry render — zero extra LLM tokens; `off` keeps the worker prompt byte-identical to the bench baseline. |
| **Tear down an epic** | `loom revert <epic-id>` / `loom_revert_epic` | Deletes story branches + flips DB status to rejected. `--remote` also deletes the upstream epic branch and closes loom-opened PRs. |

## Review

| Capability | How to use | Notes |
|---|---|---|
| **Block-and-revise review** | `policy.agents.review_strategy=block-and-revise` | After commits, before the PR opens, a `CodeReviewAgent` reviews the diff. Blocker findings re-prompt the worker with the review in context (up to `maxReviewRevisions`). |
| **Comment-only review** | `policy.agents.review_strategy=comment` | Findings attach as a PR comment; no revisions. |
| **Cross-model review (opt-in)** | `policy.agents.review_model='cross' + review_model_id=<id>` | Routes the reviewer through a different model than the worker. |
| **Reviewer wall-clock cap** | `policy.agents.review_timeout_minutes` (1–60, default 10) | Bounds the reviewer's CLI subprocess. The legacy hardcoded 10-minute `ClaudeCliClient` timeout silently shipped large story diffs unreviewed (the operator saw `review_status=errored` only in the audit log); raising this lets the reviewer finish on sizable diffs. |
| **Graceful reviewer-crash degradation** | Automatic | A reviewer subprocess failure does NOT cascade-fail the worker. Story is marked done with `review_status=errored`; the PR opens without review findings. |
| **Fetch a story's review verdict** | `loom_get_review <story-id>` | Returns review_status + the reviewer's markdown summary. |

## Visibility

| Capability | How to use | Notes |
|---|---|---|
| **Web dashboard** | `loom web` | Local-only server (random token in URL fragment). List view, detail view with live worker stdout streams via SSE, inline approve/reject/stop/kill controls, plus Retry / Clean-retry buttons on failed or blocked stories. The per-story spend column shows whichever signal the backend reports: USD cost (claude-code), request counts (cursor-cli — previously rendered as a misleading `$0.000`), or both; `/api/cost` rolls up `worker_requests` + `planner_requests` per epic and in totals. |
| **Stall + worktree info in status** | Automatic | A running story whose worker is approaching/hitting a deadline is flagged with its stall reason (`stall`/`cap`/`budget`/`analysis-only`); `worktree_path` / `branch_name` are surfaced across `loom status`, `loom_get_status`, and the dashboard so you can see a worker about to be killed and `cd` into a failed story's tree. |
| **`integrating` status surfacing** | Automatic | A story whose worker finished but whose rolling-merge / bounded-integrator is still in flight shows as `status=integrating` in `loom_get_status`, with an `integrator: { attempt_number, elapsed_seconds }` block derived from the latest `epic_integration_attempt` audit row. The transient state replaces the prior `done` reading that hid 10+ minute integrator work from operators. |
| **Retry-collapsed status rendering** | Automatic | `loom_get_status` returns one row per story (the latest attempt) instead of one per agent — earlier attempts move to a per-story `history: [...]` array. A resolved-via-retry epic no longer shows stale `blocked` rows. |
| **Per-story / per-epic spend** | Automatic | `loom_get_status` sums `cost_usd` and `request_count` across every attempt of a story, surfaces `total_cost_usd` + `total_requests` per story and per epic, and emits `planner_request_count` separately so per-request-billed Cursor users have an actionable spend signal alongside the Claude `total_cost_usd` (which is the actual Anthropic-billed amount, not an estimate). |
| **Story-scoped audit log** | `loom_get_audit_log story_id=<id>` | Matches every retry attempt of a story (`agent_id LIKE 'agent-<storyId>-%'`) AND rolling-integrator rows keyed on `command=<storyId>`. Used to be impossible without first scraping the global log to learn the per-attempt agent hash. |
| **Late-bound policy re-read** | Automatic | At `EpicFinalizer.finalize()` entry, late-bound fields (`git.allowed_remotes`, `agents.test_command`, `integration_gate`, `push_gate`, `pr_attribution`) are re-read from `.loom/policy.yaml` so mid-run edits actually take effect — and an `epic_policy_rebound` audit row records exactly what changed. The full policy snapshot taken at `loom_approve_plan` is also persisted on `epics.policy_snapshot` for forensics. |
| **Planning-artifact review in the dashboard** | Open a `planned` epic in `loom web` | Brief / PRD / architecture / epic.yaml render inline above the Approve button. |
| **Status from CLI** | `loom status [--watch] [--epic <id>] [--all] [--archived]` | At-a-glance epic + story status. Renders the full honest lifecycle: a `finalizing` epic shows its live `finalize_phase` (`finalizing (gate)`, etc.) and a `planning` epic shows its `planning_phase` (`planning (architect)`, etc.); a `failed` epic prints its `error` message; the epic PR URL of record (`epic_pr_url`) is printed once a per-epic PR is opened. **Derived placeholder title at submission time:** the instant a brief is submitted, the reserved epic row is durably written with a placeholder title derived from the brief (its first Markdown heading, else the brief's first 60 characters) so `loom status` / `loom web` can show what kicked off a job before the ~5-minute Analyst → PM → Architect chain finishes; the planner's real title later replaces it through the existing completion seam. `--all` aggregates across every loom-init'ed repo on the machine. `--archived` also shows archived runs (hidden by default). |
| **Status from MCP** | `loom_get_status` | **Scopes to the current project by default** — the repo you invoke it from. Pass `all_projects=true` to federate across every registered project (the pre-v0.6 machine-wide default), or `project=<root>` to scope to one specific project (overrides `all_projects`). Surfaces the honest lifecycle inline: `finalize_phase` (only while `finalizing`), `planning_phase` (only while `planning`), `epic_pr_url` once recorded, and `error` when `failed`. Pass `include_archived=true` to surface archived runs (each carries `archived: true`). |
| **Archive a run** | `loom archive <epic-id>` / `loom_archive_epic` / Archive button in `loom web` | Hides a finished/abandoned run from the default `loom status`, web list, and `loom_get_status` views (and skips it in supervisor selection) so your working set stays scoped to what you still care about. Non-destructive — the epic, its agents, and its audit trail are preserved; pass `archived: false` (MCP) or run `loom unarchive <epic-id>` to restore. Audit-logged. |
| **Cross-repo web view** | `loom web` (any repo) | List view aggregates epics from every registered project, grouped by project name. |
| **Audit log** | `loom_get_audit_log <agent-id>` | Every command, every policy check, every status change — structured rows for incident review. |
| **Decision traces (worker reasoning)** | `loom_get_decision_traces <agent-id>` | Replayable worker reasoning captured to SQLite. |
| **Diff for a story** | `loom_get_diff <story-id>` | The worker's diff vs. base SHA. |
| **Project directory** | `loom_list_projects`, `loom_get_project` | Lists every loom-init'ed repo on the machine + their latest epic snapshot. |
| **"loom learned this run" CLI summary** | Automatic at end of `loom run` | When the self-learning loop generated, promoted, or demoted a skill during the run, the CLI prints a single block summarizing what changed. Silent when nothing changed. |
| **Skill provenance on canary injections** | Automatic in `loom run` output | A candidate skill injected into a story prints `(from story-X)` — the story that originally produced it. Closes the loop visibly between "loom wrote a skill" and "loom used it." |
| **Per-skill history timeline** | `loom skills history <name>` | Merges audit rows + injection records into one chronological timeline: `★` generated, `↻` lifecycle change, `·` injection with outcome. Track-record tail line. |

## Skills (curated library)

Loom ships a curated skill library that the Supervisor's `SkillSelector`
auto-injects into worker agents at story dispatch — they shape the
implementation without being commands a developer has to invoke.

| Skill | What it brings |
|---|---|
| `loom-brief-builder` | The brief quality gate's rubric |
| `loom-brainstorm` | Generating and pressure-testing options |
| `loom-plan-review` | Checking a plan or PRD for implementation-readiness |
| `loom-edge-case-review` | Adversarially hunting edge cases and failure modes |
| `loom-code-review` | Staff-engineer pass over a diff, worker-time |
| `loom-tech-writer` | For stories touching docs |
| `loom-ux-design` | UX-discipline lens for UI stories |
| `loom-ux-designer` | UX-designer persona for interactive use |
| `loom-pr-description` | Used by the EpicFinalizer's PR body writer |
| `loom-skill-curator` | Read by the chat client when shaping a brief |

### Review Forge skills (scaffolded — activation in a follow-up epic)

Five headless skills for the autonomous review/investigation loop. As of this
epic the **contract and scaffolding are in place and unit-tested** — a shared
`zod` findings schema, lexical (file, line, normalized-description) dedupe, the
deterministic failure router, the bounded review/revise orchestrator, and the
`skill_usage` + audit_log provenance seam (every `invokeSkill` writes both rows
before returning). **The skills do not yet perform live analysis:** their
runtime handlers are stubs (empty/placeholder output) and the three-reviewer
orchestrator is not yet wired into the worker review path. Implementing the
LLM-backed handlers and activating the wiring is a tracked follow-up epic; until
then the legacy single `CodeReviewAgent` remains the active reviewer.

| Skill | Intended role (on activation) | Status today |
|---|---|---|
| `adversarial-review` | Fan out alongside `edge-case-hunter` + the code-review adapter on every story diff in the block-and-revise loop. | Scaffolded + schema; stub handler, orchestrator not yet wired into the worker path. |
| `edge-case-hunter` | Same fan-out — boundary, concurrency, and failure-state findings the code-review pass misses. | Scaffolded + schema; stub handler, not yet wired. |
| `failure-investigator` | On a red gate, grade evidence so the deterministic router picks retry-with-hint / surface-to-operator / stop-epic. | Router wired + tested; grading handler is a stub (always grades `weak`) pending live analysis. |
| `doc-distiller` | Once per story at worker-context assembly — compress planning artifacts, preserving every acceptance criterion verbatim. | Seam invokes it + records provenance; stub output, not yet injected into the worker prompt. |
| `lesson-extractor` | Callable-only (provisional) — synthesize worked-well / did-not-work / surprise lessons from a story transcript for Epic D. | Callable + registered; stub handler. |

### Self-learning loop

| Capability | How to use | Notes |
|---|---|---|
| **Per-story skill extraction** | `policy.agents.skill_generation` (`on` \| `off` \| `sampled`) | After each successful story, an LLM proposes a reusable `SKILL.md`. `'on'` runs every story, `'sampled'` every Nth (see `skill_generation_sample_n`), `'off'` disables. |
| **Candidate quality gate** | `policy.agents.skill_judge_min_score` (0–10, default 6) | A second LLM scores each candidate; below threshold rejected silently. |
| **Canary lifecycle for candidates** | Automatic | Candidates are injected only as canaries (spare slots after active skills); promoted to `active` after `skill_promote_after` clean successes; demoted to `disabled` when `skill_demote_failure_ratio` crosses with at least `skill_demote_min_samples` samples. |
| **Auto-PR a high-scoring candidate** | `policy.agents.skill_auto_propose` (`off` \| `sampled` \| `always`) | Candidates scoring `>= skill_auto_propose_min_judge_score` (default 8) trigger a PR back to a source repo configured in `~/.loom/sources.yaml`. Capped per epic via `skill_auto_propose_max_per_epic`. |
| **agentskills.io spec conformance** | Automatic at generation time | Generated `SKILL.md` is validated against the open agentskills.io spec (name ≤ 64 chars + lowercase/hyphen regex, description ≤ 1024 chars, body soft cap ≤ 20000 chars) before being written. Keeps loom skills portable to other agentskills.io consumers (hermes-agent, Claude Skills, Codex Skills). |
| **Loom-internal metadata stripped pre-publish** | Automatic in `loom skills propose` | Provenance fields (`generated_from_story_id`, `generated_from_epic_id`) and lifecycle markers are scrubbed from the SKILL.md committed to the upstream skill repo. |

## Safety / guardrails

| Capability | How to use | Notes |
|---|---|---|
| **Policy engine** | `.loom/policy.yaml` | Per-repo configuration. Blocks force-push, `git reset --hard`, command chaining (`&&`, `;`, `$(...)`), backgrounding (trailing `&`, `a & b`), and forbidden file writes. Fd-duplication/redirection forms (`2>&1`, `>&2`, `&>file`, `>&-`, `<&`) are permitted, so a command like `npm test 2>&1` passes the metacharacter check while its bare `&` cousins stay blocked. |
| **Pre-tool-use hook** | Auto-installed by `loom init` | Claude Code's `PreToolUse` hook calls `loom guard hook` before any shell command. Blocked commands exit non-zero — the model cannot bypass by ignoring instructions. |
| **Policy check from MCP** | `loom_policy_check <command>` | Same logic, available as a tool. |
| **Worktree isolation** | Automatic | Every story runs in its own git worktree on its own branch. Agents physically cannot touch the main branch. |
| **PR-only landings** | `policy.git.agents_must_use_pr=true` (default) | Agents open PRs; a human reviews and merges. |
| **One PR per epic** | `policy.agents.pr_strategy=per-epic` | The EpicFinalizer merges story branches in dependency order onto `epic/<id>` and opens a single PR. |
| **Push-confirmation gate** | `policy.git.push_gate='confirm'` | The supervisor prompts the operator before pushing to any allowed remote. |
| **Allowed-remote allowlist** | `policy.git.allowed_remotes` | Glob patterns. Pushes to non-matching remotes are blocked. |
| **Audit log of everything** | Automatic | Every command (allowed or blocked) is logged with structured metadata to `.loom/loom.db`. |
| **Brief-quality gate** | `policy.agents.min_brief_quality_score` (1-10, default 6) | Every `loom epic` / `loom_start_epic` runs the BriefRefiner before the planner and refuses briefs scoring below the threshold. Controls planner cost and trains operators on what a planning-ready brief looks like. `loom epic --force` / `force: true` overrides the gate for a single invocation — the refiner still runs and its critique is audit-logged (`brief_gate_forced`) before planning. The override is a per-invocation escape hatch, not a disable switch; only the threshold is tunable per repo. |

## Evaluation (developer tools)

These are loom-team R&D tools, exposed via the separate `loom-bench`
binary and the `scripts/eval.mjs` repo script — not part of the
operator-facing `loom` CLI.

| Capability | How to use | Notes |
|---|---|---|
| **SWE-bench Lite bench** | `loom-bench swe-bench-lite` (or `scripts/bench/run.sh`) | Runs loom end-to-end against SWE-bench Lite tasks. Validated config in `scripts/bench/run.sh`. |
| **Failure-mode classification** | `loom-bench classify <run.json>` | Auto-tags failure modes from predictions + tempdirs. |
| **Cross-run comparison** | `loom-bench compare <a.json> <b.json>` | Held / gained / regressed / shifted breakdown across two runs. |
| **Outcome variance** | `loom-bench variance <K runs>` | Distribution across K runs of the same configuration. |
| **Planning eval** | `node scripts/eval.mjs` | Runs the bundled planning eval cases through the planner; pass/score report. |

## Integration & deployment

| Capability | How to use | Notes |
|---|---|---|
| **MCP server** | `loom serve` | Stdio MCP transport. 19 tools exposed. Auto-wired into `.mcp.json` and `.cursor/mcp.json` by `loom init`. |
| **Provision approved MCP servers for workers** | `loom mcp add <name>` / `policy.mcp.registry` | **Exclusive allowlist — this is a behavior change.** A worker now sees *exactly* the servers in `policy.mcp.registry` and nothing else: claude-code workers get the registry servers only (enforced structurally via `--strict-mcp-config --mcp-config <worktree>/.cursor/mcp.json`), and cursor-cli workers get the registry servers **plus** the `loom` server. **Operator-facing break: servers inherited from your personal `~/.cursor/mcp.json` no longer load in worker sessions.** A worker that used to rely on a globally-configured server will no longer see it — **migrate by registering it explicitly with `loom mcp add <name>`** so it lands in the worktree allowlist. cursor-cli enforcement is best-effort, not structural: `cursor-agent` has no `claude`-style strict flag, so loom enumerates the visible servers per worktree and headlessly disables every non-allowlisted one (per-project, durable, never touching your global config), recording any it cannot disable — plus the inherent setup→spawn race window — in the `worker_mcp_servers` audit row. That residual strictness gap and the out-of-scope upstream `--strict-mcp-config`-equivalent ask are documented in [`docs/research/cursor-mcp-strictness.md`](research/cursor-mcp-strictness.md). |
| **First-class Claude Code support** | Automatic via `.mcp.json` | Tools surface as `mcp__loom__*` in Claude Code. |
| **First-class Cursor support** | Automatic via `.cursor/mcp.json` | Same tools available to Cursor's chat / background agents. |
| **Prerequisites probe** | `loom doctor` | Checks Node version, git, claude CLI, gh CLI, cursor-agent CLI; warns if `loom` is not on PATH. When a `cursor-cli` backend is configured, also validates `agents.cursor_model` against `cursor-agent --list-models` — fails with the complete valid-model list on an invalid id, warns (never fails) when the probe can't run offline; the same check runs at the start of `loom epic` / `loom run` and exits before any LLM pass. **Alias→advisory tier:** when `cursor_model` is not an exact id but a `-`-boundary prefix of exactly one listed id (e.g. `claude-opus-4-8` for `claude-opus-4-8-high`), the check still passes but emits an *advisory* — a warning, never a failure — recommending you pin the explicit suffixed id; doctor renders it as a non-required Check and `loom epic` / `loom run` warn without exiting. Also runs an advisory integration-gate-command preflight: it resolves the command the gate would run (`policy.agents.test_command`, else auto-detected) and reports whether it's viable in a bare integration worktree — advisory only, it never flips doctor's exit code. `loom doctor --dry-run-gate` is the explicit opt-in that actually executes that gate command once in a throwaway worktree and prints the outcome; `loom doctor --cross-epic-gate` (optionally narrowed by `--epics <a,b>`) merges every open `epic/*` branch into a throwaway union worktree and runs the suite once, reporting per-pair conflicts or the union suite result without mutating any real branch; plain `loom doctor`, `loom epic`, and `loom run` never run either. |
| **Init in any repo** | `loom init [--cursor]` | Writes `.loom/policy.yaml`, the SQLite DB, the guard hook, and the MCP configs. As of v0.5.0 also writes/merges `.vscode/settings.json` excludes for `.loom/worktrees/**` and `.loom/integration/**` so Cursor/VS Code stops indexing every story worktree (the "too many active changes" warning during multi-epic runs). Registers the repo in `~/.loom/projects.json`. |

## Cost discipline

| Capability | Notes |
|---|---|
| **Session-based by default** | `claude-cli` / `cursor-cli` backends use the Claude / Cursor login the developer already has — **no metered tokens**. |
| **Tiered model routing** | Opus for planning, Sonnet for execution, Haiku for meta-work. Per-role in `.loom/policy.yaml`. |
| **Actual claude cost (not estimate)** | Automatic | `cost_usd` per agent is the actual API-billed amount harvested from `claude --output-format stream-json`'s `total_cost_usd` result field — sourced from Anthropic's metering, not a token-rate estimate. |
| **Per-request reporting for cursor-cli** | Automatic | Cursor's organizational pricing is per-request, not per-token. Loom records `request_count` per agent and `planner_request_count` per epic, and `loom_get_status` surfaces `total_requests` per story / epic. Each `complete()` call is attributed `1` request; the worker spawn parser harvests any `usage` / `request_count` / `total_cost_usd` fields cursor-agent exposes in its JSON output. |
| **Planning token tracking** | Per-epic input / output / cached / cache-creation tokens + wall-clock time recorded on the epic row. |
| **Planning token budget warning** | `policy.agents.planning_token_budget` — `loom epic` warns when a run blows the cap. |
| **Per-story worker budget enforcement** | `policy.agents.budget_tokens_per_story` — kills the worker when exceeded. |
| **Machine-wide concurrency cap** | `~/.loom/config.json` `max_global_workers`, with per-supervisor `policy.agents.max_concurrent` as the fallback (v0.5.0) | The global cap used to be opt-in; running N supervisors in parallel could collectively exhaust the developer's session capacity. The fallback now bounds the machine to whatever the current `max_concurrent` is so the default is safe without giving up the explicit-opt-out for tests. |

Per-agent token, cost, and request columns are written to `.loom/loom.db` —
`loom_get_status` rolls them up per-story and per-epic; query SQLite
directly if you need a different shape.

---

## What loom does NOT do (today)

Setting expectations honestly:

- **Cross-repo planning.** A single brief that coordinates work across
  multiple repos. Tracked at issue #16; foundational design only.
- **Federated team-wide run visibility.** Each laptop is still
  self-contained; the cloud-Postgres mirror (issue #19) is the
  foundation.
- **`brew install loom`.** The release pathway publishes to the npm
  registry, not Homebrew.
- **Bedrock backend.** The `LLMClient` interface is ready, but the
  Bedrock-specific request shape + IAM auth hasn't shipped.
- **Mid-spawn agent guidance on the `anthropic-api` backend.** Tracked
  as a follow-up.
- **`loom uninstall`.** Tracked as alpha-blocking A4 in the Jira slate.

---

## Maintenance rules

This page must stay current. **Update it in the same PR that ships the
feature.** Specifically:

- If a PR adds a new CLI subcommand → add a row to the relevant table.
- If a PR adds a new MCP tool → add a row noting both the CLI and the
  MCP form.
- If a PR adds a new policy knob that's user-visible → add a row.
- If a PR ships something previously listed under "What loom does NOT
  do" → move it into the appropriate capability table and delete its
  entry from the "does not do" list.
- If a PR removes a capability → delete its row.

The CLAUDE.md, the `.claude/skills/loom-*` skill files, and the
`.cursor/rules/loom.mdc` rule all carry a sentence pointing maintainers
at this page. GitHub release notes are still produced (the tag's body),
but they're a per-release event log; this page is the always-current
truth.

---

*Single source of truth for what loom does. Edit in
`docs/capabilities.md`. Linked from README, getting-started, MCP tool
listings, and CLAUDE.md.*
