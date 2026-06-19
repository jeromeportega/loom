Let me ground two load-bearing references — the cheap triage-model knob and the signal-ledger observe-only pattern this phase must mirror — before I write.# Project Brief: `loom weave` — Observe-Only Intake Complexity Classifier (Phase 0)

## The Problem

Loom has exactly one front door and one path: `loom epic "<brief>"` runs every brief through the brief-quality gate and then the full three-persona planner (Analyst → PM → Architect), and *everything* becomes an epic. This over-plans small work — a one-line fix or a single bug still pays a full Opus planning pass and is forced into the epic/story shape. Worse, an expensive, implicit classifier already exists: the planner silently decides scope (it has split single briefs into 2–4 epics), but that decision is emergent, unpredictable, and only discovered *after* paying for the full pass.

The design of record (`docs/architecture/intake-classification.md`) resolves this with a richer intake layer behind a new `loom weave` command that classifies intake cheaply on two orthogonal axes and sizes planning to match. That capability is load-bearing enough — it sits on loom's most critical seam, intake → planning — that it must be rolled out **observe-first**, exactly as the adaptive-cost signal ledger was de-risked. **This brief covers only Phase 0: the measurement harness that proves the classifier is trustworthy before any later phase lets it influence anything.**

## Target Users

- **Primary — the loom maintainer/operator dogfooding intake.** Needs to read the classifier's verdict back against what the planner actually produced, to measure how often it says bug vs. story vs. epic and whether it is right — before trusting it.
- **Secondary — future phases (P1–P4) and their authors.** P0 is the data foundation they build on; the verdict schema and persistence they inherit must be correct from the start.
- **Anti-persona — the operator running `loom epic` today.** They must notice *zero* change. `loom epic` behavior is frozen; `loom weave` is a sibling, not a replacement, in this phase.

## Proposed Solution

Introduce `loom weave` as a sibling command to `loom epic`. In Phase 0 it behaves **identically** to `loom epic` for planning and execution — same brief-quality gate, same three-persona planner, same resulting epic — with exactly one addition: **before planning, it makes one cheap classification call** using the existing triage model to size and type the brief, then **records the verdict durably and surfaces it read-only**. The verdict influences nothing. It exists solely so the maintainer can compare the classifier's proposal against the planner's emergent output.

This mirrors the signal-ledger's observe-only guarantee (NFR-1: "the ledger does NOT influence execution"). The classify-and-record path must be kept physically separate from the planning path.

## Key Capabilities

1. **`loom weave` command** — a sibling of `loom epic` that, in P0, plans and executes identically (runs the same gate and the same Analyst → PM → Architect planner, produces the same epic).
2. **One cheap classification call** — exactly one call per invocation to the configured triage model (`policy.agents.triage_model`, default Haiku), made before planning.
3. **Validated verdict** — a small, schema-validated structure: `type` (`feature` | `bug` | `chore`), `size` (`story` | `epic`), `confidence` (`low` | `medium` | `high`), and a short `rationale`.
4. **Durable additive persistence** — the verdict is recorded as an audit row and stored on the epic record, via an additive migration that does not misclassify existing rows.
5. **Read-only surfacing** — the verdict is readable back and shown on the status surface, never as a control input.
6. **Observe-only invariant, test-pinned** — a regression test proving planning and execution are byte-identical whether or not a verdict exists, and regardless of its value.
7. **Self-documenting** — a `describe` spec for `loom weave`, plus a `docs/capabilities.md` entry.

## Constraints

- **Do not change `loom epic` at all.** `loom weave` in this phase is `loom epic` *plus* a recorded verdict.
- **Reuse the existing `policy.agents.triage_model` knob.** Do not add a new model configuration knob. *(Grounded: defined at `packages/loom-core/src/types.ts:353`.)*
- **Exactly one cheap model call** per invocation for classification.
- **Do not weaken any guardrail.**
- **Keep the verdict schema small and validated** (e.g., a `zod` schema, consistent with existing schema discipline).
- **Additive migration only.** Current schema version is 22 (`packages/loom-core/src/state/Database.ts:5`); follow the established `ALTER TABLE … ADD COLUMN` additive pattern in `runMigrations`, bump to 23, no `DROP`/`TRUNCATE`, and preserve correct values for pre-existing rows.
- **`docs/capabilities.md`** must document `loom weave` and pass the capabilities drift check (`loom doctor --capabilities`).
- **A `describe` spec** must exist so `loom weave` appears in the manifest and passes the completeness test (`packages/loom-cli/src/describe/__tests__/`).
- **The full build and test suite must pass.**

## Risks and Open Questions

- **Observe-only leakage is the risk we will most regret.** No code path in the quality gate, planner, persona selection, or execution may read or branch on the verdict. *Mitigation:* keep the classify-and-record path physically separate from the planning path, and pin the invariant with a regression test asserting byte-identical planning/execution with no verdict, with a verdict, and across every verdict value. This is non-negotiable and is the primary acceptance gate.
- **Pre-existing epic rows must not be misclassified by the migration.** A new verdict column must default to a clear "no verdict recorded" state (e.g., `NULL`) rather than a fabricated classification. `[ASSUMPTION]` Rows created by `loom epic` (which never classifies) will permanently carry the null/absent verdict; readback and status surfaces must render that absence honestly, not as a default class.
- **`[ASSUMPTION]` The triage call is best-effort and must not block planning.** If the single classification call fails or times out, `loom weave` should record the failure (audit) and proceed with full planning unchanged — failing the classifier must never fail the run. *(Confirm against the design's intent; the observe-only principle implies the planning path is independent of classifier success.)*
- **`[ASSUMPTION]` Verdict storage shape.** The verdict is expected to live as column(s) on the `epics` table (mirroring how other epic-scoped data is stored) plus an audit row with a dedicated `action` (e.g., `intake_classified`), paralleling the signal-ledger's `story_signals` action. Exact column layout (single JSON blob vs. discrete columns) is an implementation choice for the PM/Architect to settle; the schema must remain small and validated either way.
- **Out of scope (do not build):** `--as` overrides and fast paths (P1), auto-routing (P2), import adapters (P3), provenance round-trip (P4), and the type-aware quality gate. The "chore" type is included in the schema for measurement, but no path consumes it. `loom epic` is *not* replaced in this phase.

## Success Criteria

- [ ] `loom weave` exists as a sibling of `loom epic` and, in this phase, plans and executes identically to it.
- [ ] On each invocation, `loom weave` makes **exactly one** triage-model classification call before planning and obtains a validated verdict with `type`, `size`, `confidence`, and `rationale`.
- [ ] The verdict is persisted additively, recorded in the audit log **and** on the epic record, is readable back, and is shown read-only on the status surface.
- [ ] A regression test proves the verdict never influences the quality gate, the planner, persona selection, or execution: behavior is identical with no verdict, with any verdict, and across all verdict values.
- [ ] `loom epic` behavior is unchanged.
- [ ] `docs/capabilities.md` documents `loom weave` and the capabilities drift check passes.
- [ ] `loom weave` has a `describe` spec that passes the completeness test.
- [ ] The full build and test suite pass.
