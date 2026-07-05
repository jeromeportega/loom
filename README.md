# Loom

**A self-learning, self-healing, cross-repo agentic engineering system.**

Write a one-paragraph brief. Approve the plan. Agents deliver the epic — planning,
implementation, tests, and pull requests — while you stay in control.

Loom orchestrates Claude Code and Cursor: it turns an interactive coding assistant
into an unattended, auditable, self-improving epic-delivery system. Work can span
multiple repositories in a single brief; planning artifacts live in the loom-home
control plane; cost is tracked and queryable via `loom cost`.

```bash
npm install -g loom-ai          # see Install below
loom init                       # in your git repo
loom epic "Add a /health endpoint that returns build info, with a test"
loom approve epic-001 && loom run --checkpoint epic
```

---

## The CLI is the usability surface

Drive loom by running `loom …` commands. Each invocation runs fresh and
prints to stdout, and every read command supports `--json` — so an outer
agent can drive loom by running commands and reading their output, with no
persistent server to watch (and nothing to silently run stale code after an
upgrade).

```bash
loom epic "<brief>"               # plan an epic
loom approve <epic-id> --run      # approve + dispatch
loom status --json                # poll progress + PR links
loom diff <story|epic-id>         # inspect a story/epic diff
loom review <story-id>            # the reviewer verdict
```

---

## Why loom

AI coding tools today make a developer faster keystroke by keystroke. Loom changes
the unit of work: you delegate an **entire epic** and supervise the outcome.

Write a paragraph describing what you want. Loom plans it — analyst, product-manager,
and architect personas turn the brief into a PRD, an architecture, and a set of
stories. You approve the plan. A supervisor then dispatches story agents that each
work in an isolated git worktree, write code and tests, and open pull requests. You
review the PRs. That is the whole loop — **two human touchpoints: the brief and the
approval.**

That is only worth doing if it is safe to step away. Loom is built structurally for
exactly that:

- **Delegation, not autocomplete.** The bottleneck moves from typing speed to how
  clearly you can describe intent and how well you review — the parts that should
  stay human.
- **Senior review at execution, curated at planning.** Loom ships a curated skill
  library — UX-design, edge-case review, code review, plan review, brainstorming,
  technical writing. At *story execution* the Supervisor auto-injects relevant
  skills into each worker (the right place — a story implementing JWT signing wants
  the code-review skill in context as it writes). At *planning* the chat client
  (Claude Code or Cursor, via the `loom-skill-curator` skill) decides per-brief
  which lenses apply and enriches the brief before calling `loom_plan_epic` — so the planner
  sees a brief already shaped by the relevant disciplines, not every keyword-matched
  skill. The split keeps the value of curated expertise without the over-planning
  that came from blanket injection at the planner.
- **Structural guardrails.** Destructive commands are blocked by a policy engine and
  by git worktree isolation — enforced at the OS level, not by asking the model to
  behave.
- **It learns without drifting.** Beyond the curated library, loom extracts new
  skills from completed work; an eval harness and a candidate→active→disabled
  lifecycle stop a bad skill from degrading the system over time.
- **Auditable.** Every agent action — every command, every status change — is logged
  to a local SQLite database you can query.
- **No API billing.** Loom is session-based: it drives the Claude Code (or Cursor)
  CLI you are already logged into. Delivering an epic in a day costs no metered tokens.

This is what agentic engineering becomes once the model is good enough to trust with a
unit of work: not a faster autocomplete, but a system that brings senior judgment to
every task and a structure you delegate to and supervise.

## Cost-aware by design

AI-forward orgs still want to see deliberate cost control. Loom bakes it in:

- **Always refine before you plan.** Every `loom epic` (and `loom_start_epic`)
  runs the `loom-brief-builder` rubric automatically before the planner — a
  single cheap Sonnet call. Briefs scoring below
  `policy.agents.min_brief_quality_score` (default 6/10) are refused with a
  structured critique so you tighten the prompt before paying the Opus
  planner. Pass `--force` (or `force: true` on `loom_start_epic`) to override
  the gate for a single run — the refiner still runs and its critique is
  audit-logged. The override is a per-invocation escape hatch, not a disable
  switch; only the threshold is tunable per repo.
- **Tiered model routing, not all-top-tier.** The planner runs on the latest Claude models
  at the highest reasoning tier, where depth matters most. Story execution uses the
  mid-tier; meta-work (skill generation, the skill judge) uses the lightweight tier.
  Configurable per role in `.loom/policy.yaml`.
- **Planner token tracking, per epic.** Every planning run records input / output /
  cached tokens and wall-clock time on the epic row. `loom status` displays it so
  cost is visible, not buried.
