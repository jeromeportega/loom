# Getting Started

Install loom, run your first epic, learn the control loop.

---

## Prerequisites

| Required | Why |
|---|---|
| **Node.js 20+** | loom is a TypeScript app |
| **git 2.5+** | for worktree isolation |
| **The `claude` CLI**, logged in | loom is session-based — uses your Claude Code login, **no API key, no API billing** |
| **`gh`** (GitHub CLI) | agents call it to open PRs |

Optional:

- **`cursor-agent`** — only if you choose the `cursor-cli` worker backend.
- **`uv`** (`brew install uv`) — only for the SWE-bench Lite scoring pipeline.
- **`jq`**, **`curl`** — the bench scripts use them.

Run `loom doctor` at any time to check.

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

Installing loom **globally** matters — worker agents call `loom` for their
guardrail hook. `loom doctor` will warn if it's not on your PATH.

## How to drive loom

Drive loom by running `loom …` commands. Every read command supports `--json`
so an outer agent or script can drive loom by reading structured output — no
persistent server required.

```bash
loom weave "<brief>"              # plan an epic
loom approve <epic-id> --run      # approve and kick off loom run
loom status --json                # poll progress + PR links
loom diff <story|epic-id>         # inspect a story/epic diff
loom review <story-id>            # the reviewer verdict
```

## Your first epic, end to end

```bash
cd your-git-repo
loom doctor                       # check prerequisites
loom init                         # set up .loom/, the guard hook, IDE config

# Plan
loom weave "Add a /health endpoint that returns build info, with a test"
#  → Analyst → PM → Architect personas plan it; a few minutes, headless.

# Review
loom status                       # the planned epic is sitting in 'planned'

# Approve
loom approve epic-001             # release for execution

# Execute — pause after the epic so you can review the PR
loom run --checkpoint epic
```

That's the whole loop. Watch progress with `loom status` or stream live
worker output with `loom run --verbose`.

## What just happened

1. **`loom init`** wrote `.loom/policy.yaml`, the guard hook in
   `.claude/settings.json`, a managed `.gitignore` block, and registered this
   repo in the workspace manifest (`<loom-home>/workspace.yaml`).
2. **`loom weave`** ran the planning pipeline (Analyst → PM → Architect)
   against your brief and stored the output (brief, PRD, architecture doc,
   epic YAML) in the loom-home control plane — not in your target repo.
3. **`loom approve`** marked the epic as ready for execution.
4. **`loom run --checkpoint epic`** dispatched story agents (`claude` CLI
   in isolated git worktrees), each implementing one story, writing tests,
   and pushing their commits. A single-repo epic produces one pull request.
   A cross-repo epic produces one pull request per repository, landed in
   topological (dependency) order with all-ready-or-none staging and
   forward-revert rollback.
5. Delivered artifacts live in the loom-home control plane; target repositories
   receive only code pull requests.

## You stay in control

loom is autonomous, not unsupervised. Know your brakes:

- **Structural guardrails.** Destructive commands are blocked by the policy
  engine and git worktree isolation — enforced at the OS level.
- **`loom stop`** halts a run gracefully; in-flight stories finish, no more
  dispatch. Resume with `loom run`.
- **Checkpoints.** `--checkpoint story` pauses after each story; `--checkpoint
  epic` pauses after each epic. New to loom? Start with `--checkpoint epic`.
- **The human gate.** Nothing executes until you `loom approve` the plan.

## Trust ladder

Tighten or loosen as you learn to trust the system:

| Mode | Command | When |
|---|---|---|
| Strictest | `loom weave … && loom approve … && loom run --checkpoint story` | First few epics; review every story PR before the next dispatches |
| Default | `loom weave … && loom approve … && loom run --checkpoint epic` | Pause after each epic; review the bundled PR |
| Loosest | `loom weave … && loom approve … && loom run` | Plan → approve → let the whole queue run. Best once you've calibrated. |

## Where loom writes things

