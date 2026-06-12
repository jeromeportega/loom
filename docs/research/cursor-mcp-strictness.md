---
title: "cursor-agent MCP strictness — config precedence, per-project disable durability, and the residual allowlist gap"
status: accepted
research_type: technical
date: 2026-06-11
author: loom
spike_completed: 2026-06-11
---

# cursor-agent MCP strictness

## Research overview

The claude-code backend can be handed a strict, self-contained MCP allowlist:
`claude --strict-mcp-config --mcp-config <file>` makes the worker see *exactly*
the servers in that file and nothing inherited from user or project config. The
cursor-cli backend (`cursor-agent`) has **no equivalent flag**. This spike
establishes how `cursor-agent` actually resolves MCP configuration and whether
its `mcp disable` state is durable and worktree-scoped, so that loom can build
the next-best enforcement — enumerate every visible server and headlessly
disable the ones outside the allowlist — on verified ground rather than
assumption.

Architecture decision **ADR-2 gates this story on the spike**: if
`cursor-agent mcp disable` turned out to be *user-global* (mutating shared
state across all of a developer's projects), the enumerate-and-disable design
would be unsafe and would have to change before any wiring. It does not — the
findings below clear that gate.

## Method

All probes ran against the developer's real `cursor-agent`
(`cursor-agent --version` present on `PATH`) in throwaway git repositories under
`/tmp` and in the loom worktree, never against committed state. The user-global
config (`~/.cursor/mcp.json`) was checksummed before and after every probe and
confirmed byte-identical at the end. Any server toggled during probing was
restored to its original state.

## Findings

### 1. Config layers are MERGED, not overridden (precedence)

`cursor-agent` composes the server list from **both**:

- the user-global file `~/.cursor/mcp.json`, and
- the project-local file `<repo>/.cursor/mcp.json`.

A project that ships its own `.cursor/mcp.json` does **not** suppress the
user-global servers — `cursor-agent mcp list` in that project returns the union
of both layers. Verified directly: a temp repo whose only project config
declared a single `proj-only` server still listed all six user-global servers
*plus* `proj-only`.

**Consequence for loom.** Materializing an allowlist-only
`<worktree>/.cursor/mcp.json` (story-002-001) is *necessary but not
sufficient* on the cursor-cli backend. Because the project file is additive,
every user-global server a developer happens to have configured
(`jira-mcp`, `team-mcp`, internal tooling, etc.) remains visible to a
cursor-cli worker unless it is explicitly disabled. This is the entire reason
story-002-002 exists.

### 2. `mcp disable` is per-project and durable (the ADR-2 gate)

`cursor-agent mcp disable <name>` records the disabled set in a **per-project**
state file, keyed by the project's git-root path:

```
~/.cursor/projects/<project-slug>/mcp-disabled.json   # JSON array of server names
```

Verified properties:

- **Per-project, not user-global.** Disabling a server while `cwd` is one
  worktree does not change its status in a different directory, and never
  mutates `~/.cursor/mcp.json`. A second checkout of the same code at a
  different path is a different project slug and is unaffected.
- **Durable across invocations.** The disabled state persists between separate
  `cursor-agent` runs in that project — a server disabled by setup stays
  disabled for the worker spawned afterward in the same worktree.
- **Idempotent.** Re-disabling an already-disabled server is a harmless no-op.

This is exactly the property the enumerate-and-disable design needs, and it
clears the ADR-2 gate: enforcement mutates only worktree-scoped state, so two
loom worktrees (distinct paths → distinct slugs) cannot clobber each other and
the developer's own projects are untouched.

### 3. `mcp list` output shape

`cursor-agent mcp list` prints one server per line in `name: status` form, e.g.

```
team-mcp: not loaded (needs approval)
jira-mcp: ready
loom: ready
```

The enforcer parses the leading `name` token before the first colon and ignores
any line that does not match that shape (headers, blank lines, banners), so
unparseable or empty output yields an empty server list rather than a crash.

## The residual strictness gap (cannot be closed headlessly)

Even with enumerate-and-disable wired in, the cursor-cli backend is **weaker**
than the claude-code backend in two ways that no amount of loom code can close
from the outside:

1. **Denylist, not allowlist.** We disable the servers we *can see at setup
   time*. There is no `cursor-agent` flag that says "trust only this file." The
   guarantee is "every server visible when the worktree was prepared and not on
   the allowlist has been disabled," not "the worker can structurally only ever
   see the allowlist."
2. **Race window.** A server added to user-global config *after* `mcp list`
   runs but *before* the worker spawns would not be caught by that setup pass.
   The window is small (setup and spawn are back-to-back in
   `Supervisor.dispatch`), but it is non-zero. This is inherent to
   enumerate-then-act and is **documented, not closed**.

Servers that are enumerated but cannot be disabled headlessly (the `disable`
call exits non-zero, prompts, or hangs) are **recorded** in
`CursorEnforceResult.gaps` and surfaced in the `worker_mcp_servers` audit row —
never thrown. Enforcement is best-effort and observable, not fail-closed.

## Upstream ask (out of scope for this epic)

The clean fix lives in `cursor-agent`, not loom: a
**`--strict-mcp-config` / `--mcp-config <file>` equivalent** that makes a
cursor-cli worker see exactly the servers in a supplied file and ignore both the
user-global and project layers — matching `claude`'s strict mode. With that
flag, loom would drop enumerate-and-disable entirely and hand cursor-cli the
same materialized allowlist file it hands claude-code, closing both the
denylist and the race-window gaps structurally.

Filing and tracking that request is **explicitly out of scope** for epic-002.
This document is the record of the ask; `docs/capabilities.md` (story-002-005)
should reflect the cursor-cli backend's best-effort strictness against this
baseline.
