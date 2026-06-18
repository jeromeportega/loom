# Worker Model Attribution & Accurate Token Telemetry

## The Problem

Loom's own operators cannot answer two basic observability questions about a worker run, and both gaps were surfaced while dogfooding loom on itself.

1. **No model attribution.** Loom records *nothing* about which model a worker actually ran on. The `agents` table has cost and token columns but no `model` column, decision traces omit it, and the run logs never print it. From every operator surface — status reads, traces, logs — there is no way to tell whether a worker executed on the configured policy model or silently fell back to a default. This bit hard historically: a routing bug ran every worker on a heavier default model instead of the configured one, and loom's own data could not surface the discrepancy during diagnosis.

2. **Under-counted token telemetry.** The per-worker token counts loom stores are implausibly low and incomplete. For some stories the input-token column holds *tens of tokens* against a multi-hundred-line diff, while the output-token and request-count columns sit empty. The symptom points at the usage harvest for the claude-code `stream-json` output capturing only a partial or final delta rather than the cumulative usage for the whole run.

These are observability defects, not feature gaps: loom already spends the tokens and routes the models — it just cannot faithfully report either.

## Target Users

- **Primary — Loom operators diagnosing runs.** Engineers using `loom status`, decision traces, and run logs to understand what executed, on which model, at what token cost. They need attribution and accurate counts to debug routing and cost anomalies.
- **Secondary — Loom maintainers (dogfooding).** The team improving loom through loom itself; both defects were found this way and will be validated this way.
- **Anti-persona — Cost-accounting consumers.** Anyone relying on the backend-reported **cost** figure. This work must not alter cost semantics; the dollar figure already comes from the backend and stays authoritative. Token counts are telemetry, not the source of truth for billing.

## Proposed Solution

Two independent fixes delivered together, both additive to the existing schema and surfaces.

- **Part 1 — Model attribution.** Add a `model` column to agent records, populate it at worker spawn from the resolved policy model for the role, and surface it on status read surfaces and in decision traces. Extend the same attribution to planner and reviewer records wherever a model is resolved, so attribution covers every role that spends tokens.
- **Part 2 — Accurate token telemetry.** Investigate and fix the claude-code `stream-json` usage harvest so it accumulates usage across the stream and persists cumulative totals for input, output, cached, and cache-creation tokens. Lock the fix with a test that drives a representative stream and asserts the persisted totals equal the summed usage.

## Key Capabilities

1. Persist the resolved model id on each agent record at spawn time.
2. Display the per-story model on status read surfaces (`loom status` and equivalent reads).
3. Carry the model through decision traces.
4. Apply model attribution to planner and reviewer records where a model is resolved.
5. Accumulate `stream-json` usage across the full worker stream and persist cumulative input/output/cached/cache-creation totals.
6. Provide a regression test that replays a representative usage sequence and asserts persisted totals equal the summed usage.

## Constraints

- **Cost semantics unchanged.** Do not modify the cost figure; it remains the backend-reported value.
- **Schema migration must be additive.** New column(s) only; existing rows must not be misclassified or rewritten. Existing data is left unchanged.
- **No guardrail weakened.** Policy engine and worktree isolation invariants stay intact.
- **No secret leakage.** Surface the **model id only** — never keys, endpoints, or credentials.
- **Full build and test suite must pass.**

## Risks and Open Questions

- **Backfill of existing rows.** The migration is additive, so rows predating the `model` column will have a null/empty model. *Open question:* should these read as `unknown` on surfaces, or be left blank? `[ASSUMPTION]` They are displayed as an explicit "unknown" rather than silently misclassified to any model.
- **Root cause of the harvest bug is unconfirmed.** The "partial or final delta" diagnosis is the leading hypothesis, not a verified cause. The investigation in Part 2 may reveal the loss happens at parse, accumulation, or persistence — the fix must follow the evidence.
- **Cached vs. cache-creation token semantics.** `[ASSUMPTION]` The claude-code `stream-json` stream distinguishes cached-read from cache-creation tokens and both are recoverable per event; if the stream collapses them, the persisted breakdown may be limited by what the backend emits.
- **"Resolved policy model" timing.** `[ASSUMPTION]` The model resolved at spawn is the one that actually executes; if a backend can override or remap the model after spawn, attribution should record the executed model, not merely the requested one — worth confirming against the routing bug's failure mode.
- **Request-count column.** The brief notes it is empty alongside token gaps. `[ASSUMPTION]` It is fed by the same harvest and is fixed by the same accumulation work; confirm during investigation.
- **Reviewer/planner coverage.** Scope is "where a model is resolved." Roles that do not resolve a model are out of scope; the PM should confirm which roles those are.

## Success Criteria

- [ ] `agents` records carry a `model` column populated at spawn from the resolved policy model.
- [ ] The model is visible **per story** on status surfaces and in decision traces.
- [ ] Planner and reviewer records carry the model where a model is resolved.
- [ ] The schema migration is additive and leaves existing rows unchanged (no misclassification).
- [ ] Persisted per-worker token counts (input, output, cached, cache-creation) reflect **cumulative** usage of the run, not a partial/final delta.
- [ ] A test drives a representative `stream-json` usage sequence and asserts the persisted totals equal the summed usage.
- [ ] Cost figures are unchanged; no guardrail is weakened; only the model id is surfaced (no secrets).
- [ ] The full build and test suite pass.
