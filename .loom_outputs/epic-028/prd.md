# Conflict-Aware Decomposition for the loom Planner

## Overview

loom's planner sizes stories one logical task at a time without checking whether the resulting stories can actually be developed in parallel. When a unit of work is concentrated in a single file, the planner splits it into multiple parallel stories whose branches deterministically conflict at integration — a failure that has recurred in practice (many stories appending to one client file; seven stories editing the same nav region of a single `index.html`, which stalled an epic until an operator hand-replanned it as one story). loom already detects same-file claims via its cross-epic overlap advisory, but the advisory only *warns* — it neither prevents nor resolves the collision, leaving the operator as the safety net. This feature makes decomposition conflict-aware: a plan-time safety net that serializes same-file stories by adding dependency ordering, plus persona guidance that emits cohesive single-file work as one story in the first place — both reusing loom's existing path-aware overlap detection rather than inventing a parallel mechanism.

## Goals

1. **Eliminate deterministic same-file merge conflicts at plan time.** Success metric: the verification fixture (a brief concentrating work in one dashboard file) yields a story graph with zero pairs of same-file stories lacking an ordering dependency between them.
2. **Reduce reliance on source-side over-decomposition.** Success metric: cohesive single-file-concentrated work is planned as one story without operator intervention, so the serialization safety net fires rarely rather than routinely.
3. **Preserve parallelism for genuinely independent work.** Success metric: stories touching different files retain their parallel ordering; serialization edges are added only on real same-file overlap, never on free-text token similarity.
4. **Operator transparency.** Success metric: every conflict-avoidance dependency is recorded with a machine-readable reason an operator can inspect.

## User Stories

- **As a loom operator**, I want the planner to serialize stories that would edit the same file, so that I never have to spot a guaranteed merge conflict and re-plan by hand. *(Must)*
- **As a loom operator**, I want cohesive single-file work planned as one story up front, so that I don't have to tell the planner that obviously-coupled work belongs together. *(Must)*
- **As a loom operator**, I want to see *why* a dependency was added, so that I can trust the ordering wasn't an arbitrary loss of parallelism. *(Should)*
- **As a loom maintainer**, I want this built by extending the existing path-aware overlap detector, so that I'm not maintaining a second, divergent detection path. *(Must)*

## Functional Requirements

- **FR-1** At plan time, loom detects when ≥2 stories within a single epic would edit the same real file path, reusing the existing path-aware overlap detection (no new parallel detection mechanism).
- **FR-2** Detection is driven by each story's declared file ownership from the shared contract plus tech notes, operating on real file paths only — never on free-text tokens.
- **FR-3** On detection, loom adds a hard dependency ordering between the offending stories so they integrate sequentially rather than in parallel.
- **FR-4** For N>2 stories sharing a file, the added ordering forms a single linear chain (total order) so they integrate one at a time. `[ASSUMPTION]` "integrate sequentially" means a total order, not an arbitrary partial order.
- **FR-5** Serialization only *adds* dependency edges; it never deletes, merges, or otherwise modifies story content.
- **FR-6** Each added dependency records a machine-readable reason indicating it was added for same-file-conflict avoidance. `[ASSUMPTION]` an audit entry is the minimum bar; surfacing the reason in the plan is preferred for operator visibility.
- **FR-7** The story-breakdown persona and the shared-contract persona are guided to prefer fewer, cohesive stories split along independently-developable file/module boundaries, and to emit single-file-concentrated (or tightly-coupled-region) work as one story.
- **FR-8** The behavior is automatic and always-on, with no operator opt-out knob. `[ASSUMPTION]` no escape hatch is wanted; confirm before adding one.
- **FR-9** A verification fixture — a representative brief whose work concentrates in one file — asserts the resulting story graph contains no two same-file stories without an ordering dependency between them.
- **FR-10** `docs/capabilities.md` is updated to document the new always-on behavior, and the capabilities drift check passes.

## Non-Functional Requirements

- **NFR-1 (Reuse)** The within-epic detection extends the existing path-aware overlap detector; no second detection code path is introduced.
- **NFR-2 (Backward compatibility)** The cross-epic overlap advisory and existing path-aware detection retain their current behavior; no policy or worktree-isolation guarantee is weakened.
- **NFR-3 (Scope containment)** Changes are confined to planning and shared-contract / finalize-time dependency derivation. Worker execution is unchanged beyond honoring the added dependencies, which the supervisor already does.

## Epics

This PRD is delivered as **one epic**: *Conflict-Aware Decomposition for the loom Planner*, covering within-epic same-file detection, automatic serialization with reason recording, persona guidance, and the verification fixture.

## Out of Scope

- Detecting conflicts from files a story edits but never declared in the shared contract or tech notes (`[ASSUMPTION]` declared ownership is accurate and complete enough at plan time; undeclared edits remain undetectable and are the coverage limit).
- An operator opt-out knob or per-epic escape hatch (pending confirmation under FR-8).
- Sub-file / region-level conflict resolution that would let two stories safely share a file — serialization is at file granularity.
- Any change to worker execution semantics beyond honoring the added dependencies.
- Resolving cross-epic (as opposed to within-epic) same-file collisions, which remain advisory-only as today.
