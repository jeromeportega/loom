# Noise-Resistant Clustering in the Opportunity Engine

## Overview

The opportunity engine's non-agentic clustering step manufactures coherence where none exists: fed a pure-noise signal set, it returns one forced, low-coherence cluster instead of abstaining. The clustering prompt biases toward producing *some* grouping, making "nothing meaningful here" an unreachable answer — a false positive at the top of the funnel that propagates downstream and erodes trust in every opportunity surfaced. This PRD sharpens the clustering prompt so that **abstention becomes an explicit, legitimate outcome**: the model groups only when relatedness is real, prefers fewer-or-zero clusters over weak ones, and preserves its existing strong clustering on coherent inputs. The change is conceptual (a prompt shift) plus one regression test — confined to the non-agentic path, leaving the eval and the agentic path untouched.

## Goals

1. **Eliminate forced clustering on noise.** On the pure-noise signal set, the engine returns few or no clusters instead of one forced low-coherence cluster.
   - *Metric:* Noise-in → 0 clusters (tolerance: at most one low-coherence cluster); the previously-observed single forced cluster no longer appears.
2. **Preserve clustering quality on genuine signals.** Coherent signal sets cluster as well as they do today.
   - *Metric:* No regression — related-signal clustering output is unchanged from current behavior.
3. **Lock both behaviors with a test.** A new regression test encodes noise → few-or-no clusters and related → correct clustering.
   - *Metric:* The new test passes; the full test suite passes.

## User Stories

- **As an operator/consumer of opportunity-engine output**, I want a returned cluster to reflect a real signal relationship — not prompt-induced grouping pressure — so that I can trust the opportunities I act on. *(Must)*
- **As a loom maintainer**, I want the noise-resistance fix scoped tightly to the clustering prompt and one test, so that I raise abstention behavior without regressing strong clustering or touching the eval. *(Must)*

## Functional Requirements

- **FR-1:** The non-agentic clustering prompt MUST permit an empty result — returning zero clusters when no genuine relationship exists is a legitimate, explicitly-allowed outcome.
- **FR-2:** The clustering prompt MUST raise the grouping bar: signals are clustered only when a real coherence/relatedness threshold is met, and membership MUST NOT be forced merely to avoid an empty result.
- **FR-3:** The prompt MUST distinguish "weak because noise" from "weak because subtle-but-real," so that raising the bar does not suppress valid weak-but-real clusters.
- **FR-4:** Clustering behavior on genuinely related signal sets MUST remain unchanged — the prompt change preserves existing strong clustering on coherent inputs.
- **FR-5:** The change MUST be confined to the non-agentic clustering path; the agentic clustering path MUST be untouched.
- **FR-6:** A new regression test MUST assert both outcomes: a pure-noise signal fixture yields few-or-no clusters, and a related signal fixture yields correct clustering.
- **FR-7:** The noise assertion MUST tolerate LLM output variance (e.g., "zero or one low-coherence cluster" rather than strictly zero), so the test is not flaky. `[ASSUMPTION]` The exact tolerance is settled during implementation against observed variance.
- **FR-8:** The opportunity-engine eval MUST NOT be modified — the fix moves the eval result by changing the engine, not the measure.

## Epics

This PRD is a single epic: **Noise-resistant non-agentic clustering** — sharpen the clustering prompt and add the regression test. The work is one cohesive, single-module change and does not span separable shipping units.

## Out of Scope

- Any change to the **agentic/exploratory clustering path**.
- Any modification to the **opportunity-engine eval** (fixtures, assertions, or scoring).
- New modules, architectural changes, or refactors beyond the single clustering-prompt site and its accompanying test.
- A downstream numeric coherence threshold/score, if one does not already exist. `[ASSUMPTION]` Whether coherence is judged purely by the model from the prompt or against an existing downstream threshold is an open question to confirm during implementation; introducing a *new* scoring mechanism is out of scope for V1.
