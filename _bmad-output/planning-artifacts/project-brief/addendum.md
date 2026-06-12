---
title: "Loom — Project Brief Addendum"
brief_ref: brief.md
created: 2026-05-22
---

# Addendum: Technical Constraints and Context

## Competitive Landscape Detail

### hermes-agent (NousResearch)
- Architecture: Python, 70+ tools, SQLite + FTS5, agentskills.io standard
- Self-learning: Autonomous skill creation after complex task completion; periodic nudging for knowledge retention
- Gateway: 20 messaging adapters (Slack, Discord, Telegram, Signal, WhatsApp, Email, CLI)
- Integration strategy: Use hermes as the communication gateway layer; adopt agentskills.io skill format for compatibility

### pi.dev (earendil-works)
- Architecture: TypeScript monorepo (pi-ai, pi-agent-core, pi-coding-agent, pi-tui)
- Extension API: TypeScript extensions loaded dynamically via npm/Git, register tools/slash commands, subscribe to lifecycle events
- RPC protocol: JSONL over stdin/stdout — future hermes adapter can speak this protocol
- Integration strategy: `loom-pi` extension wraps loom-mcp calls; pi.dev handles TUI rendering

### BMAD Method (v6.7.1)
- 6 agent personas: Mary (Analyst), John (PM), Winston (Architect), Amelia (Developer), Sally (UX), Paige (Tech Writer)
- 44 skills across 4 phases: analysis, planning, solutioning, implementation
- Step-file architecture: sequential micro-files with state tracked in YAML frontmatter
- Integration strategy: BMAD's agent SKILL.md files are the loom planning pipeline's persona definitions; installed via `npx bmad-method install`

## Architecture Decisions Captured

**Why agentskills.io format?**
Cross-system compatibility: hermes-agent and pi.dev both support it. Progressive disclosure (metadata→instructions→resources) keeps startup token cost low.

**Why git worktrees over Docker?**
No Docker installation required for basic use. Worktrees are native git and provide filesystem isolation within the repo. Each story gets a branch and worktree; the supervisor never modifies worktrees directly.

**Why Claude API direct (not Claude Code SDK only)?**
Skill generation (post-story analysis) needs direct API access with prompt caching. The MCP server also needs to spawn requests independently of any IDE session.

**Why SQLite over Postgres/Redis?**
Local-first, zero-dependency. FTS5 for audit log search. Sufficient for single-machine multi-agent coordination. Can be swapped for a network DB if multi-machine orchestration is needed later.

## User Interview Synthesis (Jerome Ortega)

- Team context: uses both Cursor and claude-code sessions
- Pain point: "I want to basically only assist in developing the initial PRD, at which point I'd like it to take over the rest of the required planning work"
- Guardrail priority: "How do we control what repos it can push to, how do we make sure it doesn't delete everything and force push"
- Communication: Primary through the agentic harness (pi.dev or similar); Slack is a future goal
- Open source intent: "Something someone could download and operate on repos on their own devices"
- IDE coverage: Must work with Cursor and claude-code sessions
