# Worker Model Attribution & Accurate Token Telemetry

## Overview

Loom records the cost and token usage of every worker run but cannot faithfully report two basic facts about that run: which model executed it, and how many tokens it actually consumed. The `agents` table has no `model` column, so no operator surface — `loom status`, decision traces, or run logs — can show whether a worker ran on the configured policy model or a silent fallback. Separately, the per-worker token counts are implausibly low (tens of input tokens against multi-hundred-line diffs, with output and request-count columns often empty), pointing at a `stream-json` usage harvest that captures a partial or final delta instead of cumulative usage. Both gaps were found while dogfooding loom on itself. This PRD covers two independent, additive fixes — model attribution and accurate token telemetry — delivered together to close both observability defects without touching cost semantics or any guardrail.

## Goals

1. **Model attribution on every operator surface.** Every new agent record (worker, plus planner and reviewer where a model is resolved) carries the resolved model id, and that id is visible per story on status read surfaces and in decision traces. *Metric:* 100% of newly created agent records have a populated `model`; no read surface omits it; records predating the column read as an explicit `unknown`.
2. **Accurate cumulative token telemetry.** Persisted per-worker counts for input, output, cached, and cache-creation tokens reflect the cumulative usage of the whole run, and request-count is populated. *Metric:* a regression test replaying a representative `stream-json` sequence asserts persisted totals equal the summed usage across the stream.
3. **No collateral change to cost, guardrails, or secrets.** *Metric:* cost figures are byte-for-byte unchanged, policy-engine and worktree-isolation invariants hold, only the model id is surfaced (no keys/endpoints/credentials), and the full build and test suite pass.

## User Stories

- **As a loom operator diagnosing a run**, I want to see which model each story's worker actually ran on, so that I can detect routing bugs and silent fallbacks. *(Must)*
- **As a loom operator investigating cost anomalies**, I want accurate cumulative token counts per worker, so that I can trust telemetry when debugging. *(Must)*
- **As a loom maintainer dogfooding loom**, I want model attribution to extend to planner and reviewer records wherever a model is resolved, so that attribution covers every role that spends tokens. *(Should)*
- **As an operator viewing historical runs**, I want records created before this change to read as `unknown` rather than be misclassified to a model, so that I am never misled. *(Should)*

## Functional Requirements

- **FR-1** Add a `model` column to agent records via an additive schema migration.
- **FR-2** Populate `model` at worker spawn from the resolved policy model for the worker's role. If a backend can override or remap the model after spawn, record the executed model, not merely the requested one. `[ASSUMPTION]`
- **FR-3** Display the per-story model on status read surfaces (`loom status` and equivalent reads).
- **FR-4** Carry the model through decision traces.
- **FR-5** Apply the same attribution to planner and reviewer records wherever a model is resolved; roles that do not resolve a model are excluded.
- **FR-6** Agent records predating the `model` column display as an explicit `unknown` on all surfaces, never silently mapped to a model. `[ASSUMPTION]`
- **FR-7** Investigate the claude-code `stream-json` usage harvest, then accumulate usage across the full stream and persist cumulative totals for input, output, cached, and cache-creation tokens. The fix must follow the root-cause evidence (parse, accumulation, or persistence), not the leading hypothesis alone.
- **FR-8** Populate the request-count column from the same accumulated harvest. `[ASSUMPTION]`
- **FR-9** Provide a regression test that replays a representative `stream-json` usage sequence and asserts the persisted totals equal the summed usage.

## Non-Functional Requirements

- **NFR-1 (Compatibility)** The schema migration is additive — new column(s) only. Existing rows are left unchanged and are never rewritten or misclassified.
- **NFR-2 (Cost integrity)** The cost figure is not modified; it remains the backend-reported, authoritative value. Token counts are telemetry, not a billing source of truth.
- **NFR-3 (Security)** Only the model id is surfaced. No keys, endpoints, or credentials are exposed on any surface.
- **NFR-4 (Guardrails)** Policy-engine and worktree-isolation invariants remain intact; no guardrail is weakened.
- **NFR-5 (Quality gate)** The full build and test suite pass.

## Epics

This PRD breaks into two epics — the brief explicitly describes two independent, separately deliverable fixes:

- **Epic 1 — Model attribution.** Add and populate the `model` column at spawn (worker, planner, reviewer where resolved), and surface it on status reads and decision traces, with pre-migration rows shown as `unknown`. *(FR-1 – FR-6)*
- **Epic 2 — Accurate token telemetry.** Investigate and fix the `stream-json` usage harvest to accumulate and persist cumulative input/output/cached/cache-creation totals and request-count, locked by a replay regression test. *(FR-7 – FR-9)*

## Out of Scope

- Changing cost semantics or the dollar figure in any way.
- Model attribution for roles that do not resolve a model.
- Backfilling, rewriting, or reclassifying historical agent rows.
- Recovering a cached-read vs. cache-creation breakdown beyond what the backend's `stream-json` stream actually emits; if the stream collapses them, the persisted breakdown is limited accordingly. `[ASSUMPTION]`
- Any new error-handling, pagination, or instrumentation not required by the fixes above.
