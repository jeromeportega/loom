---
title: "Loom — Product Requirements Document"
status: approved
version: "1.0"
created: 2026-05-22
updated: 2026-05-22
brief_ref: "../project-brief/brief.md"
stepsCompleted:
  - validate-prerequisites
  - define-goals
  - user-stories
  - functional-requirements
  - non-functional-requirements
  - epics-overview
---

# Product Requirements Document: Loom

## 1. Introduction / Overview

Loom is an open-source, self-learning, multi-agent engineering system that lets a developer write a one-paragraph brief and then step back while autonomous agents handle all subsequent planning (Analyst → PM → Architect), execution (parallel story agents), and self-improvement (skill generation). The developer is involved only at two points: writing the initial brief and approving the generated plan. After approval, agents execute the full epic and open pull requests.

**Problem statement**: Modern AI coding tools (Cursor, Claude Code) can write code, but no open-source tool provides the full pipeline from brief → plan → autonomous execution with structural guardrails, cross-IDE support, and self-learning.

## 2. Goals

| ID | Goal | Metric |
|---|---|---|
| G-1 | Reduce time from brief to first mergeable PR | <30 min for a simple story, unattended |
| G-2 | Require zero setup beyond `loom init` | Setup completes in <2 min on fresh repo |
| G-3 | Prevent destructive agent actions structurally | 100% block rate on force-push, rm -rf OOB paths in CI |
| G-4 | Support Cursor and Claude Code | Both IDEs connect to same loom-mcp engine |
| G-5 | Enable self-improvement | At least 1 auto-generated skill per novel story pattern |
| G-6 | Open source, local-first | No SaaS dependency; works fully offline except LLM API |

## 3. User Stories

### Developer workflow

| ID | As a... | I want to... | So that... | Priority |
|---|---|---|---|---|
| US-1 | Developer | Write a one-line brief and have agents produce a structured PRD and epics | I don't have to manually write planning docs | Must Have |
| US-2 | Developer | Approve or reject the generated plan before any code is written | I retain control of scope and approach | Must Have |
| US-3 | Developer | See real-time status of all running story agents | I know what's happening without querying agents individually | Must Have |
| US-4 | Developer | Receive a pull request per story, not a direct push to main | I review code before it lands | Must Have |
| US-5 | Developer | Configure which repos agents can push to and which branches are protected | I prevent agents from touching production | Must Have |
| US-6 | Developer | Use loom from Cursor (my daily IDE) via MCP | I don't need a separate terminal/app | Must Have |
| US-7 | Developer | Use loom from Claude Code | I can run loom in claude-code sessions | Must Have |
| US-8 | Developer | Have agents discover and reuse skills they've learned from prior work | Agents get better over time without manual tuning | Should Have |
| US-9 | Developer | Block specific filesystem paths from agent writes | I protect SSH keys, AWS credentials, OS dirs | Must Have |
| US-10 | Developer | Download and run loom on any git repo | I'm not locked into a cloud service | Must Have |

### Team lead workflow

| ID | As a... | I want to... | So that... | Priority |
|---|---|---|---|---|
| TL-1 | Team lead | Commit a policy.yaml to a repo | All agents on the team use the same guardrails | Must Have |
| TL-2 | Team lead | Review the audit log of all agent actions | I have an audit trail for compliance | Should Have |
| TL-3 | Team lead | Limit concurrent agent count | I control API cost and resource usage | Should Have |

## 4. Functional Requirements

### FR-1: Initialization

- `loom init` creates `.loom/policy.yaml` (with safe defaults), writes Claude Code PreToolUse hook, sets up SQLite state DB
- `loom init --cursor` additionally writes `.cursor/mcp.json` connecting to loom-mcp server
- Must be idempotent (safe to re-run)

### FR-2: BMAD Planning Pipeline

- On `loom epic "<brief text>"`, activate BMAD Analyst persona (Mary) to produce a structured project context
- Pass context to BMAD PM persona (John) to produce PRD + epic/story YAML files
- Pass PRD + epics to BMAD Architect persona (Winston) to produce architectural decisions and enrich epics with technical notes
- All three phases run headless (no human interaction until gate)
- Output: `_bmad-output/planning-artifacts/prd/prd.md` + `epics/epic-{n}.yaml`

### FR-3: Human Gate

- After planning completes, present a summary of the plan and wait for explicit approval
- Approval command: `loom approve <epic-id>` (CLI) or `loom_approve_plan(epic_id)` (MCP tool)
- Rejection command: `loom reject <epic-id> --reason "..."` — discards plan, allows re-run with amendments

### FR-4: Story Dispatch

