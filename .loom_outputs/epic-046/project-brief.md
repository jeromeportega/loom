# Noise-Resistant Clustering in the Opportunity Engine

## The Problem

The opportunity engine's clustering step manufactures coherence where none exists. The opportunity-engine eval demonstrated this directly: fed a **pure-noise signal set** — signals with no genuine relationship — the engine returned **one forced, low-coherence cluster** rather than abstaining. Today the clustering prompt biases toward producing *some* grouping, so it treats "nothing meaningful here" as an unreachable answer.

The cost is a false positive at the top of the funnel: a fabricated "opportunity" assembled from noise propagates downstream as if it were real, eroding trust in every opportunity the engine surfaces. An engine that cannot say "no clusters" cannot be trusted when it says "here is a cluster."

## Target Users

- **Primary — operators/consumers of opportunity-engine output.** They act on surfaced opportunities and need confidence that a returned cluster reflects a real signal relationship, not prompt-induced grouping pressure.
- **Secondary — loom maintainers.** They own the eval suite and the engine's prompts; they need the fix scoped tightly enough that it raises noise-resistance without regressing the engine's strong clustering on genuinely related signals.
- **Anti-persona — the agentic/exploratory clustering path.** This change is explicitly *not* for that path. [ASSUMPTION] The non-agentic path is a distinct, deterministic code route that can be modified without touching agentic behavior.

## Proposed Solution

Sharpen the clustering prompt in the opportunity engine's non-agentic path so that **abstention is an explicit, legitimate outcome**. Instruct the model to leave genuinely unrelated signals unclustered and to prefer returning **fewer or zero clusters** over assembling a weak, low-coherence grouping. The change is conceptual, not architectural: it shifts the model's default from "always group" to "group only when relatedness is real," while preserving existing behavior on coherent signal sets.

## Key Capabilities

1. **Permit empty results** — the clustering step may legitimately return zero clusters when no genuine relationship exists.
2. **Raise the grouping bar** — require a real coherence/relatedness threshold before signals are clustered; do not force membership to avoid an empty result.
3. **Preserve strong clustering** — genuinely related signals must still cluster as well as they do today (no regression on coherent inputs).
4. **Stay on the non-agentic path** — the change is confined to that single route; the agentic path is untouched.
5. **Lock in the behavior with a test** — add a regression test asserting noise-in → few-or-no-clusters-out, alongside continued correct clustering of related signals.

## Constraints

- **Single-module change.** Limited to the opportunity engine's clustering prompt plus one accompanying test. No new modules, no architectural change.
- **Do not change the eval.** The opportunity-engine eval is the fixed yardstick; the fix must move the eval result by changing the engine, not the measure.
- **Non-agentic path only.** No modification to agentic clustering behavior.
- **No regression on related signals.** Improving noise resistance must not weaken clustering quality on coherent inputs — this is the central tension to manage.

## Risks and Open Questions

- **Over-correction.** Raising the bar too far could suppress *valid* weak-but-real clusters, trading false positives for false negatives. The prompt must distinguish "weak because noise" from "weak because subtle-but-real." [ASSUMPTION] Borderline-coherence cases exist and matter; the eval may not fully cover them.
- **Measuring "low coherence."** Is coherence judged purely by the model from the prompt, or is there a downstream threshold/score the prompt should reference? Open question — affects whether prompt wording alone is sufficient.
- **Exact module and prompt location.** [ASSUMPTION] There is a single, identifiable clustering-prompt site on the non-agentic path; this should be confirmed before editing.
- **Test data fidelity.** [ASSUMPTION] A representative pure-noise signal fixture (or the eval's noise set, copied into the test) is available to drive the regression test without depending on the eval itself.
- **Determinism of the assertion.** LLM output variance may make a strict "exactly zero clusters" assertion flaky; the test likely needs a tolerance (e.g., "zero or one low-coherence cluster" → "few or none"). Open question on the precise assertion.

## Success Criteria

- On the pure-noise signal set, the engine returns **few or no clusters** — it no longer forces a single low-coherence cluster.
- On genuinely related signal sets, clustering quality is **unchanged** from current behavior (no regression).
- A new test encodes both outcomes: noise → few-or-no clusters, *and* related signals → correct clustering.
- The diff is confined to the opportunity engine's clustering prompt and its test; the **eval is untouched**, and the **agentic path is unchanged**.
- The full test suite passes.
