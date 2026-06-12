# Pre-1.0 Polish: Operator-Trust Hardening for Loom

## The Problem

Two days of dogfooding (6 epics, 39 stories across the v0.6.0/v0.7.0 runs) closed every major gap but left a residue of operator-facing rough edges. Five of them — findings N1, N2, N3, N4, N14, N15 — share a common failure mode: **the system tells the operator something that is not true, or fails on input that actually works.** Each erodes trust at exactly the moments trust matters most: a first run, an approval, a multi-epic merge.

Concretely, today:

- **The front door can hard-fail on a working config (N15).** `validateCursorModels` (`packages/loom-core/src/llm/cursorModels.ts`) exact-matches `policy.agents.cursor_model` against `cursor-agent --list-models`. But cursor-agent spawns happily on bare alias ids the list never enumerates: `claude-opus-4-8` ran 22 stories successfully, then failed validation, because the list only contains suffixed forms (`-low/-medium/-high/-xhigh/-max`). A new operator's *first* `loom epic` can die on a model that demonstrably works.
- **`loom approve` lies about what it does (N1).** It only flips the epic to `approved`; nothing dispatches until `loom run`. Yet `docs/capabilities.md` ("Approve a plan" row) says it "dispatches workers" and `.claude/skills/loom-approve/SKILL.md` says "Story agents dispatch in the background." Three surfaces promise dispatch the code never performs.
- **Planning runs are unattributable and can vanish (N2 + N3).** `Planner.run` already reserves the epic row, advances phases, backfills the title, and records `failed` on a crash (delivered by epic-005). But `runEpic` (`packages/loom-cli/src/commands/epic.ts`) runs the BriefRefiner and brief-quality gate *before* the Planner is constructed — so during refinement the run is invisible to `loom status`, and a gate-rejected brief produces **no epic row at all**. IDs are not guaranteed to allocate in submission order.
- **Cross-epic conflicts are caught only by humans (N4, N14).** The shared contract's file-ownership map (`.loom/contract/<epic-id>.md`) is per-epic; nothing compares maps *between* epics. A guaranteed mechanical conflict (epic-002 changing `agentArgs()` via `BaseCliWorker` while epic-004 rewrote `CursorAgentWorker.agentArgs()`) was caught only by a human reading both epic YAMLs. Separately, both wave merges hit a git-invisible class of failure: each epic's integration gate was green *in isolation*, but the **union** of two epic branches failed `tsc`/test collisions — caught only by running the merged tree's suite by hand. N14 bit the maintainers twice in two days.

This is the final polish wave before a **v1.0 stability freeze**, so the work must be purely additive or corrective — no renames, no removed statuses, no new policy knobs.

## Target Users

- **Primary — the first-time operator.** Runs `loom doctor`, `loom init`, `loom epic`, `loom approve`. Their onboarding path must have zero false failures and zero misleading copy. They are the person N15 and N1 hurt most.
- **Primary — the tandem operator running multiple epics.** Plans and approves several epics against one repo. They are the person N2, N3, N4, and N14 hurt most: identity confusion and silent cross-epic conflicts compound badly during concurrent runs.
- **Secondary — loom's own maintainers**, dogfooding the system. The findings log is theirs; N14 cost them two manual merge-debugging sessions.
- **Anti-persona — the operator wanting fully automated cross-epic gating.** This epic deliberately does *not* serve them: no automatic cross-epic gate inside the finalizer, no policy knob for it. They get an advisory doctor flag and a hint, nothing that blocks or auto-runs.

## Proposed Solution

Five independent, surgical changes, each closing one finding and each additive to the v1.0 surface. None introduces a new top-level command or a schema migration. The unifying principle: **every surface either tells the truth, accepts what works, or warns honestly about what it cannot guarantee.**

## Key Capabilities

