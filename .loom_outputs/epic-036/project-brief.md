# Code-Derived Readiness for the Brief-Quality Scorer

## The Problem

The `BriefRefiner`'s **readiness flag is a model-emitted boolean the model cannot be trusted to produce.** Today the scorer returns five things — a readiness flag, a 0–10 quality score, an optional refined brief, a structured critique, and clarification questions — and the readiness boolean is taken directly from the model.

That boolean is wrong about a third of the time. The operator-run brief-quality eval measures readiness accuracy at ~67%, and it did not move after an earlier shore-up that sharpened the readiness prompt criteria. Over the same run, quality-band agreement and critique quality both sit at 100%.

Inspection of the failing cases is conclusive: the eval labels are correct and the briefs are genuinely plan-ready — they name storage, error paths, out-of-scope, and checkable success criteria. The scorer scores these briefs correctly and critiques them correctly, yet its standalone `ready` boolean still flags them as not ready. The bias survived a clearer prompt.

The diagnosis is a capability split, not a wording problem: **the model is reliable at graded judgments (the quality score, the critique) and unreliable at the binary "ready" synthesis.** Trusting it to emit that binary is the defect.

## Target Users

- **Primary — Loom operators planning epics.** They rely on readiness to distinguish a *clean pass* from a *pass-with-clarifications*. A persistently over-cautious flag erodes trust and pushes operators to ignore the signal entirely.
- **Primary — the downstream planning pipeline.** Planning gates on the quality *score*; it also consumes the readiness flag to route clean-vs-clarify. It must keep consuming readiness exactly as before — only the value's *provenance* changes (model-emitted → code-derived).
- **Secondary — the operator running the offline brief-quality eval.** They measure readiness correctness, band agreement, and critique faithfulness, and will re-run the eval after this change ships.
- **Anti-persona — a consumer treating `blocking_gaps` as the full critique.** `blocking_gaps` is deliberately narrow. It is not a replacement for the existing critique arrays or clarification questions, and must not be read as an exhaustive issue list.

## Proposed Solution

**Stop asking the model for the binary; compute it in code from the signals the model gets right.**

The scorer continues to provide the nuanced assessment — quality score, full critique, clarification questions — and gains one new narrow output: `blocking_gaps`. Readiness is then *derived deterministically*:

```
ready = (quality_score is in the ready band) AND (blocking_gaps is empty)
```

The model never emits `ready` again; it emits the inputs, and code synthesizes the decision. The `ready` field remains in the output schema for existing consumers — its value is now code-derived rather than model-asserted.

## Key Capabilities

1. **Emit `blocking_gaps`** — a narrow list containing *only* gaps severe enough that a planner would have to invent requirements to proceed. Genuinely planning-blocking, defined on principle.
2. **Keep `blocking_gaps` distinct** from the existing minor ambiguities, missing-scope notes, and clarification questions — it is not a duplicate or a superset of them.
3. **Derive `ready` in code** as score-in-ready-band AND `blocking_gaps`-empty; remove direct model emission of the boolean.
4. **Align the ready-band threshold** to the existing high-band definition the eval already uses — not fit to the eval fixtures.
5. **Parse `blocking_gaps` safely and additively**, defaulting to empty when absent so older or malformed outputs degrade gracefully to readiness driven by the score band alone.
6. **Preserve the quality score and existing critique arrays exactly** — these are at 100% agreement and must not regress.
7. **Update the brief-refinement docs** to describe code-derived readiness, and pass the capabilities drift check if a user-visible surface changes.

## Constraints

- **No regressions** to quality-band agreement or critique quality (both at 100%).
- **Model stays on the non-agentic completion path** — no architectural move to an agentic flow.
- **`blocking_gaps` is additive** to the output schema, parsed safely, defaulting to empty when missing or malformed.
- **`ready` stays in the output** for existing consumers; only its derivation changes.
- **Planning's consumption of readiness is unchanged** beyond the flag now being derived.
- **No overfitting to eval fixtures** — `blocking_gaps` is defined principledly, and the threshold tracks the existing high-band definition.
- **The full brief-quality eval is not run as a worker story** — it is operator-run. This epic ships the schema and derivation change plus unit tests; the operator re-runs the eval afterward.
- **No guardrail is weakened.**
- **The full build and test suite must pass.**

## Risks and Open Questions

- **Threshold alignment is the load-bearing decision.** The ready-band threshold must match the eval's existing high-band definition. `[ASSUMPTION]` The high-band boundary is already defined in the eval harness and can be read directly from it rather than re-derived — this should be confirmed before coding so the threshold is sourced, not guessed.
- **`blocking_gaps` precision risk.** If the model is over-eager about what counts as "planning-blocking," code-derived readiness inherits the same over-caution it was meant to cure. The list's definition and prompt must hold a high bar ("a planner would have to *invent* requirements"). `[ASSUMPTION]` The model is as reliable at flagging genuinely-blocking gaps as it is at the graded critique — plausible given the diagnosis, but unproven until the operator re-runs the eval.
- **False-positive readiness.** Deriving from score-band alone (when `blocking_gaps` defaults empty on malformed output) could mark a brief ready that the model would have flagged. This is the intended graceful-degradation trade-off; worth noting it favors permissiveness over the current over-caution.
- **Eval is out-of-band.** Because the eval is operator-run and not part of CI, the readiness-accuracy improvement is not verified by this epic's tests — only the derivation logic is. The accuracy gain is confirmed only when the operator re-runs the harness.

## Success Criteria

- [ ] `BriefRefiner` emits a `blocking_gaps` list containing only critical, planning-blocking gaps — additive to the schema, parsed with a safe empty default for absent or malformed output.
- [ ] `ready` is computed in code as **score-in-ready-band AND `blocking_gaps`-empty**, and is no longer taken directly from the model.
- [ ] The ready-band threshold aligns with the existing high-band definition the eval uses and is not fit to the eval fixtures.
- [ ] The quality score and existing critique arrays are unchanged; band agreement and critique quality do not regress from 100%.
- [ ] Unit tests cover the derivation against mocked scorer outputs (no real model calls): **ready** when high band and no blocking gap; **not ready** when a blocking gap exists; **not ready** when the score is below the band.
- [ ] Brief-refinement docs describe code-derived readiness; the capabilities drift check passes if a user-visible surface changed.
- [ ] The full brief-quality eval is **not** run as a worker story; it remains operator-run.
- [ ] The full build and test suite pass.
