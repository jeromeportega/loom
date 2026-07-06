# Guard Hook Runbook

How the loom policy guard works, when it fires, and what operators see vs. what workers see.

---

## Overview

`loom guard hook` is the Claude Code `PreToolUse` hook that enforces policy before any shell command or file-read tool runs. It is installed automatically by `loom init` into `.claude/settings.json`.

`loom guard check --command "<cmd>"` is the manual test variant — it runs the same policy evaluation and exits non-zero if the command would be blocked.

---

## What the guard enforces

### Write and git rules (all sessions)

Applied to every `Bash` tool call, regardless of whether the caller is a worker or an operator:

- Force-push (`git push --force`, `-f`)
- `git reset --hard`
- Command chaining (`&&`, `;`, `$(...)`)
- Backgrounding (`trailing &`, `a & b`)
- Forbidden file writes (paths matching `policy.filesystem.protected_paths`)
- Forbidden git flags (`policy.git.forbidden_flags`)
- Protected branch pushes (`policy.git.protected_branches`)
- Writes outside `policy.filesystem.allowed_write_root`

These rules protect the repository from destructive operations. They fire for anyone running through a loom-guarded Claude Code session.

### Read-scope rules (worker sessions only)

`Read`, `Grep`, `Glob`, and common Bash search commands (`grep`/`rg`/`find`/`cat`/`ls`) are restricted to two zones:

- The worker's own worktree.
- The path resolved by `policy.filesystem.allowed_read_root` (default `.`, relative to the worktree).

**This enforcement is scoped to worker sessions.** The guard exits immediately (exit 0, no policy check) when the calling process is not in a worker context. Operator sessions — a developer's own Claude Code session, `loom guard check`, or any process not spawned by the loom supervisor — are never blocked by read-scope policy.

---

## Worker context detection

The guard uses two checks to identify a worker session:

1. **Structural (primary):** the hook process's CWD resolves to a path under `.loom/worktrees/`. Every story agent runs in an isolated worktree at `.loom/worktrees/<story-id>/`, so this check is structurally accurate.

2. **Env marker (defense-in-depth):** the `LOOM_WORKER_CONTEXT=1` environment variable, set by the loom supervisor at worker spawn. Used as a fallback when the CWD check alone is ambiguous (e.g. a worker that has `cd`'d outside its worktree).

When neither check triggers, the guard is not in a worker context and exits 0 for read-scope without inspection.

> **Operator pass-through:** if you run Claude Code in your project directory (not inside a loom worktree), the guard never blocks your reads. Only write/git rules apply to your session.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Tool call allowed |
| `1` | Blocked (generic; used by `loom guard check`) |
| `2` | Blocked; reason printed to stderr as Claude-readable feedback (used by the hook) |

Exit code 2 causes Claude Code to abort the tool call and show the block reason to the model so it can adjust its approach.

---

## Checking a command manually

```bash
loom guard check --command "git push --force"
# exits 1, prints the block reason as JSON

loom guard check --command "git push origin main"
# exits 0 (allowed, assuming main is not in protected_branches)
```

---

## Policy configuration

```yaml
# .loom/policy.yaml
git:
  protected_branches: [main, master, release/*]
  forbidden_flags: [--force-with-lease]
  allowed_remotes: [git@github.com:myorg/*]

filesystem:
  allowed_write_root: "."
  allowed_read_root: "."    # default; resolved relative to the worktree
  protected_paths: [".env", "*.pem"]
```

Read-scope (`allowed_read_root`) only restricts worker sessions; see above.

---

## Audit trail

Every evaluated command is written to the audit log:

| Action | When |
|---|---|
| `bash_command` | Every `Bash` tool call through the hook (allowed or blocked) |
| `read_scope_denied` | A `Read`/`Grep`/`Glob` call blocked by read-scope (worker only) |

```bash
loom audit --story <story-id>     # read-scope events for a specific story
loom audit                         # all guard events
```

---

## Common issues

### "loom blocked this command: && command chaining is not permitted"

Split the command into separate calls. Command chaining is blocked because it bypasses per-command policy checks — loom cannot evaluate `cmd1 && cmd2` as two independent commands.

### Worker can read my home directory

Check whether `policy.filesystem.allowed_read_root` is set to something broader than `.`. The default (`.`) resolves to the worktree root and restricts reads to the worktree. Setting it to `..` or `/home/user` would widen the scope.

Also: interpreters (`python -c`, `node -e`) and shell redirection (`< file`) are not covered by the hook — those require an OS-level sandbox. See `docs/operations/known-limitations.md`.

### Guard is blocking my operator Claude Code session

This should not happen for read-scope (operator sessions pass through). If it does, verify that your Claude Code session is not running from inside a `.loom/worktrees/` path and that `LOOM_WORKER_CONTEXT` is not set in your shell environment.

Write/git rules apply to all sessions by design — if a write command is blocked, it is blocked for workers and operators alike.