| Path | What | Tracked? |
|---|---|---|
| `<loom-home>/repos/<slug>/loom.db` | SQLite state (auto-migrated from `.loom/loom.db` on first upgrade) | No (gitignored in loom-home) |
| `<loom-home>/repos/<slug>/planning/` | Planning artifacts — brief, PRD, architecture, epic YAML (auto-migrated from `.loom/planning/`) | No (gitignored in loom-home) |
| `<loom-home>/repos/<slug>/<epic-id>/` | Delivered artifact record committed to loom-home | In loom-home, not target repo |
| `.loom/worktrees/` | Per-story git worktrees | No |
| `.claude/settings.json` | Guard hook config | Per-machine; regenerable via `loom init` |
| `.cursor/mcp.json` | Cursor worker MCP provisioning config | Per-machine; regenerable |

`loom init` writes a managed `.gitignore` block that handles this — don't
hand-edit inside the markers.

## loom-home — the control plane

Loom stores all planning artifacts and the state database outside your target
repo in a dedicated **loom-home** git repository. By default this is a sibling
directory to your project root (e.g. `~/repos/app` → `~/repos/loom-home`).
Override the location with `loom_home: ~/path/to/loom-home` in
`.loom/policy.yaml`.

The **workspace manifest** (`<loom-home>/workspace.yaml`) records every repo
registered with this loom installation — slug, absolute path, and git remote
URL. It is the committed source of truth for which repos loom tracks.

`loom init` registers the current repo in the manifest automatically. If you
previously ran loom before loom-home was introduced, run:

```bash
loom migrate           # ensures loom-home exists, migrates DB + planning scratch, registers repo
loom migrate --dry-run # preview what would be migrated without touching anything
```

Re-running `loom migrate` is idempotent — an already-migrated repo reports
"nothing to do". Net-new installs can ignore `loom migrate` entirely; their
first `loom run` triggers the same migration automatically.

## Monitoring cost with `loom cost`

```bash
loom cost                      # recent runs with per-phase cost, token, and wall-time detail
loom cost --epic <epic-id>     # scope to one epic
loom cost --aggregate          # cross-run statistics: median planning cost, retry totals
loom cost --json               # machine-readable output
```

`loom cost` is strictly read-only and never triggers orchestration.

## Stall recovery

Loom automatically retries stalled workers (default: up to 2 clean retries per
story, controlled by `policy.agents.stall_recovery_budget`). Recovered stories
appear as `(recovered N)` in `loom status`. Set `stall_recovery_budget: 0` to
disable clean retry and require manual `loom retry <story-id>` on every stall.

## Standalone stories

For a small, self-contained change that doesn't warrant a full multi-story
epic, use `loom weave` with intake routing enabled:

```bash
# .loom/policy.yaml: agents.intake_routing: advisory
loom weave "Fix the typo in the footer component"
```

When the intake classifier scores the brief as `story`-sized, loom takes a
lightweight path — a single Analyst call followed by one `StandaloneStoryAgent`
call, with no PM/PRD step and no epic decomposition. The result is a
single-story container with a `story-NNN` id. Every downstream command —
`loom approve`, `loom run`, `loom status`, `loom artifacts` — accepts
`story-NNN` directly.

## Config hierarchy at a glance

Loom composes one effective policy from three layers in fixed precedence order:

```
loom-home team config (base)  ←  target-repo policy.yaml (override)  ←  env vars (secrets / final override)
```

See [Configuration](../configuration.md) for full merge semantics, env variable
naming, and guard-list rules.

## Watching a run — `loom web`

For visibility into a running supervisor, launch the web dashboard:

```bash
loom web                # opens http://127.0.0.1:<port>/#token=... in your browser
loom web --no-open      # skip auto-opening; copy the printed URL yourself
loom web --port 9000    # bind a specific port
```

The server is **localhost-only**. A fresh random token is generated each
launch and embedded in the URL fragment; the frontend stashes it in
`sessionStorage` so refresh works within the same tab.

**Common gotcha:** if you re-launch `loom web` in a new terminal and
then refresh an *old* tab, you'll get a 401 — the old tab's token is
stale. Open the URL the latest terminal printed.

**Lost the URL?** Tokens are not persisted server-side. Stop the server
(`Ctrl-C`), re-launch, use the new URL.

## Next

- [Use cases](../use-cases/index.md) — which pathway fits your work.
- [Configuration](../configuration.md) — three-layer config resolver, env variables, guard merge semantics.
- [Testing](../testing/index.md) — when to run each pipeline, what each one tells you.
- [Architecture](../architecture/index.md) — the orchestrator, the supervisor, the skill loop.
