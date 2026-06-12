# PRD: Guard Parser Redirection Correctness + Integration-Gate Command Preflight

## Overview

Two of loom's safety mechanisms misfire on legitimate developer workflows, as observed in an earlier epic-011 run. First, `PolicyEngine.checkShellMetacharacters` blocks file-descriptor redirection (`npm test 2>&1`) as if it were backgrounding, contradicting the engine's own documented intent that redirection is allowed. Second, the integration gate's auto-detected `test_command` can be non-runnable in a bare worktree, and this is discovered only at finalize time — after a multi-hour run completes. This PRD covers a targeted regex fix to make the metacharacter check redirection-aware, and an advisory preflight that validates the gate command early (`loom doctor`, plan time, run start) with an opt-in true dry-run. Both fixes preserve the structural guarantee that forbidden commands are always blocked.

## Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G-1 | Eliminate false positives on fd-redirection | `loom guard check` exits 0 for `npm test 2>&1`, `npm test >&2`, and `npm test &> out.log` |
| G-2 | Preserve the backgrounding block (invariant #1) | `sleep 10 &` and `a & b` exit non-zero citing backgrounding; full existing metacharacter suite stays green |
| G-3 | Surface gate-command non-viability before a run completes, not at finalize | Preflight flags a non-viable command at doctor/plan/run-start time and names the exact `test_command` to set |
| G-4 | Preflight never erodes run autonomy | Zero runs blocked by preflight alone; warnings are advisory only |

## User Stories

- **As a loom operator**, I want `loom guard check` to permit fd-redirection forms so that my story agents' legitimate commands (`npm test 2>&1`) are not rejected mid-run, wasting retry loops. **(Must)**
- **As a loom operator**, I want to learn at plan time or via `loom doctor` that my gate command cannot run in a bare worktree so that I can set `test_command` before committing to a multi-hour run. **(Must)**
- **As a loom operator**, I want an opt-in dry-run that executes the gate command once in a throwaway worktree so that I can verify it end-to-end without waiting for finalize. **(Should)**
- **As a loom maintainer**, I want tests that pin both directions (redirection allowed, backgrounding blocked) so that future changes to the regex cannot silently regress either. **(Must)**

## Functional Requirements

- **FR-1** — `checkShellMetacharacters` recognizes fd-duplication/redirection forms — `2>&1`, `>&2`, `m>&n`, `&>file`, `>&-`, plus obvious symmetric cases (e.g. `<&`, `n<&m`) — as permitted redirection. Exotic or ambiguous forms stay blocked (fail-safe direction).
- **FR-2** — True backgrounding remains blocked: trailing `cmd &` and mid-command `a & b` exit non-zero with the backgrounding reason. All other existing metacharacter blocks (`;`, `&&`, `||`, backticks, `$(`) are unchanged.
- **FR-3** — A preflight check validates the configured-or-auto-detected `test_command` against bare-worktree prerequisites using structural heuristics (lockfile present for `npm test`, Makefile target exists for `make test`). On failure, the message states exactly which `test_command` to set.
- **FR-4** — `loom doctor` gains the gate-command preflight check. The addition is self-contained so it merges cleanly alongside the concurrent sibling epic that also extends doctor.
- **FR-5** — `loom epic` and `loom run` emit a loud advisory warning at start when the epic will use the integration gate with a non-viable command. The warning never blocks the run. `[ASSUMPTION]` If gate-command detection currently lives only inside `IntegrationGate`, light refactoring to expose it to these surfaces is in scope.
- **FR-6** — An opt-in dry-run (doctor subcommand/flag) executes the gate command once in a throwaway worktree, on explicit request only — never silently during planning. `[ASSUMPTION]` The dry-run reuses the gate's existing worktree-creation path to keep behavior identical to the real gate.
- **FR-7** — New tests under `__tests__/` cover both parser directions (redirection forms allowed, backgrounding forms blocked) and preflight detection, extending the existing suite in `packages/loom-core/src/__tests__/PolicyEngine.test.ts`.
- **FR-8** — `docs/capabilities.md` is updated in the same PR: the policy-engine row's blocked-constructs description and the `loom doctor` row.

## Non-Functional Requirements

- **NFR-1** — Structural invariant holds throughout: `loom guard check` exits non-zero for any forbidden command regardless of LLM output. Where redirection-vs-backgrounding classification is ambiguous, the engine blocks.
- **NFR-2** — Preflight is advisory only. No code path allows preflight, by itself, to block or fail a run. Gate execution semantics and `warn`/`block` behavior are untouched.

## Epics

This PRD breaks into **one epic**: the two parts are small, land in the same package and PR (shared docs and test obligations), and together restore trust in the same guardrail surface.

1. **epic-001 — Guard redirection correctness and integration-gate command preflight** — redirection-aware metacharacter check, gate-command preflight across doctor/epic/run, opt-in dry-run, tests, and capabilities-page update.

## Out of Scope

- A general shell parser or AST rewrite — this is a targeted fix within the existing regex-blocker structure.
- Any change to gate execution semantics or `warn`/`block` behavior.
- Auto-installing dependencies (lockfile restore, service startup) in worktrees.
- Whitelisting exotic redirection forms beyond the named forms and their obvious symmetric cases.
- Executing test suites silently during planning — dry-run is explicit opt-in only.
- Guaranteeing the gate command *succeeds* in a bare worktree; the heuristic checks structural prerequisites only, with the dry-run covering the rest.
