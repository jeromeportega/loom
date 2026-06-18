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
loom epic "<brief>"               # plan an epic
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
loom epic "Add a /health endpoint that returns build info, with a test"
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

1. **`loom init`** wrote `.loom/policy.yaml`, the SQLite state DB, a Claude
   Code `PreToolUse` guard hook in `.claude/settings.json`, and a managed
   `.gitignore` block.
2. **`loom epic`** ran the planning pipeline (Analyst → PM → Architect)
   against your brief. Output: a project brief, PRD, architecture doc, and
   a machine-readable epic YAML in `.loom/planning/epic-001/`.
3. **`loom approve`** marked the epic as ready for execution.
4. **`loom run --checkpoint epic`** dispatched story agents (`claude` CLI
   in isolated git worktrees), each implementing one story, writing tests,
   and pushing their commits. On success, the EpicFinalizer merges all story
   branches into `epic/epic-001` and opens **one PR** for the whole epic.
5. The artifacts that mattered (brief, PRD, architecture, epic YAML) get
   committed into `.loom_outputs/epic-001/` on the epic branch — a durable,
   reviewable record of what was planned and delivered.

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
| Strictest | `loom epic … && loom approve … && loom run --checkpoint story` | First few epics; review every story PR before the next dispatches |
| Default | `loom epic … && loom approve … && loom run --checkpoint epic` | Pause after each epic; review the bundled PR |
| Loosest | `loom epic … && loom approve … && loom run` | Plan → approve → let the whole queue run. Best once you've calibrated. |

## Where loom writes things

| Path | What | Tracked? |
|---|---|---|
| `.loom/loom.db` | SQLite state | No (per-machine) |
| `.loom/worktrees/` | Per-story git worktrees | No |
| `.loom/planning/<run>/` | In-progress planning artifacts | No (working dir) |
| `.loom_outputs/<epic>/` | Delivered planning record (brief / PRD / architecture / epic.yaml) | **Yes** — committed on the epic branch |
| `.claude/settings.json` | Guard hook config | Per-machine; regenerable via `loom init` |
| `.cursor/mcp.json` | Cursor worker MCP provisioning config | Per-machine; regenerable |

`loom init` writes a managed `.gitignore` block that handles this — don't
hand-edit inside the markers.

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
- [Testing](../testing/index.md) — when to run each pipeline, what each one tells you.
- [Architecture](../architecture/index.md) — the orchestrator, the supervisor, the skill loop.
