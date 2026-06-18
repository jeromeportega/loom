# PRD: Trustworthy Overlap Advisory & Dead MCP-Server Residue Removal

## Overview

Dogfooding loom surfaced three pieces of dead or misleading residue that erode operator and contributor trust. The cross-epic overlap advisory at approve time scrapes plain words and code fragments out of planning prose and reports them as file paths, burying any genuine overlap in noise and training operators to ignore the advisory. Separately, scaffolding for the removed loom MCP server still lingers — an optional `loom-server` entry parameter on worker-config materialization, a supervisor branch that would feed it for the cursor backend, and comments that falsely describe the cursor backend as receiving the loom server. Finally, the testing runbook still documents the removed MCP `serve` command as if it were current behavior. This is a scoped, three-part internal cleanup that makes the advisory trustworthy, deletes the orphaned loom-self-server code path and its stale comments, and corrects the historical doc — without touching the retained third-party worker MCP provisioning and without weakening any guardrail.

## Goals

1. **Restore trust in the overlap advisory.** Success metric: a test over a planning input that previously produced false entries reports **zero** non-path entries (no bare words, no code fragments) while still reporting a genuinely shared file.
2. **Eliminate the dead loom-self-server code path.** Success metric: the `loom-server` parameter, the supervisor cursor-backend branch, and the misleading comments are gone; a repo-wide search finds no remaining references, and the build and test suite pass.
3. **Keep the testing runbook honest.** Success metric: the runbook no longer presents the `serve` command as current behavior — the section is removed or unambiguously marked as a record of a removed feature.

## User Stories

- **As a loom operator,** I want the overlap advisory to list only plausible shared file paths so that I trust it and act on real conflicts before releasing epics for execution. *(Must)*
- **As a loom operator,** I want the advisory to still flag genuinely shared files so that tightening the heuristics does not silently hide real conflicts. *(Must)*
- **As a loom maintainer/contributor,** I want the dead loom-self-server plumbing and its comments removed so that the supervisor and worker-config code reflect what loom actually does. *(Must)*
- **As a loom contributor,** I want the testing runbook to clearly distinguish current from removed behavior so that I don't mistake the removed `serve` command for a live feature. *(Should)*

## Functional Requirements

**Overlap advisory**

- **FR-1** — The detector treats a token as a candidate file path only when it looks like a real path: it contains a path separator or a known source-file extension. Tokens failing this bar are excluded.
- **FR-2** — File existence is a tiebreaker, not a gate: a path-shaped token is included even if the file does not yet exist under the project, since in-flight epics legitimately create new files. *(Resolves the open question in the brief; confirm with maintainers if challenged.)*
- **FR-3** — Where stories declare file ownership, each epic's claimed-files set is derived from that declaration as the preferred source; free-text scraping becomes the fallback only. `[ASSUMPTION]` Story schemas already carry a declared file-ownership field; if they do not, the fallback path is used.
- **FR-4** — The free-text fallback applies the same path-validity filter as FR-1, so it can never emit bare words or non-path code fragments.
- **FR-5** — The advisory output lists only plausible shared file paths, still warns on genuinely shared files, and remains advisory-only — it never blocks approval.

**Dead MCP-server residue**

- **FR-6** — The dead-code claim is verified across the codebase (no remaining caller passes the `loom-server` entry) before deletion.
- **FR-7** — The optional `loom-server` entry parameter on worker-config materialization is removed.
- **FR-8** — The supervisor branch that would have fed the loom-server entry for the cursor backend is removed.
- **FR-9** — All comments describing the cursor backend as receiving the loom server are removed; no code or comment implies loom injects its own server into a worker config.
- **FR-10** — Materialization of operator-approved third-party servers from the policy registry into the worker config is left exactly as is — behavior and tests unchanged.

**Documentation**

- **FR-11** — The testing runbook's historical MCP-server-epic section no longer presents the removed `serve` command as current behavior; it is removed or clearly marked as a record of a removed feature. `[ASSUMPTION]` Marking as historical is preferred over deletion to preserve institutional memory.

## Non-Functional Requirements

- **NFR-1** — No guardrail is weakened by any change in this work.
- **NFR-2** — The loom MCP server is not reintroduced in any form.
- **NFR-3** — Retained third-party worker MCP provisioning is regression-free: its behavior is unchanged and its existing tests stay green.

## Epics

This PRD is a single cohesive cleanup and breaks into **one epic**:

- **Epic 1 — Trustworthy overlap advisory & dead MCP-server residue removal.** Covers path-aware overlap detection, removal of the orphaned loom-self-server materialization path and its stale comments, and correction of the testing runbook, all while preserving third-party provisioning and guardrails.

## Out of Scope

- Any new overlap-advisory features beyond correctness (this is cleanup, not redesign).
- Making the advisory blocking, or otherwise changing its advisory-only nature.
- Any change to the retained third-party worker MCP provisioning behavior or its tests.
- Reintroducing the loom MCP server or the `serve` command in any form.
- Weakening or modifying any guardrail.
