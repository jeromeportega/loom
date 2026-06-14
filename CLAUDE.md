# Loom — Claude Code Context

This is the **loom** repository: an open-source, self-learning, multi-agent engineering system.

## Project Structure

```
packages/loom-core/   — orchestration engine (planner, supervisor, guardrails, skills, state)
packages/loom-cli/    — CLI commands — the PRIMARY loom surface (init, epic, approve, run, status, diff, review, artifacts, traces, audit, autonomy)
packages/loom-mcp/    — optional MCP server for Claude Code / Cursor (opt in with `loom init --mcp`; the CLI is primary)
packages/loom-web/    — local web dashboard (Express + vanilla JS frontend)
skills/                — built-in loom skills (agentskills.io format)
schemas/               — epic.schema.yaml, policy.schema.yaml
docs/                  — MkDocs site (architecture, testing, runbooks)
epics/                 — loom's own delivered epics (planning artifacts)
.claude/skills/        — loom slash commands + vendored planning skills for Claude Code
.agents/skills/        — same for Cursor
```

## Tech Stack

- TypeScript / Node.js 20+
- Anthropic SDK (`@anthropic-ai/sdk`) with prompt caching
- `@modelcontextprotocol/sdk` for MCP server
- `better-sqlite3` for state (agents, audit_log)
- `commander` for CLI, `zod` for schema validation

## Development Commands

```bash
npm install          # install all workspace packages
npm run build        # build all packages
npm run test         # run tests across all packages
loom init           # (after build) initialize loom in a test repo
loom serve          # start the MCP server
```

## Key Invariants

1. **Policy engine is structural**: `loom guard check` must exit non-zero for any forbidden command regardless of LLM output.
2. **Agents never push to protected branches**: enforced by both policy engine and worktree isolation.
3. **Prompt caching must be applied** on persona system prompts and shared skill context.
4. **Skills follow agentskills.io format**: name (lowercase + hyphens), SKILL.md frontmatter required.
5. **All agent actions are logged** to audit_log table before returning to the caller.

## Capabilities page must stay current

**When you add, remove, or meaningfully change a user-visible feature, update `docs/capabilities.md` in the same PR.** That page is the single source of truth for what loom does today — GitHub release notes alone are insufficient. Specifically:

- New CLI subcommand → add a row to the relevant table in `docs/capabilities.md`.
- New MCP tool → add a row noting both CLI and MCP forms.
- New user-visible policy knob → add a row.
- Capability previously listed under "What loom does NOT do" now ships → move it into the appropriate table and delete its NOT-do entry.
- Capability removed → delete its row.

Treat the capabilities page like a public API surface: never out of date, always reflects what an operator can do with the version on `main`.

## Planning personas

Loom bundles four planning personas (in `packages/loom-core/personas/`),
invoked by `loom epic` in sequence:

- **Mary** — Business Analyst (brief refinement)
- **John** — Product Manager (PRD + epic/story breakdown)
- **Winston** — System Architect (architecture + technical guidance)
- **Amelia** — Senior Software Engineer (worker prompt template)

These run headless; the persona files are loom's own definitions tuned
for unattended operation.
