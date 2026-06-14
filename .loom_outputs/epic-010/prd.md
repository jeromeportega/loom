# Per-Story Signal Ledger (Observe-Only Cost-Control Harness)

## Overview

Loom already carries the machinery for adaptive cost control — a deterministic tier resolver (`resolveCostTier`), a tier→steps mapping (`tierSteps`), and the `policy.agents.adaptive_cost` knob — but it has never been validated against real runs. Today the cost signals are computed implicitly inside dispatch and discarded, so there is no record to audit whether a tier call was correct. This feature adds an **observe-only signal ledger**: at each story's completion it computes cheap heuristics from data loom already has, resolves the implied tier/steps with the *existing* `tier.ts` functions, and persists one `StorySignals` record per story to two sinks — an `audit_log` row and a markdown file under `.loom/signals/<story-id>.md`. The `EpicFinalizer` reads these records back to append a per-story "Build signal analysis" section to the epic PR body. Critically, **no execution path changes** — the resolver's output is recorded, not enforced. The ledger is the validation harness that must exist *before* loom can be trusted to gate on these signals.

## Goals

1. **Produce per-story cost-signal evidence on real runs.** Success metric: every completed story yields exactly one `StorySignals` record in *both* sinks (`audit_log` and `.loom/signals/<story-id>.md`) with identical computed values.
2. **Surface the known calibration gap to operators plainly.** Success metric: each record's resolved tier/steps match `resolveCostTier`/`tierSteps` for the same inputs, and the epic PR body lists them per story so the expected `heavy`-bias is visible rather than hidden.
3. **Guarantee zero execution impact.** Success metric: no execution path (reviewer count, verify phase, skill generation) reads the ledger or changes as a result of any record, verified by regression tests, and recording occurs regardless of `policy.agents.adaptive_cost`.
4. **Never let observation break delivery.** Success metric: a forced persistence failure (e.g. unwritable `.loom/signals`) does not block or fail story completion.

## User Stories

- **As a loom operator/maintainer, I want** a per-story record of the computed heuristics and the implied tier/steps **so that** I can decide whether and how to turn on adaptive gating later. *(Must)*
- **As the epic PR reviewer, I want** a "Build signal analysis" section in the epic PR body **so that** I see recommendations and mismatches inline while reviewing the epic. *(Must)*
- **As a maintainer, I want** over-spend mismatches flagged **so that** I can identify stories that future gating could safely downgrade. *(Should)*

## Functional Requirements

- **FR-1** — At each story completion, compute `HeuristicSignals`: `diff_lines` and `diff_files` for the story branch vs. the epic base; `risky_paths_touched` = changed files matching `policy.agents.risky_paths` via minimatch; `tests_green_first_try` = the first-try test result, or `null` when unavailable.
- **FR-2** — Resolve tier and steps by calling the *existing* `resolveCostTier` and `tierSteps`. No new decision logic; no divergence from their output.
- **FR-3** — Persist one `StorySignals` record to two sinks: an `audit_log` row and a markdown file at `.loom/signals/<story-id>.md`. Computed values MUST be identical across both sinks.
- **FR-4** — Map field-name casing during persistence: `tierSteps` returns camelCase (`verifyPhase`, `skillGen`) while `StorySignals.steps` is snake_case (`verify_phase`, `skill_gen`). The persistence layer maps these, and a cross-sink shape test pins the mapping.
- **FR-5** — Record **always**, independent of `policy.agents.adaptive_cost`. The ledger runs before any gating exists.
- **FR-6** — `EpicFinalizer` reads the ledger records (never writes them) and appends a "Build signal analysis" section to the epic PR body, beside the existing integration-gate section, listing per story: the heuristics, the recommended tier and steps, and any flagged mismatches.
- **FR-7** — Flag the over-spend mismatch: a story recommended `heavy` that then sailed through finalize with no review findings and a green gate is marked as a candidate that future gating could safely downgrade. (The under-spend direction is deliberately *not* flagged — see Out of Scope.)
- **FR-8** — Persistence is best-effort: any failure to write either sink is swallowed and MUST never block or fail story completion.
- **FR-9** — Update `docs/capabilities.md` to document both the new ledger files and the new epic-PR section.

## Non-Functional Requirements

- **NFR-1 (Observe-only)** — Nothing may read the ledger to change execution. No reviewer count, verify phase, or skill-generation decision may depend on a record. This is the load-bearing constraint of the feature.
- **NFR-2 (Logging invariant)** — Per CLAUDE.md #5, the `audit_log` row is written *before* the story result returns to the caller.
- **NFR-3 (Run state, not artifact)** — `.loom/signals` is gitignored run state, consistent with `.loom/` as dogfood/run state; ledger files are not committed.
- **NFR-4 (No new data collection)** — Heuristics are derived only from existing state (diff vs. epic base, minimatch against `risky_paths`, first-try test result or `null`). No new data-collection paths are introduced.

## Assumptions to Confirm at the Write Site

- **[ASSUMPTION]** The Supervisor/worker path at story completion has access to a first-try test result. If not, `tests_green_first_try` will systematically be `null`; the write site must confirm the signal source exists.
- **[ASSUMPTION]** The "epic base" is a resolvable ref at story-completion time (e.g. the epic branch's merge-base). Diffing against the wrong base silently skews `diff_lines`/`diff_files`.
- **[ASSUMPTION]** Finalize-time data exposes per-story review findings and gate status to the renderer. The over-spend flag (FR-7) depends on reading both; gate result appears epic-level today, so `EpicFinalizer` story-level granularity needs confirmation.
- **[ASSUMPTION]** This pass does not add worker self-assessment (`SelfAssessment`) capture. Confidence therefore defaults to `low`, and the ledger documents this gap rather than closing it. The expected result is a `heavy`-biased ledger — that bias is the calibration signal being measured, not a defect to correct.

## Epics

This PRD is a single cohesive piece of work and breaks into **one epic**:

- **Epic 1 — Observe-only per-story signal ledger**: compute heuristics, resolve tier/steps via existing `tier.ts`, persist to both sinks at story completion, render the epic-PR analysis section in `EpicFinalizer`, and document in `docs/capabilities.md`.

## Out of Scope

- **Gating / enforcement of any kind.** Nothing reads the ledger to change reviewer count, verify phases, or skill generation. This release only observes.
- **Worker self-assessment (`SelfAssessment`) capture.** Confidence stays defaulting to `low`; closing that gap is future work.
- **Under-spend mismatch detection.** Only the over-spend direction is flagged, because the under-spend direction is not trustworthy given the `heavy`-bias calibration gap.
- **New data-collection paths.** Only signals derivable from existing state are computed.
- **"Correcting" the heavy-bias.** Surfacing it plainly is the goal; tuning the heuristics is a separate, later effort informed by this ledger.
