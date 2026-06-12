# PRD: Brief-Quality Gate Overhaul

## Overview

Loom's brief-quality gate currently derives its 0–10 score arithmetically from the lengths of critique arrays the refiner model emits, which floors good briefs at 0/10, flips verdicts nondeterministically between identical calls, and traps operators in a rejection loop with no exit. A separate defect causes the gate and the planner to resolve different models — on the cursor-cli backend the gate silently ignores `cursor_model`. This PRD replaces the derived score with the model's own judgment (`ready` boolean plus a holistic model-emitted `quality_score`), adds an audit-logged per-invocation override (`--force` / `force: true`), unifies model routing through `modelFor(policy, 'planning')`, and corrects all copy that advertises the gate as unbypassable.

## Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G1 | Good briefs pass the gate | A concrete, well-scoped brief passes at the default threshold of 6 without retries |
| G2 | Humans have a bounded exit from rejection | A forced start succeeds from both `loom epic --force` and `loom_start_epic` with `force: true`; 100% of forced starts produce an audit row |
| G3 | Gate and planner always agree on the model | Both MCP and CLI entry points resolve the refiner's model via `modelFor(policy, 'planning')`; on the cursor-cli backend the gate honors `cursor_model` |
| G4 | Public surface tells the truth | Zero remaining copy describes the gate as unbypassable (`registry.ts` tool description, `loom init` policy comment, `docs/capabilities.md` gate rows) |

## User Stories

- **As a** loom operator starting an epic via `loom epic` or `loom_start_epic`, **I want** the gate to judge my brief holistically instead of counting critique items, **so that** a good brief passes on the first attempt. *(Must)*
- **As a** loom operator stuck in a rejection loop, **I want** a per-invocation `--force` / `force: true` override, **so that** I can proceed after reviewing the critique myself. *(Must)*
- **As a** repo administrator, **I want** forced starts audit-logged with the critique still recorded, **so that** the override cannot become a silent standing bypass. *(Must)*
- **As a** repo administrator tuning `min_brief_quality_score`, **I want** the threshold to compare against a model-emitted holistic score, **so that** the knob keeps its name, range, and default while becoming meaningful again. *(Should)*
- **As a** planner agent, **I want** the gate to run on the same resolved model as planning, **so that** gate verdicts reflect the model that will actually consume the brief. *(Must)*

## Functional Requirements

- **FR-1** — The gate's pass/fail decision uses the refiner's `ready: boolean` field as the primary signal. `computeQualityScore`'s critique-array-length arithmetic is removed. `[ASSUMPTION]` Reconciled precedence rule: the gate passes when `ready === true` AND `quality_score ≥ threshold`; the threshold lets operators tighten beyond the model's own judgment.
- **FR-2** — The refiner emits a holistic 0–10 `quality_score` in the same JSON response, used for threshold comparison against `min_brief_quality_score` (default 6) and for reporting.
- **FR-3** — The malformed-JSON fallback and truncation-salvage paths are preserved and emit defensible defaults. `[ASSUMPTION]` Fail closed: `ready: false` and a low score, since an unparseable response is not evidence of a good brief and `--force` now provides the exit.
- **FR-4** — `loom epic` accepts `--force` and `loom_start_epic` accepts `force: true`; either skips the gate for that invocation only.
- **FR-5** — Every forced start writes an audit row before returning to the caller. `[ASSUMPTION]` The refiner still runs on a forced start and its critique is recorded and referenced by the audit row.
- **FR-6** — The refiner's model is resolved via `modelFor(policy, 'planning')` in `packages/loom-mcp/src/tools/handlers.ts`. `packages/loom-cli/src/commands/epic.ts` (~line 47) is audited for the same defect and fixed only if present.
- **FR-7** — All copy describing the gate as unbypassable is corrected: the `loom_start_epic` description in `packages/loom-mcp/src/tools/registry.ts`, the policy comment written by `loom init` in `packages/loom-cli/src/commands/init.ts`, and the gate rows in `docs/capabilities.md` — each reflecting the `--force` escape hatch.
- **FR-8** — `BriefRefinement.test.ts` and `BriefRefinerSalvage.test.ts` are updated to the new score semantics; new tests cover the force path (CLI and MCP, including the audit row) and model routing on both entry points.

## Non-Functional Requirements

- **NFR-1 — Compatibility:** the default threshold remains 6; the policy knob `min_brief_quality_score` keeps its existing name and 0–10 range. Repos that set the threshold to 0 as a workaround still get `ready` consulted by the new gate. `[ASSUMPTION]` A release note advises affected repos to restore the default.
- **NFR-2 — Audit invariant:** the forced-bypass audit row is written before control returns to the caller, consistent with loom's all-agent-actions-are-logged invariant.

## Epics

This PRD breaks into **one epic**:

1. **epic-001 — Brief-Quality Gate Overhaul** — judgment-based pass signal, audit-logged force override, model routing unification, and copy/test updates. The brief describes one cohesive change to a single gate; the routing fix and copy corrections only have meaning as part of the same shipping unit.

## Out of Scope

- Planner changes of any kind.
- New personas.
- CLI surface beyond the single `--force` flag.
- Changes to the refusal payload shape beyond what the new scoring requires.
- A standing config switch to permanently disable critique (the override is per-invocation and audit-logged by design).
- Eliminating model nondeterminism — `ready` remains a model judgment; prompt/temperature hardening is acknowledged as a risk but is not a deliverable of this epic.
- Renaming or re-ranging the `min_brief_quality_score` policy knob.
