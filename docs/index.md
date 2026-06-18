# loom

**An open-source, self-learning, autonomous agentic engineering system.**

Write a one-paragraph brief. Approve the plan. Agents deliver the epic —
planning, implementation, tests, and pull requests — while you stay in control.

---

## What loom changes

AI coding tools today make a developer faster keystroke by keystroke. Loom
changes the unit of work: you delegate an **entire epic** and supervise the
outcome.

Write a paragraph describing what you want. Loom plans it — analyst,
product-manager, and architect personas turn the brief into a PRD, an
architecture, and a set of stories. You approve the plan. A supervisor then
dispatches story agents that each work in an isolated git worktree, write
code and tests, and open pull requests. You review the PRs.

**Two human touchpoints: the brief and the approval.**

## The 30-second loop

```bash
loom init                                                # in your git repo
loom epic "Add a /health endpoint that returns build info, with a test"
loom approve epic-001
loom run --checkpoint epic
loom status
```

## Why it's worth stepping away from the keyboard

| Principle | How loom does it |
|---|---|
| **Delegation, not autocomplete** | The unit of work is the epic, not the keystroke. The bottleneck moves from typing speed to describing intent. |
| **Senior review at every story** | The Supervisor injects curated skills (code-review, edge-case review, UX-design, etc.) into each worker as it implements. |
| **Structural guardrails** | A policy engine blocks destructive commands (force-push, `git reset --hard`, etc.) at the OS level — not by asking the model to behave. |
| **Worktree isolation** | Every story runs in its own git worktree. Agents physically cannot touch your main branch; they open PRs you review. |
| **It learns without drifting** | Loom extracts new skills from completed work; a candidate→active→disabled lifecycle stops a bad skill from degrading the system. (The lifecycle runs internally; there is no user-facing skill-management surface today.) |
| **Auditable** | Every agent action — every command, every status change — is logged to a local SQLite database you can query. |
| **No API billing by default** | The `claude-cli` and `cursor-cli` backends use your existing Claude Code / Cursor login. Delivering an epic costs no metered tokens. |

## Where to go next

- **[Getting Started](getting-started/index.md)** — install, first epic, the run loop.
- **[Use Cases](use-cases/index.md)** — concrete pathways (feature add, bug fix, refactor, multi-product).
- **[Testing](testing/index.md)** — what loom tests and what it deliberately doesn't.
- **[Architecture](architecture/index.md)** — the orchestrator, the supervisor, the skill loop.
- **[Operations](operations/releasing.md)** — releasing, known limitations, bootstrap notes.

---

## How loom is built

TypeScript monorepo: `loom-core` (orchestration), `loom-cli` (the `loom`
command — CLI is the usability surface), `loom-web` (local dashboard —
the observability surface). SQLite for state (`.loom/loom.db`, auto-created — no
DB server, no Docker). Worker agents are `claude` CLI sessions (or `cursor-agent`)
in git worktrees. The skill system learns reusable patterns from completed work,
gated by an eval harness and a candidate→active→disabled lifecycle.

Beyond a single repo: `loom status --all` aggregates every loom repo on the
machine, and a per-machine config can cap worker concurrency across all of
them so several products do not exhaust your Claude session at once.