- **Planning token budget.** Set `policy.agents.planning_token_budget`; `loom epic`
  warns at the end of the run if the planning step ran over. Catches a brief that
  blew up the pipeline.
- **Session-based by default.** `claude-cli` and `cursor-cli` backends use the
  Claude Code or Cursor login you already pay for — **no API metering**. The
  `anthropic-api` backend exists for cases where session auth is not viable; it is
  the only opt-in to billed tokens.
The objective is engineering throughput *per token consumed*, not raw token usage.
Per-agent token columns are written to `.loom/loom.db`; query the SQLite directly
if you need a roll-up today.

## What loom does

| Capability | How |
|---|---|
| **Plan** | Analyst → PM → Architect personas turn a brief into a PRD, an architecture, and a story breakdown |
| **Build** | Parallel story agents implement, test, and merge — each isolated in its own git worktree. A single-repo epic produces one pull request; a cross-repo epic produces one pull request per repository, landed in dependency order with all-ready-or-none staging. |
| **Learn** | A curated skill library auto-injects into worker agents; new skills are extracted from successful work and gated by an eval harness (the lifecycle runs internally — no user-facing CRUD surface today) |
| **Supervise** | `loom status`, checkpoints, and `loom stop` keep you in control; `loom status --all` spans every repo on the machine |
| **Observe** | Local web dashboard (`loom web`) for visibility into running agents, planning artifacts, and history; `loom cost` for per-epic cost and token breakdown |
| **Integrate** | Provisions your org's approved MCP servers for worker agents via `loom mcp add` |

---

## You stay in control

Loom is autonomous, not unsupervised. Before anything else, know your brakes:

- **Structural guardrails.** A policy engine blocks destructive commands (force-push,
  `git reset --hard`, deleting protected paths, command chaining) at the OS level —
  not by asking the model nicely. See `.loom/policy.yaml`.
- **Worktree isolation.** Every story runs in its own git worktree on its own branch.
  Agents physically cannot touch your main branch; they open PRs you review.
- **`loom stop`** halts a run gracefully at any time — in-flight stories finish, no
  more dispatch. Resume later with `loom run`.
- **Checkpoints.** `loom run --checkpoint story` (or `epic`) pauses at each boundary
  so you can review and adjust before continuing. New to loom? Start with
  `--checkpoint epic`.
- **The human gate.** Nothing executes until you `loom approve` the plan.

---

## Prerequisites

- **Node.js 20+** and **git 2.5+** — required.
- **The `claude` CLI** (Claude Code), logged in — required for real runs. Loom is
  session-based: it uses your Claude Code login, **no API key, no API billing**.
- **`gh`** (GitHub CLI) — needed for agents to open PRs.
- **`cursor-agent`** (Cursor CLI) — optional, only for the `cursor-cli` backend.

Run `loom doctor` any time to check these.

---

## Install

Loom is published to the npm registry:

```bash
npm install -g loom-ai
loom doctor
```

From a checkout (contributors / latest unreleased changes):

```bash
git clone git@github.com:jeromeportega/loom.git && cd loom
npm install && npm run build && npm link -w loom-ai
```

> Installing loom globally matters: worker agents call `loom` for their guardrail
> hook. `loom doctor` will warn you if it is not on your PATH.

> [!NOTE]
> The first time you run `loom`, it will write a `.loom/` directory plus a
> Claude Code guard hook to the current repo. Run `loom init` explicitly to
> do this without dispatching an epic; see `loom init --help` for what gets
> written.

---

## First 10 minutes

```bash
cd your-git-repo
loom doctor                       # check prerequisites
loom init                         # set up .loom/, the guard hook, Claude Code config
loom epic "Add a /health endpoint that returns build info, with a test"
#   → plans the epic (Analyst → PM → Architect); a few minutes, headless
loom status                       # review the planned epic
loom approve epic-001             # release it for execution
loom run --checkpoint epic        # dispatch story agents; pause after the epic
loom status                       # watch progress and PR links
```

That is the whole loop. Everything below is reference.

---

## The workflow

| Step | Command | What happens |
|---|---|---|
| Set up | `loom init` | Creates `.loom/`, the policy, the guard hook, IDE config |
| Plan | `loom epic "<brief>"` | Planning personas produce a brief, PRD, architecture, and epic YAMLs |
| Review | `loom status` | Inspect the planned epics under `.loom/planning/` |
| Approve | `loom approve [epic-id]` | Release planned epic(s) for execution |
| Execute | `loom run` | The supervisor dispatches story agents in isolated worktrees |
| Track | `loom status [--watch]` | Per-story status and PR links |

