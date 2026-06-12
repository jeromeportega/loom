---
title: "Epic 8 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 8 Review: Org MCP Provisioning

Reviewing `McpRegistry`, the `server.json` → `.mcp.json` adapter, and the `loom mcp`
commands.

No code fixes were needed this pass. The findings are limitations to document.

## Findings — documented

### Medium

**1. Approved-MCP tool calls bypass the policy engine.**
- loom's guardrail engine inspects *Bash* commands. An MCP tool call is not Bash, so
  a provisioned MCP server's tools are not policy-checked.
- This is acceptable *by design*: the org registry **is** the trust boundary — a server
  on the allowlist has already been vetted. But it must be stated plainly: provisioning
  an MCP server grants worker agents capabilities the policy engine does not see.
- Documented in `docs/known-limitations.md`.

**2. The registry is a local path, not a live fetch.**
- `policy.mcp.registry` points at a *checkout* of the org registry repo. loom does not
  clone or pull it — the org keeps the checkout fresh. This was deliberate: a live
  remote HTTP fetch would bake auth into loom and break the open-source-generic stance.
- Trade-off: an engineer's registry view is as stale as their last `git pull`.
  Documented; a future enhancement could add `loom mcp sync`.

### Low

**3. `loom mcp add` always picks the stdio package.**
- `pickPackage` prefers stdio over streamable-http. For a server that only ships
  streamable-http, that package is used; for one shipping both, stdio wins. There is no
  way to choose the http variant explicitly. Fine for MVP — stdio is the simpler,
  no-hosted-endpoint path. A `--transport` flag could be added later.

**4. No removal command.**
- `loom mcp add` exists; there is no `loom mcp remove`. A user edits `.mcp.json` by
  hand to undo. Low priority; the files are small and human-readable.

**5. Non-secret required vars are also written as references.**
- Every declared input (secret or not) becomes a `${NAME}` reference; only *secret*
  ones are printed as "you must set these." A required-but-not-secret var (e.g. a base
  URL) still needs setting but is not surfaced as prominently. Minor — documented.

## Downstream impact matrix

| Finding | Epic 9 (Shared skills) | Epic 10 (Onboarding) |
|---|---|---|
| #1 MCP bypasses policy | — | the README should state it |
| #2 local-path registry | the shared-skills repo uses the same pattern | `loom doctor` could check the path resolves |
| #3 transport pick | — | — |
| #4 no remove | — | — |

## What's solid

- **Open-source-generic.** No org-internal URL or registry is baked in. The registry
  is a configurable path; one org points it at `awesome/mcp`, another org points it
  elsewhere, an OSS user leaves it unset. loom stays a generic tool.
- **loom never touches credentials.** Secrets become `${REFERENCES}`; the required
  ones are listed for the user to set in their own environment. loom has zero
  credential-storage liability — exactly the right boundary.
- **Zero worker-path code.** Because workers are `claude` CLI sessions that already
  read `.mcp.json`, a provisioned server is inherited for free — the whole feature is
  registry-read + config-merge, no change to dispatch or the worker.
- **Reuses existing machinery.** The `.mcp.json` merge goes through the same
  `upsertMcpServer` helper `loom init` uses (extracted to a shared module this epic) —
  it never clobbers other servers.
- **Defensive parsing.** A malformed `server.json` is skipped, not fatal — one bad
  entry in the org registry cannot break `loom mcp` for everyone.
