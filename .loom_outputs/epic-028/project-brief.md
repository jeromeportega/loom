# Conflict-Aware Decomposition for the loom Planner

## The Problem

loom's planner decides story granularity one logical task at a time, with no regard for whether the resulting stories can be developed in parallel. When a unit of work is concentrated in a single file, the planner happily splits it into several parallel stories whose branches **deterministically conflict** the moment they integrate.

This is not hypothetical — it has recurred:

- Many stories all appending to one client file.
- Seven stories all editing the same navigation region of the web dashboard's single `index.html`, which blocked an epic until an operator manually re-planned it as one story.

loom *already* notices same-file claims through its cross-epic overlap advisory, but the advisory only **warns** — it neither prevents nor resolves the collision. Meanwhile, decomposition granularity is decided independently of parallelizability, and file ownership is applied as an annotation *after* decomposition rather than as a constraint *on* it. The net effect: the operator is the safety net, forced to spot the guaranteed conflict and re-plan by hand.

## Target Users

- **Primary — loom operators** who plan and run epics. They currently absorb the cost of over-decomposition: a stalled epic, a manual re-plan, lost time. They should never have to tell the planner that cohesive single-file work is one story.
- **Secondary — loom maintainers** who own the planning pipeline (story-breakdown persona, shared contract, overlap detection, finalize-time dependency derivation) and must extend these without forking existing logic.
- **Anti-persona — the genuinely-parallel epic.** Stories that touch *different* files must keep their parallelism. The fix must serialize only on real same-file overlap; it must not become a blunt instrument that chains independent work and erodes throughput.

## Proposed Solution

Make decomposition conflict-aware through two complementary moves:

1. **A safety net** that detects same-file overlap *within* an epic at plan time and serializes the offending stories by adding dependency ordering — removing the collision without touching story content.
2. **Source-side reduction** that guides the planning personas to emit cohesive single-file work as one story in the first place, so the safety net is rarely needed.

Both reuse loom's existing **path-aware** overlap detection rather than inventing a parallel mechanism — the work *extends* what already exists to act within an epic.

## Key Capabilities

1. **Within-epic same-file detection** at plan time, reusing the existing path-aware overlap logic, driven by each story's declared file ownership from the shared contract plus tech notes. Detection operates on real file paths, never free-text tokens.
2. **Automatic serialization** — when ≥2 stories in an epic would edit the same file, add a hard dependency ordering so they integrate sequentially instead of in parallel.
3. **Reason recording** — record in the plan or an audit entry that the dependency was added for same-file-conflict avoidance, so the operator can see *why* the ordering exists.
4. **Non-destructive guarantee** — serialization only *adds* ordering; it never drops or merges story content.
5. **Persona guidance** — instruct the personas that produce the story breakdown and the shared contract to prefer fewer, cohesive stories split along independently-developable file/module boundaries, and to emit single-file-concentrated (or tightly-coupled-region) work as one story.
6. **Verification fixture** — a representative brief whose work concentrates in one file, asserting the resulting story graph contains no two same-file stories without an ordering dependency between them.

## Constraints

- **Reuse, don't fork.** Extend the existing path-aware overlap detector to act within an epic; do not invent a second detection path.
- **No guardrail weakened.** All existing policy and isolation guarantees remain intact.
- **Don't break what exists.** The cross-epic overlap advisory and path-aware detection must continue to behave as today.
- **Ordering only.** Part-two serialization adds dependency edges exclusively — never deletes or merges story content.
- **Scope to planning.** Limit changes to planning and shared-contract / finalize-time dependency derivation. Worker execution is unchanged beyond honoring the added dependencies, which the supervisor already does.
- **Capabilities currency.** Update `docs/capabilities.md` if user-visible behavior or a knob changes, and pass the capabilities drift check.

## Risks and Open Questions

- **Detection is only as good as the ownership map.** If a story edits a file it never declared in the shared contract or tech notes, the overlap goes undetected and the conflict survives. `[ASSUMPTION]` declared ownership is accurate and complete enough at plan time to drive detection; if not, detection coverage is the limiting factor.
- **Ordering shape for N>2.** When three or more stories share a file, the brief says they should "integrate sequentially." `[ASSUMPTION]` this means a single linear chain (a total order) rather than an arbitrary partial order — worth confirming, as it determines how much parallelism is sacrificed.
- **Where the reason is recorded.** The brief allows "the plan *or* an audit entry." `[ASSUMPTION]` an audit entry is the minimum bar; surfacing it in the plan is preferable for operator visibility. The exact locus is open.
- **Over-correction risk.** Persona guidance must not collapse genuinely separable work into one oversized story. The "independently-developable boundaries" framing is the guardrail against this, but the balance between under- and over-decomposition should be watched.
- **Knob vs. always-on.** `[ASSUMPTION]` the behavior is automatic and always-on (no operator opt-out), which means the capabilities page documents a behavior rather than a knob. Confirm whether an escape hatch is wanted.
- **Throughput trade-off is intentional.** Serialization genuinely reduces parallelism for same-file stories. This is acceptable because the alternative is a deterministic merge conflict — but it should be stated plainly, not hidden.

## Success Criteria

1. At plan time, loom detects when two or more stories in an epic would edit the same **real** file, using the existing path-aware overlap detection (no new parallel mechanism).
2. On detection, loom adds a hard dependency ordering so those stories integrate sequentially, recorded with a reason — and **no** story content is merged or dropped.
3. The planning personas are guided to prefer cohesive stories along independently-developable boundaries and to emit single-file-concentrated work as one story, so a cohesive single-file change is planned as one story without operator intervention.
4. A test proves that a brief whose work concentrates in one file (fixture: several changes to one dashboard file) yields a story graph with **no two same-file stories that lack an ordering dependency** between them.
5. The cross-epic overlap advisory and path-aware detection retain their existing behavior; no guardrail is weakened.
6. `docs/capabilities.md` is updated for any user-visible change and the capabilities drift check passes.
7. The full build and test suite pass.
