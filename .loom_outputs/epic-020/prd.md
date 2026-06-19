# PRD: `loom weave` — Observe-Only Intake Complexity Classifier (Phase 0)

## Overview

Loom has one front door: `loom epic "<brief>"` sends every brief through the brief-quality gate and the full three-persona planner (Analyst → PM → Architect), turning *everything* into an epic. This over-plans small work and hides an expensive, implicit classifier — the planner silently decides scope (sometimes splitting one brief into 2–4 epics), but only after the full Opus pass is paid for. The design of record (`docs/architecture/intake-classification.md`) introduces `loom weave` to classify intake cheaply and size planning to match. Because this sits on loom's most critical seam — intake → planning — it must be rolled out observe-first, mirroring how the adaptive-cost signal ledger was de-risked. **This PRD covers Phase 0 only: the measurement harness that proves the classifier is trustworthy before any later phase lets it influence anything.** In P0, `loom weave` is `loom epic` *plus* one recorded verdict that controls nothing.

## Goals

1. **Make the classifier measurable.** Every `loom weave` run records a validated verdict (or a recorded failure) that the maintainer can read back against the planner's emergent output.
   - *Metric:* 100% of `loom weave` invocations produce either a readable persisted verdict or a recorded classification-failure audit row.
2. **Guarantee observe-only — zero behavioral drift.** Planning and execution are byte-identical whether or not a verdict exists, and regardless of its value; `loom epic` is unchanged.
   - *Metric:* a regression test passes asserting identical planning/execution across three conditions: no verdict, a verdict present, and every verdict value.
3. **Keep classification cheap and bounded.** Exactly one triage-model call per invocation, reusing the existing knob.
   - *Metric:* exactly 1 call to `policy.agents.triage_model` per `loom weave` invocation; zero new model-configuration knobs introduced.

## User Stories

- **Must** — As the loom maintainer dogfooding intake, I want `loom weave` to record what the classifier *thinks* a brief is (type/size/confidence) alongside the epic the planner actually produced, so that I can measure how often it agrees before trusting it.
- **Must** — As the operator running `loom epic` today, I want `loom weave` to be a pure sibling, so that my existing workflow sees zero change.
- **Should** — As an author of a future phase (P1–P4), I want the verdict schema and persistence to be correct and additive from the start, so that I can build routing on a trustworthy data foundation.
- **Should** — As the maintainer, I want absent verdicts (rows from `loom epic`, or failed classifications) rendered honestly as "no verdict," so that I never mistake an absence for a real classification.

## Functional Requirements

- **FR-1** — `loom weave` exists as a CLI command and, in P0, runs the same brief-quality gate, the same Analyst → PM → Architect planner, and the same execution path as `loom epic`, producing the same epic.
- **FR-2** — Before planning, `loom weave` makes **exactly one** classification call to the configured triage model (`policy.agents.triage_model`, default Haiku). No new model-config knob is added.
- **FR-3** — The call returns a schema-validated verdict with: `type` (`feature` | `bug` | `chore`), `size` (`story` | `epic`), `confidence` (`low` | `medium` | `high`), and a short `rationale`. Validation uses a small `zod` schema consistent with existing schema discipline.
- **FR-4** — The verdict is persisted additively: recorded as an audit row with a dedicated action (e.g., `intake_classified`) **and** stored on the epic record. Storage is introduced via an additive migration (`ALTER TABLE … ADD COLUMN`), bumping schema version 22 → 23, with no `DROP`/`TRUNCATE`.
- **FR-5** — Pre-existing epic rows (created by `loom epic`, which never classifies) default to a clear "no verdict recorded" state (e.g., `NULL`), never a fabricated class.
- **FR-6** — The verdict is readable back and surfaced read-only on the status surface. Absent/null verdicts render honestly as "no verdict," not as a default class.
- **FR-7** — If the single classification call fails or times out, `loom weave` records the failure (audit) and proceeds with full planning unchanged. A classifier failure never fails the run. *[ASSUMPTION — confirm against design intent; the observe-only principle implies the planning path is independent of classifier success.]*
- **FR-8** — `loom weave` ships a `describe` spec so it appears in the manifest and passes the CLI completeness test.
- **FR-9** — `docs/capabilities.md` documents `loom weave` and passes the capabilities drift check (`loom doctor --capabilities`).

## Non-Functional Requirements

- **NFR-1 (observe-only, non-negotiable)** — No code path in the quality gate, planner, persona selection, or execution may read or branch on the verdict. The classify-and-record path is kept physically separate from the planning path. This invariant is pinned by the FR-2/FR-3 regression test described in Goal 2.
- **NFR-2 (non-blocking classification)** — Classification is best-effort; it must not block or delay the planning path on failure or timeout (see FR-7).
- **NFR-3 (additive-only migration)** — The migration must preserve correct values for all pre-existing rows; no destructive operations.
- **NFR-4 (no guardrail weakening)** — No existing guardrail is loosened or bypassed to add this command.

## Epics

This PRD is **one epic**: *`loom weave` observe-only intake classifier (Phase 0)* — the sibling command, the single triage call, the validated verdict, additive persistence + migration, read-only surfacing, the observe-only regression test, and the `describe`/capabilities documentation.

## Out of Scope (V1 / Phase 0)

- `--as` overrides and fast paths (P1).
- Auto-routing on the verdict (P2).
- Import adapters (P3).
- Provenance round-trip (P4).
- The type-aware quality gate.
- Any path that *consumes* the verdict — including the `chore` type, which is in the schema for measurement only.
- Replacing or modifying `loom epic`; it remains frozen and unchanged in this phase.
