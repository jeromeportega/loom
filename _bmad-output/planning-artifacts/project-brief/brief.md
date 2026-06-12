---
title: "Loom — Autonomous Agentic Engineering System"
status: final
created: 2026-05-22
updated: 2026-05-22
---

# Product Brief: Loom

## The Problem

Software engineering teams spend the majority of their time on coordination overhead, not engineering. A developer with a feature idea must write a ticket, get it sized, wait for sprint planning, write a PRD, get architect review, break it into stories, and only then begin coding — often weeks after the original insight. The planning phase is slow and human-intensive even when the logic is entirely repeatable.

At the same time, AI coding assistants (Cursor, Claude Code, GitHub Copilot) have proven that LLMs can write production-grade code. The missing piece is **orchestration**: something that turns a one-line idea into a structured plan, dispatches agents to execute each piece in parallel, and presents the developer with pull requests rather than more planning work.

No current open-source tool solves this end-to-end:
- **CrewAI / LangGraph**: orchestration frameworks that require the developer to define every workflow
- **OpenHands / SWE-agent**: single-agent code-writing, no planning phase
- **Cursor background agents**: code execution only, no upstream planning
- **BMAD Method**: excellent planning methodology, but still human-driven step-by-step

## The Opportunity

Build an open-source system that takes a developer's brief and autonomously handles the full SDLC planning → execution pipeline, requiring human input only at two gates:
1. Writing the initial brief
2. Approving the generated plan before execution begins

After approval, the system operates without further human involvement until PRs are ready for review.

## Target Users

**Primary**: Individual developers and small teams (1–5) who want to ship features faster without a dedicated PM/architect role. They know what they want to build but spend too much time on process.

**Secondary**: Engineering organizations experimenting with AI-driven development at Cursor/Claude Code shops. They want a standardized, auditable way to deploy autonomous agents across repos.

**Anti-persona**: Teams with rigorous governance, multi-stakeholder PRD processes, or compliance requirements that mandate human sign-off at each SDLC gate.

## Solution: Loom

An open-source, self-learning, multi-agent engineering toolkit that:

1. **Accepts a brief** — one paragraph describing what to build
2. **Plans autonomously** — BMAD Analyst → PM → Architect personas produce structured PRD + epics in sequence
3. **Executes in parallel** — spawns Claude Code subagents per story, each in an isolated git worktree
4. **Enforces guardrails** — policy engine blocks destructive operations (force push, rm -rf, filesystem escapes) at the command level, not the prompt level
5. **Tracks status** — real-time dashboard shows every agent's state (pending/running/blocked/PR open/done)
6. **Learns over time** — after each story, detects novel patterns and writes new skills to `~/.loom/skills/` in agentskills.io format

## Interface Strategy

Two ways to use loom, both through the MCP server (`loom-mcp`):

- **Cursor**: Cursor's background agents call loom's MCP tools (`loom_start_epic`, poll `loom_get_status`).
- **Claude Code**: slash commands in `.claude/skills/` invoke the same loom-mcp tools; PreToolUse hooks enforce guardrails.

## Key Differentiators

| Dimension | Loom | Competitors |
|---|---|---|
| Planning → execution | Full pipeline | Execution only (OpenHands, SWE-agent) |
| Self-learning | Skills auto-generated from novel patterns | None of the above |
| IDE support | Cursor + Claude Code via MCP | Single-IDE typically |
| Guardrails | Structural (policy engine + worktree isolation) | Prompt-level only |
| Open source | Yes, local-first, no SaaS required | Mixed |
| BMAD planning | Built-in persona pipeline | Only with manual BMAD setup |

## Constraints

- **Local-first**: no SaaS telemetry, no cloud dependency beyond the LLM API (Anthropic Claude)
- **No Docker required** for basic operation (git worktrees for isolation instead)
- **Works on any git repo**: `loom init` is the only setup step
- **Anthropic SDK only** for MVP: Claude 4.x with prompt caching

## Risks and Open Questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Agent produces broken code in worktrees | High | Worktree isolation + PR-only merge; human reviews |
| Guardrail bypass via indirect commands | Medium | Policy engine checks resolved commands; worktree filesystem scope limits blast radius |
| BMAD planning output quality varies with brief quality | High | Analyst persona prompts for clarification; structured brief template constrains output |
| Self-generated skills degrade quality over time | Low | Skill versioning; human can prune `~/.loom/skills/generated/` |
| Anthropic API costs at scale | Medium | Prompt caching on shared context; budget limits in policy.yaml |

## Success Criteria

- Developer writes a one-paragraph brief → system produces a mergeable PR for a simple story in under 30 minutes, unattended
- `loom init` takes under 2 minutes on a fresh repo
- Policy engine blocks `git push --force` and `rm -rf ~/` on 100% of attempts in CI test suite
- At least one auto-generated skill is produced after a novel story completion
