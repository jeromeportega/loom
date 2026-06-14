# Per-Story Signal Ledger (Observe-Only Cost-Control Harness)

## The Problem

Loom now carries the machinery for adaptive cost control — a deterministic tier resolver (`resolveCostTier`), a tier→steps mapping (`tierSteps`), and the `policy.agents.adaptive_cost` knob — but it has never been validated against real runs. Before loom can be trusted to *gate* on those signals (spend fewer reviewers on cheap stories, more on risky ones), an operator needs evidence that the heuristics actually predict cost correctly. Today that evidence does not exist: signals are computed implicitly inside dispatch and thrown away, leaving no record to audit whether a tier call was right.

There is a known calibration gap to validate against: with heuristics alone and no worker self-assessment, the resolver collapses toward `heavy` for nearly every story (confidence defaults to `low` → `heavy`). An observe-only ledger is the safe way to measure that gap on production runs *without* changing what any agent actually does.

## Target Users

- **Primary — loom operators/maintainers** (e.g. Jerome, dogfooding loom): need per-story evidence to decide whether and how to turn on adaptive gating later.
- **Secondary — the EpicFinalizer / epic PR reviewer**: a downstream reader that surfaces the ledger as a "Build signal analysis" section so a human reviewing the epic PR sees the recommendations and mismatches inline.
- **Anti-persona — the gating decision itself.** This feature must *not* influence execution. Nothing here may read the ledger to change reviewer count, verify phases, or skill generation. It only observes.

## Proposed Solution

Add an **observe-only signal ledger**: at each story's completion, compute the cheap heuristics from data loom already has, resolve the implied tier/steps with the *existing* `tier.ts` functions, and persist one `StorySignals`-shaped record per story to two sinks — an `audit_log` row and a human-readable markdown file under `.loom/signals/<story-id>`. The `EpicFinalizer` reads these records back (it never writes them) to append a per-story analysis section to the epic PR body. No execution path changes; the resolver's output is recorded, not enforced.

## Key Capabilities

1. **Compute heuristics** (`HeuristicSignals`) at story completion: `diff_lines` and `diff_files` for the story branch vs. epic base; `risky_paths_touched` = changed files matching `policy.agents.risky_paths` via minimatch; `tests_green_first_try` = first-try test result, or `null` when unavailable.
2. **Resolve tier and steps** by calling the existing `resolveCostTier` and `tierSteps` — no new decision logic, no behavior change.
3. **Persist a `StorySignals` record to two sinks**: an `audit_log` row written *before the story result returns* (per the CLAUDE.md logging invariant), and a markdown file under `.loom/signals/` keyed by story id.
4. **Always record**, regardless of `policy.agents.adaptive_cost` — the ledger is the validation harness that must run *before* any gating exists.
5. **Append a "Build signal analysis" section** to the epic PR body in `EpicFinalizer`, alongside the existing integration-gate section, listing per story: the heuristics, recommended tier and steps, and flagged mismatches.
6. **Flag the over-spend mismatch**: a story recommended `heavy` that then sailed through finalize with no review findings and a green gate → mark as a candidate future gating could safely downgrade.
7. **Best-effort persistence**: any failure to write either sink is swallowed and must never block or fail story completion.

## Constraints

- **No execution behavior changes.** Tier resolution is observed, not applied. Reuse `resolveCostTier`/`tierSteps` in `packages/loom-core/src/orchestrator/tier.ts` as-is.
- **Write site** is the story-completion point in the Supervisor or worker path; **read site** is `EpicFinalizer` only.
- **Logging invariant** (CLAUDE.md #5): the `audit_log` row is written *before* the story result returns to the caller.
- **`.loom/signals` is gitignored run state**, consistent with `.loom/` as dogfood/run state — not committed artifacts.
- **Docs**: update `docs/capabilities.md` for the new ledger files and the PR section (capabilities page is the source of truth).
- **Tests required**: unit tests for heuristic computation, the record shape across *both* sinks, and the epic-review section renderer.
- The mismatch definition is deliberately narrow (over-spend only), because the under-spend direction isn't trustworthy yet given the `heavy`-bias calibration gap.

## Risks and Open Questions

- **Field-name mapping across sinks.** `tierSteps` returns camelCase (`verifyPhase`, `skillGen`) but `StorySignals.steps` is snake_case (`verify_phase`, `skill_gen`). The persistence layer must map these; the cross-sink shape test should pin it. *(Verified against `tier.ts` and `types.ts`.)*
- **First-try test signal availability.** `tests_green_first_try` is explicitly nullable. [ASSUMPTION] The Supervisor/worker path has access to a first-try result; if not, records will systematically carry `null`, weakening the validation. The write site must confirm the signal source exists.
- **Diff base resolution.** [ASSUMPTION] "Epic base" is a resolvable ref at story-completion time (e.g. the epic branch's merge-base). Computing diff against the wrong base silently skews `diff_lines`/`diff_files`.
- **"No review findings" definition for the mismatch.** [ASSUMPTION] The finalize-time data exposes per-story review findings and gate status to the renderer; the over-spend flag depends on reading both. Needs confirmation that `EpicFinalizer` has story-level granularity (gate result appears epic-level today).
- **Heavy-bias is expected, not a bug.** The ledger will likely show most stories as `heavy`. That is the calibration signal being measured — surface it plainly rather than "correcting" it.
- **Self-assessment absence.** Without worker self-assessment (`SelfAssessment`), confidence defaults to `low`. [ASSUMPTION] This pass does not add self-assessment capture; the ledger documents the gap rather than closing it.

## Success Criteria

- After every story completes, exactly one `StorySignals` record exists in **both** `audit_log` (written before the result returns) and `.loom/signals/<story-id>.md`, with identical computed values across sinks.
- Heuristics are computed from existing state (diff vs. epic base, minimatch against `risky_paths`, first-try test result or `null`) — no new data collection paths.
- Tier and steps in every record match what `resolveCostTier`/`tierSteps` return for the same inputs (no divergent logic).
- Recording occurs **regardless of** `policy.agents.adaptive_cost`, and **no** execution path (reviewer count, verify phase, skill gen) changes as a result of any record.
- A forced persistence failure (e.g. unwritable `.loom/signals`) does **not** block or fail story completion.
- The epic PR body contains a "Build signal analysis" section beside the integration-gate section, listing per-story heuristics, recommended tier/steps, and any over-spend mismatch flags.
- `docs/capabilities.md` documents both the ledger files and the new PR section.
- Unit tests pass for: (a) heuristic computation, (b) record shape across both sinks, (c) the epic-review section renderer.
