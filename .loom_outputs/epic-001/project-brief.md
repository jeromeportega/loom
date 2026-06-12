# Brief-Quality Gate Overhaul: Judgment-Based Pass Signal, Forced Override, and Model Routing Fix

## The Problem

The brief-quality gate in loom structurally refuses good briefs. `computeQualityScore` in `packages/loom-core/src/brief/BriefRefiner.ts` derives the score arithmetically — `10 − min(ambiguities,3) − min(missing_scope,3) − min(untestable_claims,3) − min(hidden_complexity,3)` — from the lengths of critique arrays the refiner model emits. A thorough critic populates ~3 items per category on *any* input, including a brief that incorporated the refiner's own previous `refined_brief` nearly verbatim. The score therefore floors at 0/10 regardless of actual quality.

Three concrete failure modes, all observed in an earlier epic-011 end-to-end run:

1. **Structural refusal** — good briefs score 0; the repo had to set `min_brief_quality_score: 0` to disable the gate entirely.
2. **Consequential nondeterminism** — an identical brief passed on one call and scored 0/10 on the next.
3. **Non-converging rejection loop** — answering every question in a rejection yields a fresh batch of lower-importance questions and another 0. There is no exit.

A fourth, independent defect compounds this: the gate and the planner run on different models. `packages/loom-mcp/src/tools/handlers.ts` (~line 488) constructs `BriefRefiner` with `model: policy.agents.model`, while the Planner two calls later resolves via `modelFor(policy, 'planning')`. On the cursor-cli backend the gate ignores `cursor_model` and passes a Claude-namespaced id to cursor-agent — silently.

**Who is harmed:** operators running `loom epic` / `loom_start_epic`, who hit an unbypassable, advertised-as-"non-negotiable" gate that rejects work it should pass; and downstream planning agents, which never receive briefs the gate wrongly blocks.

## Target Users

- **Primary:** loom operators starting epics via the CLI (`loom epic`) or MCP (`loom_start_epic`).
- **Secondary:** repo administrators tuning `min_brief_quality_score` in `.loom/policy.yaml`; the PM/planner agents consuming gated briefs.
- **Anti-persona:** an operator seeking to permanently silence quality feedback. The override is per-invocation and audit-logged, not a standing config switch — the critique still exists for human review.

## Proposed Solution

Replace the derived score with the model's own judgment, give the loop a human-controlled exit, and unify model routing. Three parts:

1. **Judgment-based pass signal.** Use the `ready: boolean` field the refiner already emits as the primary gate signal — its schema rule already encodes the right semantics ("ready is true only when every critique array except strong_points is acceptably small AND the brief is something the planner could decompose without inventing requirements"). Have the model emit a holistic 0–10 `quality_score` in the same JSON response for threshold tuning and reporting. Stop deriving the score from critique-array lengths. Preserve the malformed-JSON fallback and truncation-salvage behaviors with sensible `ready`/`score` values.
2. **Audit-logged escape hatch.** Add `force: true` to the `loom_start_epic` MCP tool and `--force` to `loom epic`, skipping the gate after a human has reviewed the critique. Every forced start writes an audit row (consistent with the loom invariant that all agent actions are logged).
3. **Model routing fix.** Route the refiner's model through `modelFor(policy, 'planning')` in `packages/loom-mcp/src/tools/handlers.ts`, and audit `packages/loom-cli/src/commands/epic.ts` (~line 47) for the same bug, so gate and planner always run on the same resolved model.

## Key Capabilities

1. Gate pass/fail determined by the refiner's `ready` boolean, not critique-array arithmetic.
2. Model-emitted holistic `quality_score` (0–10) in the same response, used for threshold comparison and reporting against the default threshold of 6.
3. Salvage paths (malformed JSON, truncation) preserved, emitting defensible `ready`/`score` defaults.
4. `--force` (CLI) and `force: true` (MCP) skip the gate; each use leaves an audit row.
5. Copy corrected everywhere the gate is described as unbypassable: the `loom_start_epic` description in `packages/loom-mcp/src/tools/registry.ts` ("cannot be bypassed"), the policy comment written by `loom init` (`packages/loom-cli/src/commands/init.ts`), and the gate rows in `docs/capabilities.md` ("non-negotiable").
6. Refiner model resolved via `modelFor` on both the MCP and CLI entry points.

## Constraints

- **Non-goals (explicit):** no planner changes; no new personas; no CLI surface beyond `--force`; no change to the refusal payload shape beyond what the new scoring requires.
- **Repo invariants:** forced bypass must be audit-logged before returning to the caller; `docs/capabilities.md` must be updated in the same PR (it is the public capability surface).
- **Compatibility:** the default threshold remains 6; the policy knob `min_brief_quality_score` keeps its name and range.
- **Test surface:** `packages/loom-core/src/__tests__/BriefRefinement.test.ts` and `BriefRefinerSalvage.test.ts` must be updated to the new score semantics — they currently encode the derived-score behavior.

## Risks and Open Questions

- **Signal precedence is underspecified.** When `ready: false` but `quality_score ≥ 6` (or the inverse), which wins? The brief names `ready` as *primary* and the score as *tuning/reporting*, and acceptance requires passing "at the default threshold of 6" — these need one reconciled rule. `[ASSUMPTION]` Gate passes when `ready === true` AND `quality_score ≥ threshold`; the threshold exists so operators can tighten beyond the model's own judgment.
- **Salvage defaults are unspecified.** "Sensible" `ready`/`score` values for malformed-JSON and truncation paths must be chosen. `[ASSUMPTION]` Fail closed (`ready: false`, low score) — a response we couldn't parse is not evidence of a good brief, and `--force` now provides the exit.
- **Nondeterminism is reduced, not eliminated.** `ready` is still a model judgment; an identical brief may still flip across calls. The escape hatch bounds the damage but the acceptance test ("passes without retries") may be flaky without prompt or temperature attention.
- **CLI bug presence unconfirmed.** The brief says to *check* `epic.ts` for the routing bug — it is suspected, not verified. Scope the fix conditionally.
- **Repos that disabled the gate.** one repo set `min_brief_quality_score: 0` as a workaround. `[ASSUMPTION]` With threshold 0 the new gate still consults `ready`; affected repos should restore the default after this ships, which may warrant a release note.
- **Force must not suppress critique.** `[ASSUMPTION]` The refiner still runs and its critique is still recorded on a forced start — the human reviewed *something*, and the audit row should reference it.

## Success Criteria

1. A concrete, well-scoped brief passes the gate at the default threshold of 6 without retries.
2. Forcing past a rejection works from both `loom epic --force` and `loom_start_epic` with `force: true`, and each forced start leaves an audit row.
3. The refiner resolves its model through `modelFor` on both the MCP and CLI entry points; on the cursor-cli backend the gate honors `cursor_model`.
4. `BriefRefinement.test.ts` and `BriefRefinerSalvage.test.ts` pass under the new score semantics; new tests cover the force path and model routing.
5. No remaining copy describes the gate as unbypassable: `registry.ts` tool description, `loom init` policy comment, and `docs/capabilities.md` gate rows all reflect the `--force` escape hatch.