`loom init --cursor` additionally writes the Cursor rules file and `.cursor/mcp.json` for worker MCP provisioning.

---

## Built-in skills

Loom ships a curated library of skills that strengthen the autonomous
pipeline. They are **not** commands a developer invokes — the Supervisor
injects them into worker agents at story dispatch, so the implementation
is shaped by the right discipline without anyone naming it.

| Skill | What it brings |
|---|---|
| `loom-ux-designer` | A UX-designer persona — also exposed as `/loom-ux-designer` for interactive use |
| `loom-ux-design` | Producing UX design specs: flows, states, accessibility |
| `loom-brainstorm` | Generating and pressure-testing options before committing |
| `loom-plan-review` | Checking a plan or PRD for implementation-readiness |
| `loom-edge-case-review` | Adversarially hunting edge cases and failure modes |
| `loom-code-review` | A staff-engineer pass over a diff or PR |
| `loom-tech-writer` | Writing or improving documentation |
| `loom-pr-description` | Used by the EpicFinalizer to compose the epic PR body |
| `loom-brief-builder` | The brief-quality gate's rubric |
| `loom-skill-curator` | Read by the chat client when shaping a brief before calling `loom_start_epic` |

The Supervisor's `SkillSelector` chooses the relevant skills per story;
the candidate→active→disabled lifecycle runs internally.

Drop your own skills into `.loom/skills/` to extend the set; they're
picked up by the SkillStore at dispatch.

---

## Connecting MCP servers

Loom can provision approved MCP servers so worker agents inherit them:

```bash
# Point policy.mcp.registry at a checkout of your org's MCP registry, then:
loom mcp list                     # approved servers
loom mcp add jira-mcp             # add one to .mcp.json + .cursor/mcp.json
```

Loom writes required secrets as `${REFERENCES}` and tells you which env vars to set —
it never reads or stores a credential value.

---

## Control & steering

```bash
loom run                          # complete all approved epics
loom run --checkpoint story       # run one story, then pause
loom run --checkpoint epic        # run one epic, then pause
loom stop                         # gracefully halt a running supervisor
loom run                          # resume — completed stories are skipped
```

Checkpoints form a trust ladder: `story` → `epic` → no checkpoint. Tighten or loosen
as you learn to trust the system.

## Live visibility

A run is not a black box. By default `loom run` prints a dispatch and a completion
line per story as workers start and finish. Pass `--verbose` to stream each worker's
stdout and stderr to your terminal as it arrives, line-buffered and prefixed with the
story id so concurrent workers stay readable:

```bash
loom run                          # one line per story start/finish
loom run --verbose                # also stream live worker output
```

The same live tail is written to the DB, so any other window can read it — `loom
status` (or `loom web`) shows the latest stdout/stderr from every *running*
worker, not only the post-mortem after it finishes.

### Where loom writes things

`.loom/` holds **working state** — SQLite DB, per-story worktrees, in-progress
planning artifacts. Local to your machine, mostly gitignored.

Delivered artifacts live in the loom-home control plane; target repositories receive only code pull requests. The loom-home path defaults to a sibling of
the project root (e.g. `~/repos/loom-home`); override with `policy.loom_home`.
Future briefs can reference the delivered architecture from loom-home — every
delivered epic becomes a referenceable seed for related work.

### How pull requests land

A single-repo epic produces one pull request. A cross-repo epic produces one pull request per repository, landed in topological (dependency) order with all-ready-or-none staging and forward-revert rollback.

Worker agents commit on isolated story branches; the `EpicFinalizer` merges
those branches in dependency order. Story commits are preserved on the epic
branch so reviewers can see each unit. On a merge conflict, the finalizer
aborts that specific merge and lists the conflicted story in the epic PR
description for follow-up — the rest of the epic still ships.

`policy.agents.pr_strategy` is the knob; only `per-epic` is accepted (one PR per repository for cross-repo epics; the landing order is controlled by the coordinator, not this knob).

### The local web dashboard — `loom web`

For the rich multi-agent view, run:

```bash
loom web                          # starts the local dashboard on a free port
```

`loom web` serves a single-process dashboard at `http://127.0.0.1:<port>` over
the same SQLite state the supervisor writes to. The list view **federates
across every loom-init'ed repo on the machine** — one window, every active
project, grouped by repo name (current project first). The detail view
streams live worker stdout via SSE, surfaces planning artifacts (brief,
PRD, architecture, epic YAML) inline for `planned` epics so you can review
the plan before approving, and exposes inline controls: approve / reject /
stop / per-worker kill. No external services — local only.

