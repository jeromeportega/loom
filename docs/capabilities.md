# What loom can do — current capabilities

A plain-language inventory of every user-visible feature loom ships
**today**. This is the page operators read to learn what's possible;
GitHub release notes are too granular and too retrospective to serve as
the single source of truth.

**Last updated:** 2026-06-13 (**CLI = usability, web = observability**: the CLI is loom's usability surface; `loom init` no longer writes an MCP config entry, and new inspection commands `loom diff / review / artifacts / traces / audit / autonomy / projects` provide full CLI parity (all support `--json`). `loom init` and `loom doctor` now (re)write `.loom/policy.example.yaml` and report policy knobs missing from your `policy.yaml`. `v0.7.0`: Signal Scout release, epic-004. Loom now continuously surfaces engineering opportunities: `loom scan` runs three signal scanners (audit-log failures, code-debt TODOs, GitHub issues) and a single batched LLM clustering call to produce a ranked opportunity board; `GET /api/opportunities` and the Opportunities tab in `loom web` expose the board with inline Scope and Dismiss actions. Scoping an opportunity (`POST /api/opportunities/:id/scope`) runs the brief-quality gate and Planner to create a `manual`-autonomy epic from the opportunity. Schema v17 adds `signals` and `opportunities` tables. `v0.6.0`: Fleet Commander release, epic-003. Per-epic autonomy modes (`full-auto` / `checkpoint` / `manual`) let the supervisor self-approve and self-dispatch without human intervention, or pause after every story for checkpoint review; `loom autonomy <epic-id>` and `POST /api/epics/:id/autonomy` (web) set the level at any time; a `autonomy_set` audit row is written on every change. Cross-epic **Inbox** view (`/api/inbox`) surfaces plan-approval requests, checkpoint-resume items, and escalations from every registered project in one place with inline approve/reject/retry actions. **Fleet board** view (`/api/fleet`) shows a live multi-project board — epics with their autonomy level, paused state, per-story agent statuses, cost totals, and blocker count — updated in real time via SSE (the `epic` event payload gains `autonomy_level` and `paused` fields). `loom web --read-only` / `LOOM_WEB_READONLY=1` deploys the dashboard in a shareable public mode where GET routes and the SSE stream are token-free; mutations still require the write token. **Operator note:** read-only mode still streams `log_tail` output, cost figures, branch names, and PR URLs over SSE — treat it as internal-only unless those fields are safe to expose. Central `accessGuard` middleware replaces the per-route `requireToken` guards so the read-vs-mutation classification lives in one place. **v0.5.0:** observability + planning-quality + operational-defaults release, PLUS archive runs from PR #55. New transient `integrating` agent status surfaces the bounded integrator's progress; `loom status` now collapses retry attempts to one row per story with a `history` array, sums worker `total_cost_usd` and `total_requests` per story / epic, and surfaces planner request counts; `loom audit` accepts a `--story <id>` filter that spans every retry + rolling-integrator rows; `epic_policy_rebound` audit row fires when the EpicFinalizer re-reads late-bound policy fields (allowed_remotes, test_command, integration_gate, push_gate, pr_attribution) at finalize entry — a snapshot is also persisted on `epics.policy_snapshot` at approve; `policy.agents.shared_contract` default flipped to `on` to prevent sibling-story same-file conflicts; integration-gate auto-detection now scopes to the smallest changed-files directory in monorepos; new `policy.agents.review_timeout_minutes` lifts the silent reviewer cap; integrator max-attempts default bumped from 1→2; machine-wide global limiter defaults to per-supervisor `max_concurrent` when `~/.loom/config.json` is unset; `loom init` writes `.vscode/settings.json` excludes so the IDE stops indexing `.loom/worktrees/**` and `.loom/integration/**`; per-request usage (column `agents.request_count` + `epics.planner_request_count`) reports cursor-cli spend in the org's per-request billing unit. **Plus archive a run** — `loom archive`/`loom unarchive`, `loom status --archived`, and an Archive button + "Show archived" toggle in `loom web` — hides finished/abandoned epics from the default views and supervisor selection without deleting them.). **Plus the honest status lifecycle (epic-005):** epics now report `finalizing` (with a live `finalize_phase`) and `failed` (an infra failure carrying an `error` message, distinct from a human `rejected`); `finalizing → done` is gated on the durably-recorded epic PR URL (`epic_pr_url`), so a `done` epic always has a PR of record and a PR-less success never masquerades as complete; `planning_phase`, `finalize_phase`, `epic_pr_url`, and `error` are surfaced across `loom status`; status now scopes to the current project by default with `all_projects=true` opt-in federation. **Plus the operator-trust hardening (epic-007):** `loom approve` gains an opt-in `--run` that chains into the `loom run` dispatch path (approve on its own still only flips status to `approved`); cursor_model validation adds an alias→advisory tier that warns (never fails) when the configured id is a `-`-boundary prefix of a listed id; `loom doctor` gains `--cross-epic-gate` (optionally `--epics <a,b>`) alongside `--dry-run-gate`; and a reserved epic row gets a derived placeholder title at submission time so status shows what kicked off a job before planning finishes. **Plus the Flywheel (epic-005, v0.8.0):** loom now learns from its own history. Every epic terminal state triggers an `AutoRetrospective` that calls `lesson-extractor` in one batched LLM call to synthesize lessons (category / observation / root_cause / general_rule / evidence) persisted to a schema-v18 `lessons` table; lesson keywords are matched against each story's title + description at dispatch and injected as an advisory **"Lessons from prior epics"** block in the worker prompt; the `loom propose` CLI / POST /api/propose (web) combines top-ranked lessons with top open opportunities to self-propose the next epic (stays `planned` + `manual` until explicit operator approval); `GET /api/lessons` and the new Flywheel tab in `loom web` expose the lessons board and proposal list; a lesson can also be applied as an advisory policy suggestion (`action: 'policy_suggestion'`) without touching `policy.yaml`. Date here is the last meaningful
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

One interface over the engine:

- **CLI (primary)** — drive loom by running `loom …` commands; every read
  command supports `--json`. Each invocation loads fresh, so there is no
  persistent server to watch or to silently run stale code after an upgrade.

---

## Planning

| Capability | How to use | Notes |
|---|---|---|
| **Plan an epic from a brief** | `loom epic "<brief>"` | Three personas in sequence: Mary (Analyst) → John (PM) → Winston (Architect). Writes brief, PRD, architecture, epic.yaml to `epics/<id>/`. **Always runs the brief-quality gate first** — the bundled `loom-brief-builder` rubric scores the brief and refuses anything below `policy.agents.min_brief_quality_score` (default 6/10), returning the critique so you can tighten the prompt. When the brief scores above the threshold the gate returns either **`pass-clean`** (brief is in the ready band with no critical planning-blocking gap — minor optional questions may still be surfaced) or **`pass-with-clarifications`** (above threshold but a critical blocking gap is present; `ready=false`). The presence of optional clarification questions alone does not force `pass-with-clarifications` — only a blocking ambiguity or blocking missing-scope item does. Pass `--force` to override the gate for that one invocation — the refiner still runs and its critique is audit-logged (`brief_gate_forced`) before planning. The override is a per-invocation escape hatch, not a disable switch; only the threshold is tunable per repo. |
| **Plan via the weave intake path** | `loom weave "<brief>"` | Same brief-quality gate, same Analyst → PM → Architect planner, and the same execution path as `loom epic` — both commands share the same planning pipeline. The intake-classification layer (feature / bug / chore + size + confidence + rationale) runs for both; the verdict influences PM sizing according to `policy.agents.intake_routing` (see row below). When `intake_routing=off` (default), planning output is byte-identical to `loom epic`. |
| **Intake routing mode** | `policy.agents.intake_routing` (`off` \| `advisory` \| `confirm`, default `off`) | Controls whether the intake classifier verdict influences PM sizing. `off` (default): verdict recorded observe-only; planning path byte-identical to today. `advisory`: verdict surfaced (type, size, confidence, rationale) and a sizing constraint injected into the PM prompt as a routing-as-sizing-constraint block; operator not prompted. `confirm`: operator is shown the verdict and must accept or override the type/size before planning proceeds; degrades to `advisory` on non-TTY stdin (CI, automated runs) per ADR-004 (FR-7). **Standalone-story routing:** when `intake_routing=advisory` or `confirm` and the effective size resolves to `story`, the planner takes a lightweight standalone path — a single Analyst (brief-refinement) call followed by one `StandaloneStoryAgent` call that produces exactly one story (no PM/PRD step, no epic decomposition). The result is a single-story container (`kind='standalone'`) that dispatches one worker and produces one PR. The story is presented as `story-NNN` everywhere the operator sees it: the `loom weave`/`loom epic` summary output, `loom approve`, `loom run`, and the finalize PR title all use `story-NNN` framing instead of `epic-NNN`. `loom approve story-NNN` and `loom reject story-NNN` both accept the user-facing story id directly. `intake_routing=off` always follows the normal multi-story epic path regardless of brief size. |
| **Within-epic same-file serialization** | Automatic — always on, no operator knob | After the Architect writes the shared contract, the planner detects stories in the same epic that own the same file and injects linear `dependency` edges to force a total order on those stories before persisting the epic YAML. Each injected edge is audit-logged (`plan_serialize_same_file`) with the shared file path and the full story chain. The provenance is also written to each affected story's `dependency_reasons` array so the reason is human-readable in the plan artifacts (ADR-005). Prevents same-file merge conflicts at the source without requiring any policy knob. |
| **Read the produced artifacts** | `loom artifacts <epic-id>` | Returns brief / PRD / architecture / epic YAML bodies. Web UI renders them inline above the Approve button for `planned` epics. |
| **Approve a plan** | `loom approve <epic-id\|story-id> [--run]` | Releases the epic for execution. Approve on its own does **not** dispatch workers — it flips the epic to `approved` and prints `Next: run loom run <id> to dispatch` using the actual id. For standalone stories routed via `intake_routing`, use `loom approve story-NNN` (the user-facing id); `epic-NNN` also works but the output always renders the story id. Pass the opt-in `--run` flag (explicit id required) to chain straight into the same `loom run` dispatch path after approving; bare `loom approve --run` with no id is a usage error. |
| **Reject a plan** | `loom reject <epic-id\|story-id> --reason "..."` | Optional reason is audit-logged. For standalone stories routed via `intake_routing`, use `loom reject story-NNN` (the user-facing id); `epic-NNN` also works. |
| **Self-propose next epic** | `loom propose [--top-lessons <n>] [--top-opps <n>] [--json]` / POST /api/propose (mission-control button) | Combines top-ranked lessons (recency + category frequency, ADR-006) with top open opportunities into a brief, runs it through the brief-quality gate and Planner, and lands a `planned`+`manual` epic stamped `proposed_by='loom'`. The epic stays `planned` until explicit operator approval — no auto-approve or auto-dispatch path exists. Surfaces as a `plan_approval` entry in `GET /api/inbox`. Exactly one batched BriefRefiner LLM call per invocation; explicit trigger only. `--top-lessons <n>` limits the number of lessons included in the proposal brief (default: all top-ranked). `--top-opps <n>` limits the number of opportunities included (default: all top-ranked open opportunities). `--json` emits `{ ok: true, epicId }` on success or `{ ok: false, critique }` on gate failure. |

## Execution

| Capability | How to use | Notes |
|---|---|---|
| **Dispatch story workers** | `loom run [epic-ids...]` | Iterates dependency-ordered stories, opens a git worktree per story, spawns the worker (claude / cursor-agent), commits to a story branch. The EpicFinalizer merges story branches onto `epic/<id>` and opens one PR. |
| **Honest epic lifecycle** | Automatic | An epic moves `planning` → `planned` → `approved` → `in_progress` → `finalizing` → `done`, and the status loom reports never claims more than what shipped. While `planning`, the live `planning_phase` (analyst / pm / architect) is exposed; while `finalizing`, the live `finalize_phase` (`merging` → `gate` → `review` → `pushing` → `opening_pr`) is exposed. **`finalizing → done` is PR-URL-gated:** the EpicFinalizer never writes `done` itself — `done` is set only after the epic PR URL of record (`epic_pr_url`) is durably persisted, so the invariant `done ⇒ epic_pr_url != null` always holds. A successful merge that produces no PR (push-gate `confirm`, no remote, or a remote outside `allowed_remotes`) stays in a defined non-`done` terminal state rather than masquerading as complete. **`failed` vs `rejected` are distinct terminal states:** `failed` is an *infrastructure* failure — a planner crash, OOM, provider error, or a finalize error — and carries the failure `error` message; `rejected` is a *human* decision (`loom reject`). A crash is never recorded as a rejection. |
| **Per-epic autonomy mode** | `loom autonomy <epic-id> [level]` / `POST /api/epics/:id/autonomy` (web) | Three levels. `manual` (default) — operator must approve before dispatch, same as today. `checkpoint` — supervisor self-approves and dispatches; pauses **after each story** so the operator can review before the next one dispatches; `resumeEpic` (web Resume button) continues. `full-auto` — supervisor self-approves and dispatches all stories without pausing. The level can be changed at any time; the change is audit-logged with an `autonomy_set` row. |
| **Checkpoint after every story** | `loom run --checkpoint story` | Pauses between stories; review before the next dispatches. |
| **Checkpoint after every epic** | `loom run --checkpoint epic` | Pauses between epics; review the bundled PR. **Default recommendation.** |
| **Stream live worker output** | `loom run --verbose` | stdout/stderr to the terminal. |
| **Halt a run gracefully** | `loom stop [--reason <text>]` | In-flight stories finish; no new dispatch. Before raising the stop signal, every in-flight worktree gets a bounded WIP checkpoint commit (`wip: stop checkpoint [loom]`, `--no-verify`, capped per worker) so a worker about to be terminated leaves a resumable commit rather than discarding its edits. Resume with `loom run`. `--reason` is recorded in the audit log (defaults to `"cli"` when omitted). |
| **Stop one epic's workers only** | `loom stop --epic <epic-id> [--reason <text>]` | SIGTERMs every running worker in that epic while leaving other epics running. Non-existent epic id → exits non-zero with a clear message. `--reason` recorded in audit. |
| **Kill a specific worker** | `loom stop <story-id...> [--reason <text>]` | SIGTERM the worker for one or more stories; each targeted kill is recorded in the audit log. `--reason` defaults to `"cli"`. |
| **Steer a worker in flight** | `loom guide <story-id> "<message>"` | Appends operator guidance to `.loom/guidance/<story-id>.md`. Requires `policy.agents.operator_guidance=on`. |
| **Worker-side pull of operator guidance** | `loom pull-guidance <story-id> [--json]` | Worker-side CLI read of new operator guidance since the last pull. Prints appended text as plain text; `--json` emits `{ content, has_more }`. Exits 0 with "no new guidance" when nothing is new; exits non-zero on error with a one-line message (no stack trace). Complement to `loom guide`. |
| **Per-story token budget** | `policy.agents.budget_tokens_per_story` | When the worker's cumulative tokens exceed the cap, the subprocess is SIGTERM'd and the story marked failed. Requires `claude-cli` backend. |
| **Progress-aware story timeouts** | `policy.agents.story_stall_minutes` (default 12), `story_absolute_cap_minutes` (default 60), `story_timeout_multipliers` (per `estimated_complexity`) | Replaces the old fixed 30-min wall-clock kill. A worker is killed after the stall window of zero output (resets on any stdout/stderr) OR the absolute cap regardless. Kills the worker's process group with SIGTERM→SIGKILL escalation. Before any timeout/budget kill, uncommitted work is checkpoint-committed (`wip: … [loom]`, `--no-verify`) so a kill becomes a resumable commit. The stall reset depends on the backend streaming stdout: the `cursor-cli` backend runs `cursor-agent --output-format stream-json --stream-partial-output`, so incremental assistant output keeps the stall timer alive the same way `claude-cli`'s stream-json does — set `story_stall_minutes` generously relative to `story_absolute_cap_minutes` so a genuinely-working cursor worker is never false-killed between events. |
| **Fast hung-request stream detection** | `policy.agents.hung_request_seconds` (int seconds, default 45; set `0` to disable) | A third, tighter liveness bound (epic-030) beside the minute-based stall/cap. When a worker emits `system/status status=requesting` and then no stream activity arrives within this many seconds, the guard concludes the model call has hung and kills the worker — recovering in seconds instead of waiting the full `story_stall_minutes` window. Any incremental stream event (partial tokens, tool events) disarms it, so a streaming-but-slow worker is never killed earlier than before. |
| **Per-kill stall/hung-request audit diagnostics** | Automatic | On every stall or hung-request guard kill, loom writes a `worker_stall_kill` audit row recording: the kill reason (`stall` / `hung_request`), silence kind (`fully_silent_subprocess` / `hung_request_no_response`), the last stream event label seen before the kill (or `(none)` if nothing ever streamed), whether a checkpoint was committed, and the current auto-resume attempt index. Readable via `loom audit --story <id>`. Produced by `StallKillAudit.recordStallKill` before any re-dispatch decision so the record is written even when auto-resume later rejects. |
| **Crash-resilient resume handoff** | `policy.agents.handoff` (`off` \| `telemetry` \| `summarized`, default `telemetry`) | On a failed/blocked story loom writes `.loom/handoff/<id>.md` from durable telemetry (git log + decision traces + audit). A non-clean retry injects it so the resumed worker continues instead of starting over. `telemetry` costs zero extra tokens. |
| **Automatic in-run resume from checkpoint** | `policy.agents.auto_resume_attempts` (int, default 2; set `0` to disable) | When a stall or hung-request guard kill produces a checkpoint commit, the supervisor automatically re-dispatches the worker via `StoryRetryService.prepare()` — the resumed worker picks up from `.loom/handoff/<id>.md` instead of starting over. Each auto-resume increments a run-scoped (non-persisted) counter per story; once the counter reaches `auto_resume_attempts`, the story is left failed and requires a manual `loom retry`. A clean `loom retry` always grants a fresh budget. Workers killed by the absolute cap (`cap` reason) or without a checkpoint are never auto-resumed. Distinct from manual retry: no operator action required — recovery is fully automatic within the same run. |
| **Retry a failed/blocked story** | `loom retry <story-id> [--clean] [--reason <text>]` / Retry & Clean-retry buttons in `loom web` | Re-dispatches one story. Resume retry (default) keeps the prior branch + checkpoint and feeds the handoff back; clean retry tears down the worktree/branch **and the trees of every story stacked on it** and starts fresh. Lease-aware: a live run re-dispatches it, otherwise the command dispatches the epic itself. Grants a fresh auto-retry budget. Guards a running story or a live per-epic dispatch lease. `--reason` is recorded in the audit log (defaults to `"cli"`). |
| **Phased worker pipeline** | `policy.agents.phases` (`off` \| `on`, default `off`) | When `on`, a story runs as separate implement → verify spawns, each with its own fresh timer and a checkpoint + handoff refresh at the boundary, so a crash mid-verify resumes from the committed implement work. |
| **Worker auth isolation** | `policy.agents.worker_auth` (`inherit` \| `session`, default `inherit`) | When `session`, the worker subprocess env strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` so the spawned `claude` CLI falls back to the operator's `claude login` session. Lets an outer agent (and planning) run on an API key — e.g. event/credit funds set in the orchestrator's environment — while the bulk worker spend stays on the session. **Never put the key in `policy.yaml`** (it would be captured in `policy_snapshot`); it belongs in the orchestrator's environment. `inherit` (default) passes the parent env through unchanged. Requires you stay logged in via `claude login` so workers have a session to use. |
| **Auto-prune orphaned worktrees** | `policy.agents.prune_orphan_worktrees` (`off` \| `on`, default `on`) | At end of run, removes agent-less `.loom/worktrees/<id>` dirs. Failed/blocked trees are kept for resume retry; completed trees are left to the EpicFinalizer. |
| **Architect shared contract** | `policy.agents.shared_contract` (`off` \| `on`, **default `on`** as of v0.5.0) | When `on`, the Architect (Winston) emits an epic-wide implementation contract at plan time — the shared interfaces/types parallel stories must agree on plus a per-story file-ownership map — to `.loom/contract/<epic-id>.md`, and every worker prompt for the epic is prefixed with it so isolated parallel agents stop inventing conflicting seams and editing each other's files. Default flipped to `on` after the multi-epic shared-client run, where sibling stories appending to one client file caused rolling-merge conflicts on every multi-story epic; the file-ownership map removes the conflicts at the source. Costs one extra planning call per run; set `off` to opt back out. |
| **QA test planning** | `policy.agents.qa_planning` (`off` \| `advisory`, default `off`) | When `advisory`, a QA persona (Tessa) runs after the Architect at plan time and writes a concrete, risk-based `test_plan` onto every story — the test levels, the happy/error/edge cases to cover, and the verification bar. Each worker prompt then carries its story's plan so agents build tests-first against an explicit definition of "verified" instead of guessing. Costs one extra planning call per run; `off` keeps the worker prompt byte-identical to the bench baseline. |
| **Integration gate** | `policy.agents.integration_gate` (`off` \| `warn` \| `block`, default `warn`), `test_command` | After the EpicFinalizer merges every story branch onto `epic/<id>`, runs the build/test suite on the integrated tree before opening the PR — the objective check that the feature isn't broken once all stories live together. Also fails when a story was dropped by a merge conflict (amputation). `warn` annotates the PR + audits on failure but still opens it; `block` withholds the PR, leaves `epic/<id>` local, and flips the epic back to `in_progress`. When `test_command` is unset, the gate auto-detects (`npm test` / `make test` / `pytest`) — as of v0.5.0 the auto-detector scopes to the smallest directory containing every changed file (via `git diff --name-only origin/main...HEAD`) so monorepo runs don't pick up an over-broad repo-root command that fails at collection time. Loom never auto-installs deps. |
| **Rolling integration branch** | `policy.agents.integration_branch` (`off` \| `rolling`, default `off`) | When `rolling`, loom creates a live `epic/<id>` branch up front, branches every worker from its current tip, and merges each story back the moment it completes — so parallel agents build on real integrated code instead of colliding only at finalize. A story whose merge conflicts is blocked (its work kept on `story/<id>` with a handoff) rather than silently dropped, and the conflict cascades to its dependents. The finalizer then reconciles, runs the integration gate in the integration worktree, and opens one PR. Requires `pr_strategy=per-epic` (ignored with a warning otherwise); `off` is byte-identical to the bench baseline. |
| **Bounded integrator** | `policy.agents.integrator` (`off` \| `on`, default `off`) | When `on` (with `integration_branch=rolling`), a story whose merge-back conflicts is handed to a bounded agent that resolves the conflict markers in the integration worktree; loom then commits the merge and re-runs the integration gate. The story is integrated only on a **green** gate — otherwise the merge is rolled back and the story falls through to the loud-block path, so the conflict is never silently dropped. Each round is one agent spawn + a full gate run, feeding the prior failure into the next prompt (block-and-revise). The attempts cap (default 2 as of v0.5.0; was 1) is an engine constant — one extra round gives the integrator real room to self-heal a transient gate failure. Requires `integration_branch=rolling` (ignored with a warning otherwise). |
| **Cross-story context notes** | `policy.agents.context_notes` (`off` \| `on`, default `off`) | When `on`, loom writes a short "what I built" note to `.loom/context/<story-id>.md` when a story succeeds (and, under the rolling branch, integrates) — its outcome summary, the commits it added, the files it touched, and key decisions from the reasoning trace. Each dependent story's worker prompt is then appended with its dependencies' notes, so a worker builds on the upstream decisions and surface area in narrative form (complementing the rolling branch, which carries the code, and the shared contract, the plan-time interfaces). A pure telemetry render — zero extra LLM tokens; `off` keeps the worker prompt byte-identical to the bench baseline. |
| **Epic cumulative build-up context** | `policy.agents.epic_buildup` (`off` \| `on`, default `off`) | When `on`, loom injects a size-capped snapshot of every completed story in the epic — outcome summaries (newest first) plus a curated conventions-and-gotchas channel — into each subsequent worker's prompt at dispatch time, so workers build on prior decisions without re-exploring settled ground. **Conventions channel:** a worker may end its output with `LOOM_CONVENTIONS {"conventions":[...]}` (up to 8 entries, 280 chars each) to record coding patterns, gotchas, and architectural decisions it discovered; loom deduplicates these by content hash and injects them (reserved 4 000-char budget, evicted last) into every later worker's prompt. **Dispatch-time staleness boundary:** the snapshot is taken at the moment the worker is dispatched — stories running concurrently in the same wave are not yet reflected; only stories that have fully completed before this dispatch are visible. `off` (default) writes nothing and keeps the worker prompt byte-identical to the baseline. |
| **loom-home artifact relocation** | Automatic during `loom run` finalization. Set `policy.loom_home` to override the default path. | After finalization, planning artifacts (brief, PRD, architecture, epic.yaml) are committed to a dedicated `loom-home` git repository rather than to the target repo. **Location resolution:** defaults to a sibling of the project root at the workspace level (e.g. `~/repos/app` → `~/repos/loom-home`); override with `policy.loom_home` (absolute or `~`-expandable path — the single config knob for this feature). **On-demand init:** if the directory does not exist loom creates it and runs `git init`; an existing git repo is reused without re-initialising. **Write/commit routing:** artifacts land in `repos/<slug>/<epic-id>/` inside loom-home (where `<slug>` is derived from the project name and remote URL hash); a `provenance.json` recording target repo name, path, remote URL, epic ID, run ID, target HEAD SHA, and creation timestamp is committed alongside them with the message `loom: artifacts for <slug>/<epic-id>`. A `pending` marker is written if the commit step fails — loom does not roll back the target PR in that case and the marker reconciles on the next successful run. |
| **Tear down an epic** | `loom revert <epic-id>` | Deletes story branches + flips DB status to rejected. `--remote` also deletes the upstream epic branch and closes loom-opened PRs. |
| **Reconcile a gate-blocked epic** | `loom reconcile <epic-id> [--pr <url>]` | Drives a stranded `in_progress` epic (stuck at `finalize_phase=gate` after a squash-merged PR) to `done`. The `--pr <url>` flag selects the PR-URL verification path (required when the PR was squash-merged, since ancestry checks cannot confirm squash merges; also usable for any merge type). Omitting `--pr` falls back to the ancestry path via `git merge-base --is-ancestor`. On verified merge, writes `epic_pr_url`, clears `finalize_phase`, writes an `epic_reconciled` audit row, and flips status to `done` — in that order (inside a single SQLite transaction, so a mid-sequence crash leaves the DB in a clean pre-reconcile state). Returns `noop` if the epic is already `done` or if `epic_pr_url` is already set (regardless of status) — both are idempotency guards. **Caution:** if a prior reconcile wrote `epic_pr_url` but crashed before setting `status=done`, every subsequent `loom reconcile` returns `noop` and the epic stays non-`done`. To recover, clear `epic_pr_url` directly in `.loom/loom.db` (`UPDATE epics SET epic_pr_url=NULL WHERE id='<id>';`) then re-run. Returns `refused` (with a `reason` field) on verification failure; CLI exits non-zero on `refused` or `failed`. Possible `reason` values: `not_merged` (PR not yet merged, or the ancestry check found no ancestor — squash-merges always require `--pr` since `git merge-base` cannot see them), `unverifiable_offline` (gh or git returned unexpected output, or the local base branch is missing — run `git fetch first`), `tool_unavailable` (gh or git binary not found on PATH), `ref_mismatch` (PR head/base refs don't match the epic branch — branch was renamed; stop and handle manually per ADR-6), `no_epic_branch` (epic branch not found locally), `epic_not_found` (epic not in DB). |
| **Publish a publish-pending epic** | `loom publish <epic-id>` | Drives a `publish_pending` epic to `done` by opening a PR from the already-pushed, finalizer-owned ref (`finalize_ref`) and atomically recording the result. **Distinct from `reconcile`**: publish operates on epics the finalizer *pushed but whose PR step failed* (status=`publish_pending`); reconcile operates on epics that were *already merged* into main (opposite precondition — the two verbs never overlap). On success, writes `epic_pr_url`, clears `finalize_phase`, writes an `epic_published` audit row, and flips status to `done` — in that order, inside a single SQLite transaction. Returns `refused` (CLI exits 1) if the epic is not in `publish_pending` state, has no `finalize_ref` recorded, or is not found. Returns `failed` (CLI exits 1) if `gh pr create` throws or prints no parseable URL — the epic stays `publish_pending` with no partial write. |

## Review

| Capability | How to use | Notes |
|---|---|---|
| **Build signal analysis in PR body** | Automatic | After the integration-gate section, EpicFinalizer appends a `## Build signal analysis` section to every epic PR body. Shows each story's recommended cost tier, heuristic measurements (diff_lines, diff_files, tests_green_first_try, risky_paths_touched), and an **over-spend candidate** flag when `tier=heavy` AND zero review findings AND a green gate — suggesting future runs could safely downgrade. When outcome data is unavailable (`null`), heuristics and tier are still rendered without the flag (graceful degradation, ADR-6). |
| **Block-and-revise review** | `policy.agents.review_strategy=block-and-revise` | After commits, before the PR opens, a `CodeReviewAgent` reviews the diff. Blocker findings re-prompt the worker with the review in context (up to `review_max_passes`). |
| **Cap review passes** | `policy.agents.review_max_passes` (int, default 2) | Maximum worker revision passes under `block-and-revise` before loom stops re-prompting and marks the story blocked. Replaces the former hardcoded cap of 2; `0` reviews once with no re-prompt. |
| **Comment-only review** | `policy.agents.review_strategy=comment` | Findings attach as a PR comment; no revisions. |
| **Cross-model review (opt-in)** | `policy.agents.review_model='cross' + review_model_id=<id>` | Routes the reviewer through a different model than the worker. |
| **Reviewer wall-clock cap** | `policy.agents.review_timeout_minutes` (1–60, default 10) | Bounds the reviewer's CLI subprocess. The legacy hardcoded 10-minute `ClaudeCliClient` timeout silently shipped large story diffs unreviewed (the operator saw `review_status=errored` only in the audit log); raising this lets the reviewer finish on sizable diffs. |
| **Graceful reviewer-crash degradation** | Automatic | A reviewer subprocess failure does NOT cascade-fail the worker. Story is marked done with `review_status=errored`; the PR opens without review findings. |
| **Fetch a story's review verdict** | `loom review <story-id>` | Returns review_status + the reviewer's markdown summary. |

## Visibility

| Capability | How to use | Notes |
|---|---|---|
| **Web dashboard** | `loom web` | Local-only server (random token in URL fragment). List view, detail view with live worker stdout streams via SSE, inline approve/reject/stop/kill controls, plus Retry / Clean-retry buttons on failed or blocked stories. The per-story spend column shows whichever signal the backend reports: USD cost (claude-code), request counts (cursor-cli — previously rendered as a misleading `$0.000`), or both; `/api/cost` rolls up `worker_requests` + `planner_requests` per epic and in totals. |
| **Flywheel lessons board** | `GET /api/lessons` / Flywheel tab in `loom web` | Read-only board showing all synthesized lessons from completed epics — category, observation, general rule, and whether each lesson has been applied as worker guidance or a policy suggestion. Also surfaces self-proposed epics (`proposed_by='loom'`, status=`planned`) as a companion proposals list. Returns `empty: true` when no lessons exist. Token-free in `--read-only` mode. |
| **Cross-epic decision inbox** | `GET /api/inbox` / Inbox tab in `loom web` (**tab not surfaced in nav** — route, view, and inbox.test.ts are intact; to surface: add `<script src="inbox.js"></script>` to `index.html`) | Aggregates pending decisions from every registered project into one list. Entry types: `plan_approval` (an epic waiting for a human to approve its plan), `checkpoint_resume` (an epic paused mid-run after a story in `checkpoint` autonomy mode), and `escalation` (a story in `blocked` status). Inline action buttons (Approve, Resume, Retry) pass the originating `?project=<root>` so actions reach the right project's DB. The list is token-gated unless `--read-only` is active. |
| **Fleet board** | `GET /api/fleet` / Fleet tab in `loom web` (**tab hidden from nav** — route, view, and fleet.test.ts are intact; to re-enable: add `<script src="fleet.js"></script>` to `index.html`) | Multi-project live board. Each card shows the epic title, status, autonomy level, paused state, per-story agent statuses, aggregate cost, and blocker count — all updated in real time via the SSE stream. The SSE `epic` event payload is widened with `autonomy_level` and `paused` fields; consumers that do not read these fields are unaffected. |
| **Set autonomy level** | `loom autonomy <epic-id> [level]` (CLI) / `POST /api/epics/:id/autonomy` (API) — **Autonomy tab removed from `loom web` nav** (autonomy.js deleted); CLI and API endpoint remain fully functional | Changes the autonomy level for a specific epic at any time. `level` must be one of `full-auto`, `checkpoint`, or `manual`. Returns `{ id, autonomy_level }`. Writes an `autonomy_set` audit row. Returns 400 for an invalid level and 404 for an unknown epic. |
| **Stall + worktree info in status** | Automatic | A running story whose worker is approaching/hitting a deadline is flagged with its stall reason (`stall`/`cap`/`budget`/`analysis-only`); `worktree_path` / `branch_name` are surfaced across `loom status` and the web dashboard so you can see a worker about to be killed and `cd` into a failed story's tree. |
| **`integrating` status surfacing** | Automatic | A story whose worker finished but whose rolling-merge / bounded-integrator is still in flight shows as `status=integrating` in `loom status`, with an `integrator: { attempt_number, elapsed_seconds }` block derived from the latest `epic_integration_attempt` audit row. The transient state replaces the prior `done` reading that hid 10+ minute integrator work from operators. |
| **Retry-collapsed status rendering** | Automatic | `loom status` returns one row per story (the latest attempt) instead of one per agent — earlier attempts move to a per-story `history: [...]` array. A resolved-via-retry epic no longer shows stale `blocked` rows. |
| **Gate-blocked indicator** | Automatic | When an epic is `in_progress` with `finalize_phase=gate` (the integration gate blocked and withheld the PR), all three read surfaces — `loom status`, `GET /api/status`, and `GET /api/fleet` — surface `blocked: true` and `blocked_reason: 'integration_gate'` alongside the epic. These fields are additive and optional; they appear only for gate-blocked epics and never alter the `status` string. Use `loom reconcile` to drive the epic to `done` once the PR is merged. |
| **Per-story / per-epic spend** | Automatic | `loom status` sums `cost_usd` and `request_count` across every attempt of a story, surfaces `total_cost_usd` + `total_requests` per story and per epic, and emits `planner_request_count` separately so per-request-billed Cursor users have an actionable spend signal alongside the Claude `total_cost_usd` (which is the actual Anthropic-billed amount, not an estimate). |
| **Story-scoped audit log** | `loom audit --story <id>` | Matches every retry attempt of a story (`agent_id LIKE 'agent-<storyId>-%'`) AND rolling-integrator rows keyed on `command=<storyId>`. |
| **Late-bound policy re-read** | Automatic | At `EpicFinalizer.finalize()` entry, late-bound fields (`git.allowed_remotes`, `agents.test_command`, `integration_gate`, `push_gate`, `pr_attribution`) are re-read from `.loom/policy.yaml` so mid-run edits actually take effect — and an `epic_policy_rebound` audit row records exactly what changed. The full policy snapshot taken at `loom approve` is also persisted on `epics.policy_snapshot` for forensics. |
| **Planning-artifact review in the dashboard** | Open a `planned` epic in `loom web` | Brief / PRD / architecture / epic.yaml render inline above the Approve button. |
| **Status from CLI** | `loom status [--watch] [--epic <id>] [--all] [--archived] [--project <root>]` | At-a-glance epic + story status. Renders the full honest lifecycle: a `finalizing` epic shows its live `finalize_phase` (`finalizing (gate)`, etc.) and a `planning` epic shows its `planning_phase` (`planning (architect)`, etc.); a `failed` epic prints its `error` message; the epic PR URL of record (`epic_pr_url`) is printed once a per-epic PR is opened. **Loom-home path:** a single `loom-home: <path>` line near the top of the human-readable output shows the resolved loom-home repository path (the canonical `resolveLoomHomePath` result — default sibling-of-project heuristic, or `policy.loom_home` override with `~` expansion); if the directory does not yet exist the line appends `(will be created on first use)` (omitted in `--all` mode, where each registered project may have a distinct loom-home path). The `--json` payload gains an additive optional `loom_home` field containing the same resolved path for the single-project view (absent in `--all` mode); the existing `epics` array and all other fields are unchanged. **Derived placeholder title at submission time:** the instant a brief is submitted, the reserved epic row is durably written with a placeholder title derived from the brief (its first Markdown heading, else the brief's first 60 characters) so `loom status` / `loom web` can show what kicked off a job before the ~5-minute Analyst → PM → Architect chain finishes; the planner's real title later replaces it through the existing completion seam. `--all` aggregates across every loom-init'ed repo on the machine. `--archived` also shows archived runs (hidden by default). `--project <root>` scopes the output to a single named registered project (overrides `--all`; mutually exclusive with it). `loom st` is a registered alias for `loom status`. |
| **Archive a run** | `loom archive <epic-id>` / Archive button in `loom web` | Hides a finished/abandoned run from the default `loom status` and web list (and skips it in supervisor selection) so your working set stays scoped to what you still care about. Non-destructive — the epic, its agents, and its audit trail are preserved; run `loom unarchive <epic-id>` to restore. Audit-logged. |
| **Cross-repo web view** | `loom web` (any repo) | List view aggregates epics from every registered project, grouped by project name. |
| **Per-story signal ledger** | `.loom/signals/<story-id>.md` (observe-only) | Generated at story completion: cost tier, review steps, and heuristics (diff_lines, diff_files, tests_green_first_try, risky_paths_touched). **Observe-only — the ledger does NOT influence execution** (NFR-1); loom reads signals back only for rendering the PR body section. Covered by the existing `.loom/` gitignore (never committed). The same signals are also written durably to `audit_log` (`action='story_signals'`), readable via `loom audit`. |
| **Durable worker log** | `.loom/logs/<story-id>.log` / `agents.log_bytes` in DB | Full post-redaction streamed output for each worker is appended to a per-story file under `.loom/logs/` as it is produced. The file is never overwritten or truncated at completion — it always holds 100% of the stream. `agents.log_bytes` in the DB records the authoritative post-redaction byte length and serves as the durable seek offset for consumers reading the file without a full re-stat. Redaction runs once before any write (DB tail or file). Files are covered by the `.loom/logs/` gitignore block and never committed. |
| **Audit log** | `loom audit [--story <id>] [--agent <id>]` | Every command, every policy check, every status change — structured rows for incident review. |
| **Decision traces (worker reasoning)** | `loom traces --story <id> \| --agent <id> \| --epic <id>` | Replayable worker reasoning captured to SQLite. |
| **Per-story decision traces and audit in dashboard** | Epic detail view → **Story observability** section | Within a running or completed epic's detail view, a **Story observability** section renders collapsible **Decision traces** and **Audit log** panels per story. Traces are fetched in one call (`GET /api/epics/:id/traces`, grouped by `story_id` client-side); audit is fetched per-agent (`GET /api/agents/:id/audit`) and merged in timestamp order. Complements the `loom traces` and `loom audit --story <id>` CLI commands. |
| **Skills library board** | Skills tab in `loom web` | Browser view of every bundled, project, global, generated, and shared skill — name, description, source, lifecycle badge, and track record (injected / succeeded / failed counts). Click a skill name to open a per-skill history timeline (`GET /api/skills/:name/history`) showing generated, lifecycle, and injection events in chronological order. Read-only in `--read-only` mode. |
| **Diff for a story or epic** | `loom diff <story\|epic-id>` | The worker's diff vs. the epic base SHA. Supports `--max-bytes`, `--no-stat`, `--json`. |
| **Project directory** | `loom projects` | Lists every loom-init'ed repo on the machine + their latest epic snapshot. |
| **Single project detail** | `loom project <project-root>` | Shows one registered project: root, name, and latest epic id/status/title. `--json` emits `{ project, latest_epic? }`. Exits non-zero if the root is not registered. |
| **"loom learned this run" CLI summary** | Automatic at end of `loom run` | When the self-learning loop generated, promoted, or demoted a skill during the run, the CLI prints a single block summarizing what changed. Silent when nothing changed. |
| **Skill provenance on canary injections** | Automatic in `loom run` output | A candidate skill injected into a story prints `(from story-X)` — the story that originally produced it. Closes the loop visibly between "loom wrote a skill" and "loom used it." |
| **Per-skill history timeline** | `loom skills history <name>` | Merges audit rows + injection records into one chronological timeline: `★` generated, `↻` lifecycle change, `·` injection with outcome. Track-record tail line. |
| **Emit CLI manifest** | `loom describe` / `loom describe <command>` | Emits the full machine-readable CLI self-description manifest as JSON (`ManifestSchema`-valid: `loomVersion`, `source`, `commands[]`, `workflows[]`) or one command's `CommandDescription` by name (full path for subcommands: `"guard check"`, `"mcp add"`). Always JSON — no `--format` flag. Unknown command exits non-zero with a message to stderr. Existing `--help` output is unchanged. |

## Discovery

Loom continuously scans the repo for engineering signals and surfaces ranked opportunities for the operator to act on.

| Capability | How to use | Notes |
|---|---|---|
| **Run signal scanners** | `loom scan [--project <root>]` | Runs three scanners concurrently — audit-log work-failure clusters, code-debt TODOs (capped at 200 deterministic matches), and GitHub issues (degrades to empty + audit note when `gh` is unavailable) — then makes a single batched LLM clustering call over the capped open-signal set to produce a ranked opportunity list. Writes one `signal_scan` audit row. `--project <root>` scopes the scan to a specific registered project instead of the current working directory. |
| **Opportunity board** | `GET /api/opportunities[?project=<root>]` / Opportunities tab in `loom web` | Lists ranked open opportunities across all registered projects. Each card shows title, rationale, score, rank, signal count, evidence links, and status (`open` / `scoped` / `dismissed`). Federated reads use `makeResolveProjectDb`; mutations are token-gated. |
| **Scope an opportunity into an epic** | `POST /api/opportunities/:id/scope` (web) | Runs the brief-quality gate then Planner to create a `manual`-autonomy epic from the opportunity. Returns `{ ok: true, epicId }` on success, or `{ ok: false, critique }` when the brief gate fails. Writes an `opportunity_scoped` audit row. The resulting epic is scoped — if later rejected, the opportunity reopens automatically. |
| **Dismiss an opportunity** | `POST /api/opportunities/:id/dismiss` (web) | Marks the opportunity `dismissed` so it is excluded from future scan-and-rank results. Writes an `opportunity_dismissed` audit row. Dismissed opportunities are not resurfaced by subsequent scans. |

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
| `adversarial-review` | Fan out alongside `edge-case-hunter` + the code-review adapter on every story diff in the block-and-revise loop. | Active under `review_strategy='block-and-revise'`; LLM-backed handler (FR-10), wired into the three-reviewer orchestrator via `workerFactory`. |
| `edge-case-hunter` | Same fan-out — boundary, concurrency, and failure-state findings the code-review pass misses. | Active under `review_strategy='block-and-revise'`; LLM-backed handler (FR-10), wired into the three-reviewer orchestrator via `workerFactory`. |
| `failure-investigator` | On a red gate, grade evidence so the deterministic router picks retry-with-hint / surface-to-operator / stop-epic. | Router wired + tested; grading handler is a stub (always grades `weak`) pending live analysis. |
| `doc-distiller` | Once per story at worker-context assembly — compress planning artifacts, preserving every acceptance criterion verbatim. | Seam invokes it + records provenance; stub output, not yet injected into the worker prompt. |
| `lesson-extractor` | Synthesize lessons (category, observation, root_cause, general_rule, evidence) from a finished epic's decision traces, agent summaries, and audit tail. | Active; LLM-backed handler wired into the `AutoRetrospective` pipeline (epic-005). |

### Self-learning loop

| Capability | How to use | Notes |
|---|---|---|
| **Auto-retrospective on epic completion** | Automatic | After every epic reaches `done` or `failed`, the `AutoRetrospective` runs best-effort: gathers decision traces, agent summaries, and audit tail, then calls the `lesson-extractor` SKILL.md in a single batched LLM call to synthesize `Lesson` records (category, observation, root_cause, general_rule, evidence) persisted to the `lessons` table (schema v18). If extraction fails the failure is audit-logged (`auto_retro_skipped`) and the epic status is unaffected. |
| **Lesson guidance injection into worker prompts** | Automatic | At story dispatch, lessons are scored by keyword overlap with the story title + description + epic title; the top-3 matches are injected as a **"Lessons from prior epics"** advisory block in the worker prompt. Each injected lesson is marked `applied_as='worker_guidance'` with the story ID as `applied_ref`. Advisory only — never added as system instructions (T-1). |
| **Apply a lesson as a policy suggestion** | `applyAsPolicySuggestion` (programmatic) | Records a free-text policy suggestion derived from a lesson as an `audit_log` entry (`action: 'policy_suggestion'`) and marks the lesson `applied_as='policy_suggestion'`. Does NOT write to `policy.yaml` or modify the `PolicyEngine` — the suggestion is advisory and must be reviewed and applied by an operator. |
| **Per-story skill extraction** | `policy.agents.skill_generation` (`on` \| `off` \| `sampled`) | After each successful story, an LLM proposes a reusable `SKILL.md`. `'on'` runs every story, `'sampled'` every Nth (see `skill_generation_sample_n`), `'off'` disables. |
| **Candidate quality gate** | `policy.agents.skill_judge_min_score` (0–10, default 6) | A second LLM scores each candidate against two hard rejection criteria (safety and reusability) and a five-dimension rubric. Hard criteria take **absolute precedence over the score**: a candidate that teaches or encourages a destructive operation (force-pushing, rewriting history, deleting data without recovery, disabling safety checks) is rejected regardless of score; a candidate too narrowly scoped to a single repo's internals or a one-off task is also rejected regardless of score. A polished, high-scoring skill is still rejected if it fails either hard criterion. Candidates that pass both criteria are then scored; those below the threshold are rejected silently. A skill that merely *mentions* a destructive command to warn against it is not rejected on that basis alone. |
| **Canary lifecycle for candidates** | Automatic | Candidates are injected only as canaries (spare slots after active skills); promoted to `active` after `skill_promote_after` clean successes; demoted to `disabled` when `skill_demote_failure_ratio` crosses with at least `skill_demote_min_samples` samples. |
| **Auto-PR a high-scoring candidate** | `policy.agents.skill_auto_propose` (`off` \| `sampled` \| `always`) | Candidates scoring `>= skill_auto_propose_min_judge_score` (default 8) trigger a PR back to a source repo configured in `~/.loom/sources.yaml`. Capped per epic via `skill_auto_propose_max_per_epic`. |
| **agentskills.io spec conformance** | Automatic at generation time | Generated `SKILL.md` is validated against the open agentskills.io spec (name ≤ 64 chars + lowercase/hyphen regex, description ≤ 1024 chars, body soft cap ≤ 20000 chars) before being written. Keeps loom skills portable to other agentskills.io consumers (hermes-agent, Claude Skills, Codex Skills). |
| **Loom-internal metadata stripped pre-publish** | Automatic in `loom skills propose` | Provenance fields (`generated_from_story_id`, `generated_from_epic_id`) and lifecycle markers are scrubbed from the SKILL.md committed to the upstream skill repo. |

## Safety / guardrails

| Capability | How to use | Notes |
|---|---|---|
| **Policy engine** | `.loom/policy.yaml` | Per-repo configuration. Blocks force-push, `git reset --hard`, command chaining (`&&`, `;`, `$(...)`), backgrounding (trailing `&`, `a & b`), and forbidden file writes. Fd-duplication/redirection forms (`2>&1`, `>&2`, `&>file`, `>&-`, `<&`) are permitted, so a command like `npm test 2>&1` passes the metacharacter check while its bare `&` cousins stay blocked. |
| **Pre-tool-use hook** | Auto-installed by `loom init` | Claude Code's `PreToolUse` hook calls `loom guard hook` before any shell command. Blocked commands exit non-zero — the model cannot bypass by ignoring instructions. |
| **Worktree isolation** | Automatic | Every story runs in its own git worktree on its own branch. Agents physically cannot touch the main branch. |
| **PR-only landings** | `policy.git.agents_must_use_pr=true` (default) | Agents open PRs; a human reviews and merges. |
| **One PR per epic** | `policy.agents.pr_strategy=per-epic` | The EpicFinalizer merges story branches in dependency order onto `epic/<id>` and opens a single PR. |
| **Push-confirmation gate** | `policy.git.push_gate='confirm'` | The supervisor prompts the operator before pushing to any allowed remote. |
| **Allowed-remote allowlist** | `policy.git.allowed_remotes` | Glob patterns. Pushes to non-matching remotes are blocked. |
| **Audit log of everything** | Automatic | Every command (allowed or blocked) is logged with structured metadata to `.loom/loom.db`. |
| **Brief-quality gate** | `policy.agents.min_brief_quality_score` (1-10, default 6) | Every `loom epic` runs the BriefRefiner before the planner and refuses briefs scoring below the threshold. Controls planner cost and trains operators on what a planning-ready brief looks like. Above-threshold briefs receive a **`pass-clean`** verdict (brief is in the ready band, no critical planning-blocking gap; minor optional questions may still be surfaced) or **`pass-with-clarifications`** (above threshold but a critical blocking gap is present; `ready=false`). Optional clarification questions alone do not force `pass-with-clarifications` — only a blocking ambiguity or blocking missing-scope item does. `loom epic --force` overrides the gate for a single invocation — the refiner still runs and its critique is audit-logged (`brief_gate_forced`) before planning. The override is a per-invocation escape hatch, not a disable switch; only the threshold is tunable per repo. |
| **Read-only public mode** | `loom web --read-only` / `LOOM_WEB_READONLY=1` | Serves the dashboard without requiring a token on GET routes or the SSE stream — useful for sharing a live view with stakeholders. Mutations (`POST`, non-GET) still require the write token and return 403 without it. The classification is centralised in a single `accessGuard` middleware; no per-route token check is needed. **Operator sensitivity note:** even in read-only mode the SSE stream emits `log_tail` worker output, cost figures, branch names, and PR URLs — expose the URL only to audiences for whom that data is appropriate. |

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
| **Skill-judge gate eval** | `npm run eval:skill-judge` | Runs `SkillJudge` against the labeled 10-case fixture and produces a go/no-go verdict. Reports `decisionAccuracy`, `bandAgreement`, `independentAgreement`, and `failOpenObserved`. Gate model defaults to Haiku (`LOOM_EVAL_GATE_MODEL`); judge model to Opus (`LOOM_EVAL_JUDGE_MODEL`) — different models by design to prevent the gate grading its own homework. Offline-from-CI, operator-run, observe-only — never dispatched by loom (ADR-006). Report written to `.loom/eval/skill-judge-report.{md,json}`. |
| **Lesson-extractor gate eval** | `npm run eval:lesson-extractor` | Runs `LessonExtractor` against the labeled 2-case fixture and produces a go/no-go verdict. Reports all four aggregate metrics: `faithfulness`, `usefulness`, `coverage`, and `hallucinationRate`, plus `overExtractionRate`. Gate model defaults to Haiku (`LOOM_EVAL_GATE_MODEL`); judge model to Opus (`LOOM_EVAL_JUDGE_MODEL`) — different models by design to prevent the gate grading its own homework. Offline-from-CI, operator-run, observe-only — never dispatched by loom (ADR-006). Consumer reachable by deep import only (`./lesson-extractor/run.js`), not via the top barrel, to avoid wildcard-collision failure (ADR-001). Report written to `.loom/eval/lesson-extractor-report.{md,json}`. |
| **Opportunity-engine gate eval** | `npm run eval:opportunity-engine` | Runs `OpportunityEngine` against the labeled 8-case rubric fixture and produces a go/no-go verdict. Reports five aggregate metrics: `coherence`, `scoreReasonableness`, `grounding`, `forcedClusteringRate`, and `hallucinationRate`. Gate model defaults to Haiku (`LOOM_EVAL_GATE_MODEL`); judge model to Opus (`LOOM_EVAL_JUDGE_MODEL`) — different models by design to prevent the gate grading its own homework. Quality-bar thresholds overridable via `LOOM_EVAL_OPP_*` env vars. Offline-from-CI, operator-run, observe-only — never dispatched by loom (ADR-006). Consumer reachable by deep import only (`./opportunity-engine/run.js`), not via the top barrel (ADR-001). Report written to `.loom/eval/opportunity-engine-report.{md,json}`. |
| **Skill-generator gate eval** | `npm run eval:skill-generator` | Runs `SkillGenerator` against the labeled 8-case rubric fixture (2 worthy, 4 trivial, 2 borderline) and produces a go/no-go verdict. Reports five eval-specific metrics: `decisionCorrectness` (fraction of non-borderline cases with the correct generate/none decision), `spuriousGenerationRate` (false-positive rate on trivial cases), `skillQuality` (composite structural quality of generated skills), `faithfulness` (grounding in actual work context), and `lowQualityRate`. Gate model defaults to Haiku (`LOOM_EVAL_GATE_MODEL`) — the same model tier as `policy.agents.skill_gen_model` in production; judge model to Opus (`LOOM_EVAL_JUDGE_MODEL`) — different models by design. Quality-bar thresholds overridable via `LOOM_EVAL_SKILLGEN_*` env vars. Offline-from-CI, operator-run, observe-only — never dispatched by loom (ADR-006). Consumer reachable by deep import only (`./skill-generator/run.js`), not via the top barrel (ADR-001). Report written to `.loom/eval/skill-generator-report.{md,json}`. |

## Integration & deployment

| Capability | How to use | Notes |
|---|---|---|
| **Provision approved MCP servers for workers** | `loom mcp add <name>` / `policy.mcp.registry` | **Exclusive allowlist — this is a behavior change.** A worker sees *exactly* the servers in `policy.mcp.registry` and nothing else. claude-code workers get the registry servers only (enforced structurally via `--strict-mcp-config --mcp-config <worktree>/.cursor/mcp.json`); cursor-cli workers get the registry servers only. No loom-internal server is injected — loom no longer ships or runs an MCP server of its own; cursor workers read operator guidance via `loom pull-guidance <story-id>` or `.loom/guidance/<story-id>.md` directly (routed off MCP; see `loom pull-guidance`). **Operator-facing break: servers inherited from your personal `~/.cursor/mcp.json` no longer load in worker sessions.** A worker that used to rely on a globally-configured server will no longer see it — **migrate by registering it explicitly with `loom mcp add <name>`** so it lands in the worktree allowlist. cursor-cli enforcement is best-effort, not structural: `cursor-agent` has no `claude`-style strict flag, so loom enumerates the visible servers per worktree and headlessly disables every non-allowlisted one (per-project, durable, never touching your global config), recording any it cannot disable — plus the inherent setup→spawn race window — in the `worker_mcp_servers` audit row. That residual strictness gap and the out-of-scope upstream `--strict-mcp-config`-equivalent ask are documented in [`docs/research/cursor-mcp-strictness.md`](research/cursor-mcp-strictness.md). |
| **Prerequisites probe** | `loom doctor` | Checks Node version, git, claude CLI, gh CLI, cursor-agent CLI; warns if `loom` is not on PATH. When a `cursor-cli` backend is configured, also validates `agents.cursor_model` against `cursor-agent --list-models` — fails with the complete valid-model list on an invalid id, warns (never fails) when the probe can't run offline; the same check runs at the start of `loom epic` / `loom run` and exits before any LLM pass. **Alias→advisory tier:** when `cursor_model` is not an exact id but a `-`-boundary prefix of exactly one listed id (e.g. `claude-opus-4-8` for `claude-opus-4-8-high`), the check still passes but emits an *advisory* — a warning, never a failure — recommending you pin the explicit suffixed id; doctor renders it as a non-required Check and `loom epic` / `loom run` warn without exiting. Also runs an advisory integration-gate-command preflight: it resolves the command the gate would run (`policy.agents.test_command`, else auto-detected) and reports whether it's viable in a bare integration worktree — advisory only, it never flips doctor's exit code. `loom doctor --dry-run-gate` is the explicit opt-in that actually executes that gate command once in a throwaway worktree and prints the outcome; `loom doctor --cross-epic-gate` (optionally narrowed by `--epics <a,b>`) merges every open `epic/*` branch into a throwaway union worktree and runs the suite once, reporting per-pair conflicts or the union suite result without mutating any real branch; plain `loom doctor`, `loom epic`, and `loom run` never run either. `loom doctor --capabilities` runs the documentation drift check — verifies that every operator command and policy knob is documented in `docs/capabilities.md`; emits missing and phantom token lists on drift and exits non-zero; the check is skipped gracefully if `docs/capabilities.md` is unreadable or the CLI surface cannot be enumerated. |
| **Init in any repo** | `loom init [--cursor]` | Writes `.loom/policy.yaml`, the SQLite DB, and the guard hook. `--cursor` writes the Cursor rules config. Always (re)writes `.loom/policy.example.yaml` (living docs) and reports any policy knobs missing from your `policy.yaml` — the same notice `loom doctor` prints. As of v0.5.0 also writes/merges `.vscode/settings.json` excludes for `.loom/worktrees/**` and `.loom/integration/**` so Cursor/VS Code stops indexing every story worktree (the "too many active changes" warning during multi-epic runs). Registers the repo in `~/.loom/projects.json`. |
| **Cut a release** | `loom release <version>` | Bumps all workspace `package.json` versions via `scripts/bump-versions.mjs`, creates `release/v<version>`, commits `chore(release): v<version>`, pushes the branch, and opens a PR against `main`. **Never pushes `main` directly** — always a PR-merge step. **Guard-compatible:** `release/v*` is not a protected branch and no `--force` flag is used. Post-merge operator step: `git tag v<version> <merge-sha> && git push origin v<version>`. |

## Cost discipline

| Capability | Notes |
|---|---|
| **Session-based by default** | `claude-cli` / `cursor-cli` backends use the Claude / Cursor login the developer already has — **no metered tokens**. |
| **Tiered model routing** | Opus for planning, Sonnet for execution, Haiku for meta-work. Per-role in `.loom/policy.yaml`. |
| **Actual claude cost (not estimate)** | Automatic | `cost_usd` per agent is the actual API-billed amount harvested from `claude --output-format stream-json`'s `total_cost_usd` result field — sourced from Anthropic's metering, not a token-rate estimate. |
| **Per-request reporting for cursor-cli** | Automatic | Cursor's organizational pricing is per-request, not per-token. Loom records `request_count` per agent and `planner_request_count` per epic, and `loom status` surfaces `total_requests` per story / epic. Each `complete()` call is attributed `1` request; the worker spawn parser harvests any `usage` / `request_count` / `total_cost_usd` fields cursor-agent exposes in its JSON output. |
| **Planning token tracking** | Per-epic input / output / cached / cache-creation tokens + wall-clock time recorded on the epic row. |
| **Planning token budget warning** | `policy.agents.planning_token_budget` — `loom epic` warns when a run blows the cap. |
| **Per-story worker budget enforcement** | `policy.agents.budget_tokens_per_story` — kills the worker when exceeded. |
| **Machine-wide concurrency cap** | `~/.loom/config.json` `max_global_workers`, with per-supervisor `policy.agents.max_concurrent` as the fallback (v0.5.0) | The global cap used to be opt-in; running N supervisors in parallel could collectively exhaust the developer's session capacity. The fallback now bounds the machine to whatever the current `max_concurrent` is so the default is safe without giving up the explicit-opt-out for tests. |

Per-agent token, cost, and request columns are written to `.loom/loom.db` —
`loom status` rolls them up per-story and per-epic; query SQLite
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
- **`loom uninstall`.** Tracked as alpha-blocking A4 in the Jira slate.

---

## Maintenance rules

This page must stay current. **Update it in the same PR that ships the
feature.** Specifically:

- If a PR adds a new CLI subcommand → add a row to the relevant table.
- If a PR adds a new web endpoint that's user-visible → add a row.
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

<!-- coverage:command:start -->
`loom approve`
`loom archive`
`loom artifacts`
`loom audit`
`loom autonomy`
`loom diff`
`loom doctor`
`loom epic`
`loom guard check`
`loom guide`
`loom init`
`loom mcp add`
`loom mcp list`
`loom opportunities`
`loom project`
`loom projects`
`loom propose`
`loom pull-guidance`
`loom reconcile`
`loom reject`
`loom retry`
`loom revert`
`loom review`
`loom run`
`loom scan`
`loom st`
`loom status`
`loom stop`
`loom traces`
`loom unarchive`
`loom web`
`loom weave`
<!-- coverage:command:end -->

<!-- coverage:knob:start -->
`policy.agents.auto_resume_attempts`
`policy.agents.budget_tokens_per_story`
`policy.agents.context_notes`
`policy.agents.cursor_model`
`policy.agents.epic_buildup`
`policy.agents.handoff`
`policy.agents.hung_request_seconds`
`policy.agents.intake_routing`
`policy.agents.intake_timeout_ms`
`policy.agents.integration_branch`
`policy.agents.integration_gate`
`policy.agents.integrator`
`policy.agents.llm_backend`
`policy.agents.max_concurrent`
`policy.agents.min_brief_quality_score`
`policy.agents.model`
`policy.agents.phases`
`policy.agents.planning_model`
`policy.agents.pr_strategy`
`policy.agents.prune_orphan_worktrees`
`policy.agents.qa_planning`
`policy.agents.require_human_pr_merge`
`policy.agents.review_timeout_minutes`
`policy.agents.shared_contract`
`policy.agents.skill_demote_failure_ratio`
`policy.agents.skill_demote_min_samples`
`policy.agents.skill_gen_model`
`policy.agents.skill_judge_min_score`
`policy.agents.skill_promote_after`
`policy.agents.story_absolute_cap_minutes`
`policy.agents.story_stall_minutes`
`policy.agents.story_timeout_multipliers.large`
`policy.agents.story_timeout_multipliers.medium`
`policy.agents.story_timeout_multipliers.small`
`policy.agents.story_timeout_multipliers.trivial`
`policy.agents.test_command`
`policy.agents.worker_backend`
`policy.agents.worktree_isolation`
`policy.filesystem.allowed_write_root`
`policy.filesystem.protected_paths`
`policy.git.agents_must_use_pr`
`policy.git.allowed_remotes`
`policy.git.forbidden_flags`
`policy.git.protected_branches`
<!-- coverage:knob:end -->

*Single source of truth for what loom does. Edit in
`docs/capabilities.md`. Linked from README, getting-started, and CLAUDE.md.*