1. **Accept alias model ids (Part 1 / N15).** Make `validateCursorModels` three-tier: (a) exact match → `ok`, unchanged; (b) no exact match but the configured id is a strict prefix of a listed id *at a `-` boundary* (so `claude-opus-4` does **not** alias-match `claude-opus-4-8-high`) → `ok` with an advisory recommending the explicit suffixed form; (c) neither → `invalid` with the full list, unchanged. `unavailable` (probe can't run) semantics untouched. The advisory warns, never exits non-zero, and all three call sites (`loom doctor`, `loom epic`, `loom run`) inherit it through the shared function.

2. **Truthful approve copy + opt-in dispatch (Part 2 / N1).** Fix every surface claiming dispatch (capabilities "Approve a plan" row, the loom-approve skill in *both* `.claude/skills/` and `.agents/skills/`, and the CLI success copy — which must end with `run \`loom run <epic-id>\` to dispatch`). Add `loom approve <epic-id> --run`, which chains into the same code path as `loom run <epic-id>` after approving, so "dispatching now" is only ever printed by a path that actually dispatches. `--run` is valid only with an explicit epic id; bare `loom approve --run` exits non-zero with a one-line usage hint to rule out surprise mass-dispatch.

3. **Identifiable, durable planning runs (Part 3 / N2 + N3).** Reserve the epic row in `runEpic` at submission time — before the BriefRefiner runs — with a derived placeholder title (the brief's first markdown heading if present, else its first 60 characters), reusing `beginPlanning`. The reservation **is** the allocation: refactor so the Planner consumes a pre-reserved epic id (optional parameter defaulting to today's self-allocation), so `nextEpicId`-style allocation never runs twice for one submission. The refined/planner title replaces the placeholder at completion via the existing seam. IDs now allocate in submission order by construction.

4. **Cross-epic overlap warning at approve/dispatch (Part 4 / N4).** At `loom approve` and at `loom run` dispatch start, parse the file-ownership maps of the target epic and every other planned/approved/in-progress epic in the repo, and print an advisory listing each overlapping file with both epic/story owners. Warns, never blocks. Missing contract file (shared_contract=off) → silently skip. Comparison is **exact lexical path equality** — no globbing, no directory-prefix inference, no semantic analysis.

5. **Cross-epic gate (Part 5 / N14).** Add `loom doctor --cross-epic-gate`, alongside the existing `--dry-run-gate` (doctor is the established home for opt-in, ephemeral-worktree, advisory executions; there is no `loom gate` command — `commands/gate.ts` is approve/reject). It reuses the `runGateDryRun` ephemeral-worktree machinery (`GateDryRun.ts`): create a throwaway worktree from the default-branch tip, merge every open epic branch (`epic/*`, or an explicit `--epics <id,id>` allowlist) sequentially, then (a) if any merge conflicts → report conflicting files per epic pair and stop; (b) if all merge clean → run `policy.agents.test_command` once and report pass/fail with union context. Additionally, when the EpicFinalizer opens a PR while other epic branches have open PRs, print a one-line hint naming `loom doctor --cross-epic-gate`.

## Constraints

- **Stability-freeze discipline.** Purely additive/corrective. No renaming or removal of existing statuses, tools, or policy fields. No new top-level command (Part 5 rides on `doctor`). `[ASSUMPTION: no schema migration is needed — Part 3's placeholder title + early insert reuse existing columns; if any schema change is required it goes through `packages/loom-core/src/state/` migrations.]`
- **Tech stack.** TypeScript / Node 20+. Tests in `__tests__/` next to each touched module.
- **Deterministic tests.** No real `cursor-agent` (stub the `--list-models` probe); no sleeps; temp git repos for the cross-epic gate, following the existing `doctorGateCheck` / `--dry-run-gate` patterns.
- **Part 3 must keep the brief-gate flow intact.** A gate-rejected brief must leave the placeholder row in a defined terminal planning outcome (per epic-005), never an orphaned `(planning…)` row. The `--force` path reserves before the refiner too, and a forced run must **never** be marked `rejected`.
- **Single allocation site.** `Planner.nextEpicId`-style allocation must never run twice for one submission. Do not add a parallel insert path. `beginPlanning` hard-codes the `(planning…)` title today — either add an optional title parameter or write the derived title right after reservation; pick the lower-churn option.
- **Part 4 extraction contract.** Read the markdown table under the file-ownership heading; path is the first column; cells may carry multiple paths separated by commas, `·`, or `<br>` (real contracts on disk use `·` — fixtures must cover it). Strip surrounding backticks, parenthesized annotations (`(new)`/`(delete)`), and trailing prose; normalize to repo-relative POSIX paths. An unparseable row is skipped, never fatal. Pin the parser with fixtures lifted from the real contracts of epics 001–006.
- **Part 5 exit codes.** `0` = merges clean and suite green; `3` = advisory finding (mechanical conflict or union-suite failure — distinct so scripts can branch on it); `1` = hard operational error (worktree creation failed, no epic branches found, gate command unresolvable). Never mutates real branches.
- **Approve/run dedup.** `loom approve <id> --run` runs the Part 4 overlap check once at approve time and suppresses the duplicate check in the chained dispatch.
- **Capabilities doc.** Assign **exactly one owner story** for the `docs/capabilities.md` diff (approve row, model-validation row, `loom doctor` row, status row).

## Out of Scope (Non-Goals)

- No changes to per-epic integration-gate semantics, `warn`/`block` behavior, or the policy engine.
- No semantic/AST-level overlap analysis — Part 4 is lexical path comparison only.
- No automatic cross-epic gate inside the EpicFinalizer, and no new policy knobs for it.
- No cross-repo anything (separate roadmap item).
- No renaming or removal of existing statuses, tools, or policy fields.

## Risks and Open Questions

- **Alias-boundary false positives (Part 1).** The `-`-boundary prefix rule is the entire safety mechanism preventing `claude-opus-4` from matching `claude-opus-4-8-high`. A loose implementation reintroduces the bug class it fixes. *Mitigation:* the three asserted test cases (alias→advisory, bogus→exit non-zero, exact→silent) against a stubbed list are the acceptance gate.
- **Title-derivation edge cases (Part 3).** Briefs with no heading, with markdown noise, or with a leading `#` inside a code fence could yield ugly placeholders. `[ASSUMPTION: "first markdown heading, else first 60 chars" is sufficient; placeholders are transient and replaced at planning completion, so cosmetic imperfection is acceptable.]`
- **Terminal-state taxonomy for a rejected brief (Part 3).** Decision: gate rejection flips the reserved row to `rejected` with `error` carrying the gate verdict (e.g. `"brief gate: 3/10 — <first critique line>"`); a refiner/planner throw flips to `failed` via the existing epic-005 path. *Open risk:* downstream consumers of `rejected` (assuming a human decision) now also see a quality-gate verdict — verify no consumer mis-handles a non-human `rejected`.
- **Lexical-only overlap noise (Part 4).** Exact path equality will both miss conflicts (same file, different normalized spelling) and stay silent on directory-level collisions. Accepted by design as advisory; the alternative (semantic analysis) is explicitly out of scope. *Risk:* operators may over-trust a "no overlap" result. Copy should frame it as lexical-only.
- **Contract-format drift (Part 4).** The parser is pinned to the `·`-delimited format of contracts 001–006. A future Architect output-format change silently degrades the check (rows skipped, not fatal). *Mitigation:* fixtures lifted from real contracts; revisit if the contract emitter changes.
- **Cross-epic-gate cost & scope (Part 5).** `[ASSUMPTION: no automatic cross-epic gating inside the finalizer — cost and blocking semantics are a post-1.0 question; the doctor flag plus the PR hint is this epic's whole scope.]` The `--epics` allowlist vs. `epic/*` default behavior and the "no epic branches found → exit 1" case need explicit test coverage.

## Success Criteria

- **Alias acceptance:** `loom epic` / `loom run` / `loom doctor` with `cursor_model: "claude-opus-4-8"` proceed with an advisory recommending the suffixed form; a genuinely bogus id still exits non-zero with the full list; an exact suffixed id stays silent. All three asserted against a stubbed model list.
- **Truthful approve:** No surface anywhere in the repo claims `loom approve` dispatches workers (asserted by a copy-sweep test scoped to live docs/skills/CLI sources, excluding `.loom_outputs/`); `loom approve --run` approves then dispatches through the `loom run` path; bare `loom approve --run` exits non-zero with a usage hint.
- **Identifiable planning:** Immediately after `loom epic` submission, `loom status` shows the new epic row with a derived title and `planning_phase`; IDs allocate in submission order (test: two stubbed-LLM planning runs where the first refiner finishes second).
- **Overlap warning:** `loom approve` against an epic whose contract overlaps an in-flight epic's contract prints the overlapping files with both owners; approval still succeeds.
- **Cross-epic gate:** `loom doctor --cross-epic-gate` with two fixture epic branches that (a) conflict mechanically reports the file list and exits `3`; (b) merge cleanly but fail the suite reports the union failure and exits `3`; (c) merge cleanly and pass exits `0`. Real branches are never mutated.
- **Clean terminal states:** A gate-rejected brief leaves its reserved row as `rejected` with the gate verdict in `error`; a refiner/planner crash leaves `failed`; no orphaned `(planning…)` rows in either case.
- **Capabilities current:** `docs/capabilities.md` updated by the single owner story — approve row corrected, model-validation note gains the alias tier, `loom doctor` row gains `--cross-epic-gate`, status row notes derived titles from submission.
