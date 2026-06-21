# Code-Derived Readiness for the Brief-Quality Scorer

## Overview

The `BriefRefiner` scorer returns five outputs — a readiness flag, a 0–10 quality score, an optional refined brief, a structured critique, and clarification questions. Today the `ready` flag is a boolean emitted directly by the model, and the model cannot be trusted to produce it: the operator-run brief-quality eval measures readiness accuracy at ~67% even though quality-band agreement and critique quality both sit at 100%, and a prior prompt-sharpening pass did not move it. The diagnosis is a capability split — the model is reliable at graded judgments (score, critique) and unreliable at the binary "ready" synthesis. This change stops asking the model for the binary and instead derives `ready` deterministically in code from the signals the model gets right: `ready = (quality_score in ready band) AND (blocking_gaps empty)`. The model gains one new narrow output, `blocking_gaps`, and never emits `ready` again. The `ready` field stays in the output schema unchanged for consumers — only its provenance changes from model-asserted to code-derived.

## Goals

1. **Raise readiness accuracy** by replacing model-emitted `ready` with a code-derived value. *Metric:* readiness accuracy in the operator-run brief-quality eval improves above the ~67% baseline (verified out-of-band by the operator after ship).
2. **Hold the line on what already works.** *Metric:* quality-band agreement and critique quality remain at 100% — zero regression.
3. **Keep the readiness contract stable for downstream consumers.** *Metric:* the `ready` field remains present and same-typed in the output schema; planning's consumption is unchanged beyond the flag now being derived.

## User Stories

- **As a loom operator planning epics**, I want the readiness flag to reliably distinguish a clean pass from a pass-with-clarifications, so that I can trust the signal instead of learning to ignore an over-cautious flag. *(Must)*
- **As the downstream planning pipeline**, I want to keep consuming `ready` exactly as before, so that routing clean-vs-clarify continues to work with no integration change. *(Must)*
- **As the operator running the offline brief-quality eval**, I want the derivation logic shipped with unit tests so I can re-run the harness and confirm the accuracy gain. *(Should)*

## Functional Requirements

- **FR-1:** The `BriefRefiner` MUST emit a `blocking_gaps` list containing *only* gaps severe enough that a planner would have to invent requirements to proceed — genuinely planning-blocking, defined on principle.
- **FR-2:** `blocking_gaps` MUST be kept distinct from the existing minor-ambiguity, missing-scope, and clarification-question outputs — not a duplicate or superset of them.
- **FR-3:** The scorer MUST derive `ready` in code as `(quality_score in ready band) AND (blocking_gaps empty)`, and MUST NOT take `ready` directly from the model.
- **FR-4:** The model MUST no longer emit a `ready` boolean; the prompt/output contract is changed so the model emits the inputs only.
- **FR-5:** The ready-band threshold MUST be sourced from the existing high-band definition the eval already uses, not fit to the eval fixtures.
- **FR-6:** `blocking_gaps` MUST be parsed safely and additively, defaulting to empty when absent or malformed, so older or malformed outputs degrade gracefully to readiness driven by the score band alone.
- **FR-7:** The quality score and existing critique arrays MUST be preserved exactly — no change to their computation or shape.
- **FR-8:** The brief-refinement docs MUST describe code-derived readiness, and the capabilities drift check MUST pass if a user-visible surface changed.

## Epics

This PRD breaks into **one epic**: *Code-Derived Readiness for the Brief-Quality Scorer* — the additive `blocking_gaps` output, the in-code `ready` derivation, threshold alignment, safe parsing, docs, and unit tests.

## Out of Scope

- **Running the full brief-quality eval as a worker story** — it is operator-run and re-run out-of-band after this ships.
- **Any move to an agentic flow** — the model stays on the non-agentic completion path.
- **Changing the quality score, critique arrays, or clarification questions** — these are at 100% agreement and are preserved as-is.
- **Treating `blocking_gaps` as a full critique** — it is deliberately narrow and does not replace the existing critique arrays or clarification questions.
- **Weakening any guardrail** or altering planning's downstream consumption of readiness beyond the change in the flag's provenance.