---

## Command reference

| Command | Purpose |
|---|---|
| `loom doctor` | Check prerequisites and the machine config |
| `loom init [--cursor]` | Initialize loom in a repo |
| `loom epic "<brief>"` | Plan an epic from a brief (always gated by the brief-quality refiner) |
| `loom web` | Open the local dashboard (planning artifacts, live worker output, controls) |
| `loom approve [epic-id]` / `loom reject <epic-id>` | The human gate |
| `loom run [--checkpoint story\|epic] [--verbose]` | Dispatch story agents; automatically resumes any `finalizing`/`publish_pending` epic it encounters before dispatching new work; `--verbose` streams live worker stdout/stderr |
| `loom finalize --resume <epic-id>` | Manually resume a stranded `finalizing` or `publish_pending` epic to `done` without redoing merged work (copy-paste from `loom run`'s skip message) |
| `loom stop` | Halt a run gracefully |
| `loom status [--watch] [--epic <id>] [--all]` | Epic and agent status; `--all` spans every repo |
| `loom publish <epic-id>` | Drive a `publish_pending` or `finalizing` epic to `done`; opens a PR from the pushed ref (`publish_pending`) or resumes the full finalize sequence (`finalizing`) |
| `loom reconcile <epic-id> [--pr <url>]` | Reconcile a stranded `in_progress` (already merged) or `finalizing` epic to `done` |
| `loom revert <epic-id> [--remote]` | Tear down an epic; `--remote` also deletes the upstream branch and PR |
| `loom guide <story-id> "<msg>"` | Append operator guidance to a running worker |
| `loom mcp list / add <name>` | Provision approved MCP servers for worker agents |
| `loom guard check / hook` | Guardrail enforcement (used by the hook) |

Developer-tool binaries (separate from the main `loom` CLI):

| Command | Purpose |
|---|---|
| `loom-bench swe-bench-lite / classify / compare / variance` | SWE-bench Lite runner + analyzers for tuning loom |
| `node scripts/eval.mjs` | Planning eval suite — pass/score report |

---

## How it works

Loom is a TypeScript monorepo: `loom-core` (orchestration), `loom-cli` (the `loom`
command — the usability surface), `loom-web` (the local dashboard — the observability
surface). State lives in the loom-home control plane (auto-created SQLite — no DB
server, no Docker). Worker agents are `claude` CLI sessions (or `cursor-agent`, with
the `cursor-cli` backend) in git worktrees. The skill system learns reusable patterns
from completed work, gated by an eval harness and a candidate→active→disabled lifecycle
— self-healing against skill degradation over time.

Cross-repo: a single brief can span N registered repositories. The cross-repo coordinator
partitions stories into per-repo stages, sorts them topologically so producers land before
consumers, and applies all-ready-or-none staging with forward-revert rollback on failure.
`loom status --all` aggregates every loom repo on the machine, and a per-machine config
(`~/.loom/config.json`) can cap worker concurrency across all of them.

## Documentation

Full docs are published as a MkDocs site under `docs/` and built / served via
the `scripts/docs/` helpers:

```bash
./scripts/docs/serve.sh    # local preview at http://127.0.0.1:8000/
./scripts/docs/deploy.sh   # build + publish to gh-pages (mkdocs gh-deploy)
```

Site layout:

- **[Home](docs/index.md)** — value prop + the 30-second loop.
- **[Getting Started](docs/getting-started/index.md)** — install, first epic, trust ladder.
- **[Use Cases](docs/use-cases/index.md)** — feature add, bug fix, refactor, research-first, multi-product.
- **[Testing](docs/testing/index.md)** — testing philosophy, unit tests, planning eval, SWE-bench Lite bench.
- **[Architecture](docs/architecture/index.md)** — the orchestrator + supervisor + skill loop.
- **[Operations](docs/operations/releasing.md)** — releasing, known limitations, bootstrap notes.

The MkDocs config lives in `mkdocs.yml`.

## Developing loom

For contributors working on loom itself (not customers):

```bash
npm install            # install all workspace packages
npm run build          # build loom-core, loom-cli, loom-web
npm test               # run the full test suite
npm run eval           # run the planning eval suite and score it
```

`npm run eval` runs the bundled planning eval cases through the full planner and prints
a pass/score report — use it when tuning the planner personas. It is session-based by
default (`claude-cli`); each case runs the planner, so a run takes several minutes.
Override with `LOOM_EVAL_BACKEND=anthropic-api` or `LOOM_EVAL_MODEL=<model>`.
