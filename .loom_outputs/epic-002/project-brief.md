# Project Brief: Worker MCP Isolation — Allowlist-Only Servers, Materialized Per-Worktree, Audit-Logged

## The Problem

Headless story workers currently inherit the developer's personal MCP servers. Observed in an earlier epic-011 run: a cursor-agent worker spawned `jira-mcp` and `analytics-mcp`, loaded from the user-level `~/.cursor/mcp.json` approved list — servers loom never configured.

This is one root cause with four distinct costs:

1. **Security surface** — code-writing workers silently hold the developer's Jira and internal-tool credentials. Workers execute LLM-directed actions; handing them ambient personal credentials is a real exposure, not a theoretical one.
2. **Startup latency** — each inherited server adds spawn-time cost to every worker.
3. **Token waste** — every inherited server's tool schemas occupy prompt space in every worker turn.
4. **Zero visibility** — MCP exposure appears nowhere in the audit log, violating loom's "all agent actions are logged" invariant in spirit: the audit trail records what workers did, but not what tools they were armed with.

Affected parties: operators running loom (security and audit posture), developers whose credentials leak into worker context, and anyone reading the audit log expecting it to be complete.

## Target Users

- **Primary:** Loom operators who need workers' tool exposure to be deliberate, minimal, and auditable.
- **Secondary:** Developers running loom on their own machines, whose personal MCP credentials are currently exposed to workers without consent; security reviewers auditing worker behavior after the fact.
- **Anti-persona:** Operators who *rely* on workers inheriting their personal MCP servers as an undocumented convenience. This change deliberately breaks that pattern; they are served by a migration note (`loom mcp add` the servers they actually want workers to have), not by preserving the leak.

## Proposed Solution

Make the `loom mcp`-managed set (`policy.mcp.registry`, populated via `loom mcp add` → `upsertMcpServer` in `packages/loom-cli/src/commands/mcpConfig.ts`) the **exclusive** MCP allowlist for workers. Enforcement is structural, per worker backend, at worktree setup time:

- **Materialize:** at story worktree setup (worktree materialization path in `packages/loom-core/src/orchestrator/`), write a worktree-local `.cursor/mcp.json` containing exactly the allowlisted servers.
- **Exclude (cursor-cli backend):** explicitly disable everything else via `cursor-agent mcp list` / `cursor-agent mcp disable <name>` run against the worktree, so user-level servers neither load nor prompt.
- **Exclude (claude-code backend):** pass `--strict-mcp-config --mcp-config <generated file>` when spawning (arg construction in `packages/loom-core/src/orchestrator/ClaudeCodeWorker.ts`) — native support for exactly this semantics.
- **Record:** audit-log the exact MCP server set each worker was given — one row per worker spawn, written before the worker starts, mirroring how bash commands are logged.

## Key Capabilities

1. Generate a worktree-local `.cursor/mcp.json` from the policy registry at story worktree setup — registry contents in, nothing else.
2. Propagate `loom mcp add`-registered servers into every worker's worktree config.
3. Cursor-cli backend: enumerate and disable all non-allowlisted servers headlessly against the worktree.
4. Claude-code backend: spawn with strict MCP config flags pointing at the generated file.
5. Audit-log one row per worker spawn containing the server names, before the worker starts.
6. Make a deliberate, documented decision on whether workers receive the loom MCP server itself — `loom init` writes it project-level via `addLoomServer`, but the worker prompt currently has no use for it.

## Constraints

- **Scope:** no changes to planner/refiner MCP exposure (they run via LLM clients, not agent CLIs, today); no new registry format; no upstream cursor-agent feature work — the `--strict-mcp-config` equivalent for cursor-agent is an out-of-scope upstream ask.
- **Repo invariants:** tests live under `__tests__/` next to source; `docs/capabilities.md` must be updated in the same change (the "Provision approved MCP servers for workers" row changes meaning — it becomes an exclusive allowlist).
- **Operator impact:** this is a behavior change. Operators relying on inherited personal servers will see them disappear; the change must be flagged prominently, with the `loom mcp add` migration path stated.
- **Fixed touch points:** `mcpConfig.ts` (registry writes), the orchestrator worktree materialization path, `ClaudeCodeWorker.ts` (spawn args), the audit-log write path.

## Risks and Open Questions

- **Residual cursor-cli gap (known unknown):** it is not yet established what cursor-agent supports headlessly for per-project disables. If full strictness is unachievable, the gap must be investigated and documented — acceptance treats cursor-cli verification as the bar, so this is the project's primary technical risk.
- **Config precedence:** `[ASSUMPTION]` a worktree-local `.cursor/mcp.json` plus explicit disables is sufficient to prevent user-level servers from loading; the exact merge/precedence semantics of cursor-agent config layers should be verified early, since the whole design rests on it.
- **Loom server inclusion:** open decision. `[ASSUMPTION]` default to excluding the loom server from worker configs, since the worker prompt has no need for it — but this must be confirmed against any dispatch-time dependency before shipping.
- **Disable durability:** `[ASSUMPTION]` `cursor-agent mcp disable` state is per-project and persists for the worktree's lifetime; if it is user-global, disabling could affect the developer's own sessions — verify before wiring it in.
- **Audit schema fit:** `[ASSUMPTION]` the existing `audit_log` table accommodates a worker-spawn row with a server-set payload the same way it stores bash commands, requiring no migration.

## Success Criteria

- [ ] A story worker spawned in a repo whose policy registry defines zero servers sees **zero non-loom MCP servers**, regardless of the contents of the developer's `~/.cursor/mcp.json` — verified on the cursor-cli backend.
- [ ] The claude-code backend spawns with `--strict-mcp-config --mcp-config <generated file>`.
- [ ] Servers registered via `loom mcp add` **do** appear in the worker's worktree `.cursor/mcp.json`.
- [ ] Every worker spawn writes an audit row containing its exact MCP server set, before the worker starts.
- [ ] Tests cover: worktree config generation, claude-code arg construction, and the audit row.
- [ ] `docs/capabilities.md` reflects the exclusive-allowlist semantics, with the operator-facing behavior change called out prominently.
- [ ] Any residual cursor-cli strictness gap is documented, with the upstream ask recorded as out of scope.
