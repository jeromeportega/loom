# Guard Parser Redirection Correctness + Integration-Gate Command Preflight

## The Problem

Two of loom's safety mechanisms misfire on legitimate developer workflows, observed directly in an earlier epic-011 run. Both failures erode operator trust in the guardrails — the one asset a structural policy engine cannot afford to lose.

1. **Policy-engine false positive on fd redirection.** `PolicyEngine.checkShellMetacharacters` (`packages/loom-core/src/guardrails/PolicyEngine.ts`, line 79) blocks `&` backgrounding with the regex `(?<!&)&(?!&)`. This regex cannot distinguish backgrounding from file-descriptor redirection: audit entries 512/513 in that repo show an identical command blocked solely because it ended in `2>&1`, then allowed on retry without it. The engine's own documented intent (lines 63–66) is that redirection *is* allowed; the implementation contradicts it for the `&`-containing redirection forms.
2. **Integration-gate command failure surfaces too late.** The gate's auto-detection (`packages/loom-core/src/orchestrator/IntegrationGate.ts`) can select a command that cannot run in a bare integration worktree. In that run it picked `make test`, which requires environment (JWT secrets, Redis, `JIRA_URL`) present only in the developer's shell. The gate failed every run until `test_command` was hand-scoped — and the failure was discovered only at finalize time, after a multi-hour run had completed all stories.

## Target Users

- **Primary:** loom operators running epics on real repositories — they hit the `2>&1` block mid-run and the gate failure at the end of one.
- **Primary:** story agents themselves, whose legitimate commands (`npm test 2>&1`) are rejected, forcing wasteful retry loops.
- **Secondary:** loom maintainers triaging "guardrail blocked a safe command" reports.
- **Anti-persona:** anyone wanting a general shell parser — this is a targeted regex fix, not an AST rewrite.

## Proposed Solution

**Part 1 — Redirection-aware metacharacter check.** Teach `checkShellMetacharacters` to recognize fd-duplication/redirection forms — `2>&1`, `>&2`, `m>&n`, `&>file`, `>&-` — as redirection (already deliberately permitted, since the filesystem heuristic scans the full raw command for protected paths), while continuing to block true backgrounding (trailing `cmd &`, mid-command `a & b`).

**Part 2 — Gate-command preflight.** Validate the configured-or-auto-detected `test_command` *early* rather than at finalize:

- Check the command exists and the runner's prerequisites are plausible in a bare worktree (lockfile present for `npm test`, Makefile target exists for `make test`).
- Report via `loom doctor`, plus a loud advisory warning at plan time (`loom epic`) and at `loom run` start when the epic will use the gate.
- Offer an **opt-in** true dry-run (execute the command once in a throwaway worktree) as a doctor subcommand/flag — never silently during planning.

## Key Capabilities

1. `loom guard check --command "npm test 2>&1"` exits 0; same for `>&2` and `&> out.log` forms.
2. `loom guard check --command "sleep 10 &"` and `a & b` still exit non-zero with the backgrounding reason.
3. Preflight flags an auto-detected gate command whose prerequisites are missing in a bare worktree and names the exact `test_command` to set.
4. `loom doctor` gains the gate-command check; `loom epic` and `loom run` emit the advisory warning when applicable.
5. Opt-in dry-run actually executes the gate command once in a throwaway worktree, on explicit request only.

## Constraints

- **Structural invariant holds throughout:** `loom guard check` must exit non-zero for any forbidden command regardless of LLM output (key invariant #1).
- **Preflight is advisory only** — it warns, it never blocks a run by itself.
- **No general shell parser/AST rewrite**; the fix stays within the existing regex-blocker structure.
- **No changes** to gate execution semantics or `warn`/`block` behavior; no auto-installing dependencies in worktrees.
- **Merge hygiene:** a concurrent sibling epic also extends `loom doctor` (cursor_model validation) — doctor additions must be self-contained so both PRs merge cleanly.
- Tests live next to source under `__tests__/`; extend the existing metacharacter suite in `packages/loom-core/src/__tests__/PolicyEngine.test.ts`.
- `docs/capabilities.md` must be updated in the same PR (policy-engine row's blocked-constructs description; `loom doctor` row).

## Risks and Open Questions

- **Regex subtlety:** distinguishing `m>&n` from `cmd &` by pattern alone has edge cases (e.g. `&>` at start of token vs. a stray `&` followed by `>`). The test suite must pin both directions; an over-permissive fix would weaken invariant #1, an under-permissive one re-creates the bug.
- **Preflight plausibility checks are heuristic.** A lockfile's presence doesn't guarantee `npm test` succeeds in a bare worktree (env vars, services). `[ASSUMPTION]` The brief accepts this: the heuristic catches the structural prerequisites, and the opt-in dry-run covers the rest.
- **`[ASSUMPTION]`** The warning surface at `loom epic` and `loom run` start has access to the resolved policy and project root needed to run detection at that point; if detection currently lives only inside the gate, light refactoring to expose it is in scope.
- **Open question:** exact catalogue of redirection forms to whitelist beyond the five named — e.g. `<&`, `n<&m`. Scope decision: cover the named forms plus obvious symmetric cases; anything exotic stays blocked (fail-safe direction).
- **Open question:** whether the dry-run worktree should reuse the gate's existing worktree-creation path or a lighter throwaway. `[ASSUMPTION]` Reuse is preferred to keep behavior identical to the real gate.

## Success Criteria

- [ ] `loom guard check --command "npm test 2>&1"`, `"npm test >&2"`, and `"npm test &> out.log"` all exit 0.
- [ ] `loom guard check --command "sleep 10 &"` and `--command "a & b"` exit non-zero, citing backgrounding.
- [ ] All pre-existing metacharacter blocks (`;`, `&&`, `||`, backticks, `$(`) remain blocked — full existing suite green.
- [ ] Preflight detects a gate command with missing bare-worktree prerequisites and its message states exactly which `test_command` to set.
- [ ] `loom doctor` includes the gate-command check; `loom epic` and `loom run` warn when the epic will use the gate with a non-viable command; no run is ever blocked by preflight alone.
- [ ] Dry-run executes only via explicit doctor opt-in; planning never silently runs test suites.
- [ ] New tests in `__tests__/` cover both parser directions and preflight detection.
- [ ] `docs/capabilities.md` updated for the policy-engine blocked-constructs description and the `loom doctor` row.