- Supervisor reads approved `epics/epic-{n}.yaml` and dispatches each story as a Claude Code subagent
- Each subagent runs in its own git worktree (`.loom/worktrees/story-{id}/`) on branch `story/{story-id}`
- Subagent receives: story spec, acceptance criteria, relevant skills (from skill store), policy constraints
- Max concurrent agents: configurable via `policy.yaml` (default: 3)

### FR-5: Guardrail Engine

- Before any Bash tool execution, the policy engine validates the command against `policy.yaml`
- Must block: `git push --force`, `git push --force-with-lease`, `git reset --hard`, `rm -rf` targeting protected paths, writes to paths outside `allowed_write_root`, `git push` to non-allowlisted remotes
- Block exits non-zero and logs to audit table with: agent_id, command, policy_rule, timestamp
- Claude Code: implemented via PreToolUse hook calling `loom guard check --command "..."`
- Cursor: implemented via MCP tool `loom_policy_check(command)` that Cursor's agent calls before execution

### FR-6: Story Completion

- Subagent opens a PR (uses `gh pr create`) on completion — never merges directly
- Status updated to `pr_open` in SQLite agents table
- Worktree is retained until PR is merged or closed, then cleaned up

### FR-7: Status Tracking

- `loom status` (CLI) renders a table: story → agent status → PR URL → elapsed time
- `loom_get_status()` (MCP tool) returns the same as JSON
- loom-pi extension renders this as a live dashboard panel in pi.dev

### FR-8: Skill System

- On startup, supervisor reads `SKILL.md` frontmatter from `~/.loom/skills/` and `.loom/skills/` (project-level)
- Relevant skills are selected and injected into each subagent's context
- After story completion, skill extractor analyzes the audit log and calls Claude API: "Is there a novel pattern worth capturing as a skill?"
- If yes: skill is written to `~/.loom/skills/generated/` in agentskills.io format
- Skill naming: `loom-{category}-{description}` (e.g., `loom-testing-property-based`)

### FR-9: MCP Server (loom-mcp)

- Exposes tools: `loom_start_epic`, `loom_get_status`, `loom_approve_plan`, `loom_reject_plan`, `loom_list_skills`, `loom_get_audit_log`, `loom_policy_check`
- Runs as a local process; Cursor and Claude Code connect via stdio
- loom-pi extension connects via pi.dev's extension API wrapping the same MCP calls

## 5. Non-Functional Requirements

### NFR-1: Performance
- Planning pipeline (Analyst + PM + Architect) completes in <5 minutes for a typical feature brief
- Each story agent operates independently; N concurrent agents = N times throughput

### NFR-2: Security / Safety
- Guardrail bypass must require deliberate policy override (not prompt manipulation)
- Agent-generated code lives in worktrees; never directly on main branch
- Protected paths blocked at OS level (command interceptor), not LLM level

### NFR-3: Portability
- Works on macOS and Linux; Windows support is a stretch goal
- Node.js v20+ required; no Docker required for basic operation
- Single `npm install -g loom-ai` installs CLI globally

### NFR-4: Observability
- All agent actions logged to SQLite audit log with structured fields
- Logs searchable via FTS5 (`loom audit search "git push"`)
- loom-pi shows log tail per agent in status dashboard

### NFR-5: Extensibility
- New BMAD personas added by dropping a SKILL.md into `.claude/skills/` or `.agents/skills/`
- Policy rules extensible via `policy.yaml` custom_rules array
- New MCP tools added by extending loom-mcp's tool registry

## 6. Epics Overview

| Epic | Title | Priority | Dependencies |
|---|---|---|---|
| E-1 | Core Engine: `loom init`, policy engine, SQLite state | Must Have | None |
| E-2 | BMAD Planning Pipeline: Analyst→PM→Architect personas + headless workflow | Must Have | E-1 |
| E-3 | Story Dispatch: supervisor, worktree isolation, subagent runner | Must Have | E-1, E-2 |
| E-4 | MCP Server: loom-mcp with all 7 tools | Must Have | E-1, E-3 |
| E-5 | Guardrail Engine: policy parser, command interceptor, audit log | Must Have | E-1 |
| E-6 | Skill System: discovery, loading, injection, post-story generation | Should Have | E-1, E-3 |
| E-7 | Status Dashboard: CLI + loom-pi pi.dev extension | Should Have | E-3, E-4 |
| E-8 | Cursor Integration: MCP config, .cursor/rules, skills symlink | Must Have | E-4 |
| E-9 | Claude Code Integration: slash commands, PreToolUse hook | Must Have | E-4, E-5 |

## 7. Out of Scope (V1)

- Slack / Discord / hermes gateway integration (planned for V2)
- Multi-machine agent coordination (single machine, local process)
- Support for LLMs other than Claude (Anthropic API only for V1)
- Windows native support
- Automated PR merging (human merge required by policy)
- Web UI / hosted dashboard
