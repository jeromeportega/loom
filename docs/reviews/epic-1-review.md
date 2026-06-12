---
title: "Epic 1 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 1 Review: Core Engine

Reviewing loom-core (types, state, guardrails) and loom-cli (init, guard, status) with an eye toward downstream impact on Epics 2–6. Goal: ship clean, not perfect. Fix what blocks downstream work; document the rest.

## Findings

### Critical — must fix before Epic 3 (story dispatch)

**1. Claude Code PreToolUse hook protocol is wrong.**
- `init.ts` writes hook `command: loom guard check --command "$TOOL_INPUT_COMMAND"`.
- `$TOOL_INPUT_COMMAND` is not a Claude Code env var. Claude Code passes tool input via stdin as JSON: `{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "..."}}`.
- **Impact**: every worker-agent Bash call would be evaluated as `loom guard check --command ""` → always allowed → guardrails fail open. Story dispatch agents would be unprotected.
- **Fix**: Add `loom guard hook` subcommand that reads stdin JSON, extracts `tool_input.command`, runs the policy check, and exits 0/2 per Claude Code's hook protocol.

**2. Command chaining bypass.**
- `git push --force;` is not blocked. The shell splitter treats `--force;` as one token; flag check looks for exact `--force`, doesn't match `--force;`.
- Test: `parseCommand('git push --force;').flags === ['--force;']` → not in `forbidden_flags`.
- **Impact**: a worker agent could simply append `;` to any forbidden flag and bypass the rule.
- **Fix**: Reject commands containing any shell metacharacter (`;`, `&&`, `||`, `&`, backticks, `$(`, `$()`). The agent should issue separate Bash calls instead.

**3. Wrapper command bypass.**
- `bash -c "git push --force"` and `eval "git push --force"` are evaluated as program=`bash` or `eval`. The git-specific checks never fire. Filesystem heuristic catches paths but not flags.
- **Impact**: trivial bypass for any forbidden git operation.
- **Fix**: Reject commands whose program is `bash`, `sh`, `zsh`, `eval`, or `exec`. (Same fix as #2 — both go in `PolicyEngine` as a pre-check before the program-specific logic.)

### High — should fix before declaring Epic 1 done

**4. `loom status --watch` doesn't exit on terminal status.**
- PRD: "exits when all stories reach terminal status (done/failed)". Current code runs setInterval forever; user has to Ctrl+C.
- **Fix**: After each render, check if all agents in all epics are in terminal status (`done` or `failed`); if so, clearInterval and exit 0.

**5. Hook idempotency is too lax.**
- `writeClaudeHook` checks if *any* hook with `matcher: 'Bash'` exists and skips. This means if the user has an unrelated Bash hook (e.g., a linter), loom won't add its own.
- **Fix**: Check whether a hook's nested `hooks[].command` starts with `loom guard`. Only skip if the loom hook is already there.

### Medium — downstream impact, fix opportunistically

**6. `AgentStore` carries Epic CRUD.**
- The class name says "AgentStore" but it manages both epics and agents. As Epic 2 adds epic-status transitions and Epic 3 adds story-level queries, this will grow muddy.
- **Recommendation**: Split into `EpicStore` and `AgentStore` now while it's two methods each. Cheap refactor; will be expensive in Epic 3.

**7. Default policy YAML duplicates schema defaults.**
- `DEFAULT_POLICY_YAML` in `init.ts` is a hand-written string. The same defaults live in `PolicySchema` zod definitions.
- **Risk**: when we add a new policy field, we have to update both. Drift bug waiting to happen.
- **Defer**: Acceptable for MVP. Add a TODO comment to regenerate from zod when fields stabilize.

### Low — polish, defer

**8. Module-level DB singleton.**
- `_db: Database | null` in `Database.ts` makes the database global per process. Fine for the CLI; would be a problem if loom ever ran multiple repos in one process. Not relevant to MVP.

**9. `loom status` only shows the latest agent per story.**
- `getAgentByStory` returns the most recent; if a story failed and was retried, only the new attempt is visible.
- **Defer**: Show retry history later if needed; current behavior is correct for the common case.

**10. Parser edge case: pre-subcommand flags.**
- `git -c user.name=foo commit ...` would identify `-c` as a flag and `user.name=foo` as a positional arg, then `commit` as the subcommand. Works correctly for our checks today but is fragile.
- **Defer**: Note as known limitation; revisit if it causes false positives in Epic 3.

## Downstream impact matrix

| Finding | Epic 2 (Planning) | Epic 3 (Dispatch) | Epic 4 (MCP) | Epic 5 (Skills) | Epic 6 (IDE) |
|---|---|---|---|---|---|
| #1 hook protocol | — | **BLOCKING** | — | — | **BLOCKING** |
| #2 chaining bypass | — | **BLOCKING** | impact | — | impact |
| #3 wrapper bypass | — | **BLOCKING** | impact | — | impact |
| #4 watch exit | — | UX bug | — | — | — |
| #5 hook laxness | — | minor | — | — | minor |
| #6 store split | minor (add methods) | yes (more queries) | minor | — | — |
| #7 policy dup | — | — | — | — | — |
| #8 db singleton | — | — | — | — | — |
| #9 retry history | — | observability gap | — | — | — |
| #10 parser edge | — | rare FP | rare FP | — | — |

## Action plan

**Fix in this pass** (this branch, before Epic 2):
- #1: Add `loom guard hook` (stdin JSON protocol); update `init.ts` to write the correct hook command.
- #2 + #3: Add metacharacter / wrapper-program guard to `PolicyEngine`.
- #4: Add terminal-status exit to `loom status --watch`.
- #5: Tighten hook idempotency check.
- #6: Split `AgentStore` → `EpicStore` + `AgentStore`.

**Document and defer:**
- #7, #8, #9, #10 — record in `docs/known-limitations.md` and add TODO comments inline.

## What's solid

Worth calling out — these landed clean:

- **Schema-first design with zod**: `PolicySchema`, `EpicYamlSchema`, `StorySchema` all derived from zod. Runtime validation + TS types from one source. Will pay off in Epic 2 when planner outputs need validation.
- **FTS5 audit log**: trigger-driven full-text search on `audit_log(command, action)`. Will let Epic 5 do cheap pattern detection without pulling every row.
- **Idempotent state migrations**: `IF NOT EXISTS` everywhere; safe to re-run forever.
- **MCP scaffold with all 7 tools registered**: even the unimplemented ones return structured `{status: "not_implemented"}` so client code can be written against the contract today.
- **Test isolation via tmpdir**: integration tests don't pollute the dev environment; FTS5 search confirmed working end-to-end.
- **Zero `any` casts in production code**: `unknown` + type guards / zod parsing throughout. Will scale.
