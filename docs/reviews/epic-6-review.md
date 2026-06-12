---
title: "Epic 6 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 6 Review: IDE Integrations

Reviewing the expanded `loom init` (Claude Code hook, `.mcp.json`, `CLAUDE.md`, slash
commands) and the status-dashboard title fix. This is the last epic of the original
6-epic plan.

## Findings

### High — fixed in this pass (the Epic 3 carryover)

**1. The guardrail hook no longer depends on `loom` being on PATH.**
- Epic 3's top finding: if `loom` is not on the worker's PATH, the PreToolUse hook
  command (`loom guard hook`) cannot execute and workers run **unguarded**.
- **Fix**: `loom init` now writes the hook as `node "<absolute dist/index.js>" guard
  hook`, captured from `process.argv[1]`. The `.mcp.json` / `.cursor/mcp.json` server
  commands use the same absolute invocation. Verified end-to-end — the absolute-path
  hook still returns exit 2 and blocks `git push --force`.
- Residual: the absolute path goes stale if loom is moved/reinstalled. Documented —
  the fix is to re-run `loom init`.

### Medium — documented

**2. Slash commands assume the MCP server is connected.**
- The `/loom-*` skills instruct Claude to call `loom_*` MCP tools (with a CLI
  fallback). If a user copied the skills without `.mcp.json`, the tools are absent.
  `loom init` writes both, so a normal init is consistent — but a partial setup could
  drift. Low likelihood; documented.

**3. `loom init` writes more files into the user's repo.**
- `.mcp.json`, `CLAUDE.md`, and `.claude/skills/loom-*` are now created. All are
  idempotent (existing files are not overwritten — verified for `CLAUDE.md`), and all
  are normal, reviewable, committable files. But `loom init` is now a bigger footprint
  than "just `.loom/`." This is intended (the IDE integration *is* the epic) and
  documented in the runbook.

### Low — minor

**4. `.mcp.json` for Claude Code vs. project-scope assumptions.**
- loom writes a project-root `.mcp.json`. Claude Code reads project-scoped MCP servers
  from there. If a host project already uses a different MCP convention, the merge
  logic (`upsertMcpServer`) adds the `loom` entry without disturbing others — but the
  exact Claude Code project-MCP discovery path should be confirmed against the current
  Claude Code release during real-world use.

**5. Slash commands are not validated as agentskills.io skills.**
- The generated `loom-*` SKILL.md files have `name`/`description` frontmatter and the
  name matches the directory — but `loom init` does not run them through the same
  validation `SkillStore`/`SkillGenerator` apply. They are static, hand-authored, and
  correct; a validation pass would be belt-and-suspenders.

## What's solid

- **The PATH fix closes the Epic 3 security gap.** This was the most important
  outstanding finding in the whole project — workers running `bypassPermissions` with
  a hook that silently fails to execute. The absolute-path invocation makes the
  structural guardrail actually structural.
- **One merge helper, two IDEs.** `upsertMcpServer` handles `.mcp.json` and
  `.cursor/mcp.json` identically — add loom, never clobber existing servers.
- **Idempotent throughout.** Re-running `loom init` skips every existing file with a
  clear message; a user's own `CLAUDE.md` is never overwritten (tested).
- **Real story titles.** A small schema migration (v2, `agents.story_title`) means
  `loom status` and `loom_get_status` show "story-001-002 — Add the login endpoint"
  instead of a bare id. The migration is guarded (`PRAGMA table_info`) so existing DBs
  upgrade cleanly.
- **Session-based by default end-to-end.** Combined with the session-based LLM backend,
  a fresh `loom init` → `loom epic` → `loom run` needs no API key at any point.

## Plan status

Epic 6 completes the original 6-epic plan. All six epics are delivered, tested
(180 tests), and reviewed. Epic 7 (Eval & Safety) is the agreed follow-on — its
foundation decision is pending the Ruflo evaluation.
