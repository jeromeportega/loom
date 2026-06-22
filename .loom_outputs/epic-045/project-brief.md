# Intake Routing — Graduating the Classifier from Observe-Only to Acting

## The Problem

Loom's intake classifier already runs on every refined brief and records a **type** and **size** verdict to the database and audit log — but it is *observe-only*. The verdict never touches planning. The planner still guesses size on its own, and the well-known failure mode is **over-decomposition**: a change that is really one cohesive story gets inflated into a multi-story epic.

The classifier has now earned the right to act. Classifying the *refined* brief (rather than the raw one) eliminated under-sizing and cleared the Phase 1 quality bar, so the verdict is trustworthy enough to steer planning. Today that trust is stranded — the system knows the right size and does nothing with it. The gap is not classifier accuracy; it is the missing, safe path from a trusted verdict to planner behavior.

## Target Users

- **Primary — loom operators** who run planning (`loom epic` / the planning path) and want work sized correctly the first time, without hand-correcting an inflated epic afterward. They decide, per their risk tolerance, whether routing is automatic (advisory) or gated (confirm).
- **Secondary — maintainers and auditors** who need traceable provenance: what the classifier said, what the operator decided, and what the planner was ultimately told.
- **Anti-persona — the operator who must not be affected.** Anyone who has not opted in. For them, behavior must be byte-identical to today and the observe-only invariant must hold. This feature is invisible until explicitly enabled.

## Proposed Solution

Add an **opt-in policy knob** that graduates the classifier from observing to acting, with three levels of operator control. When routing is active, feed the classifier's *effective* size and type into the **existing planner as an explicit sizing constraint** — not a parallel pipeline. Confirm mode adds a CLI checkpoint so the operator can accept or override the classification before planning, with the decision recorded for provenance.

The design principle is conservative graduation: **default off, byte-identical legacy path, and acting only on explicit opt-in.**

## Key Capabilities

1. **Policy knob `intake_routing`** with levels `off` (default), `advisory`, and `confirm`.
2. **Off** — current behavior exactly: classifier runs observe-only, verdict is recorded but never influences planning, planning path is byte-identical to today.
3. **Advisory** — planning routes on the verdict automatically; the classification (type, size, confidence) and its rationale are printed before planning begins; planning does **not** wait for input.
4. **Confirm** — same surface as advisory, but the operator is prompted to accept the classification or override **type and/or size** before planning proceeds; planning then routes on the confirmed-or-overridden verdict.
5. **Routing as a planner sizing constraint** — pass effective size + type into the planner: `story` instructs a single cohesive story or the minimum necessary decomposition (explicitly *not* inflated into a multi-story epic); `epic` instructs full decomposition as today.
6. **Audit-log provenance** — record the confirm-mode decision (accepted vs. overridden, with final values) alongside the original verdict, so the routed outcome is traceable to its source.
7. **Docs** — `docs/capabilities.md` documents the knob and routing behavior; the capabilities drift check passes.

## Constraints

- **Default off**, and when off the planning path is **byte-identical** to today with the classifier remaining observe-only — proven by a test (this is the NFR-1 observe-only invariant; it must continue to hold).
- Routing **must** pass size as a planner sizing constraint, **not** a new pipeline.
- The confirm-mode override **replaces** the routed verdict and **must** be recorded in the audit log with provenance.
- **No guardrail may be weakened.**
- Planning **must not block for input except in confirm mode**; advisory and off are non-blocking.
- The classifier stays on the **non-agentic path** and continues to classify the **refined** brief.
- The **web pending-classification surface is out of scope** for this phase — CLI only; it is an explicit follow-up.

## Risks and Open Questions

- **Confirm mode in non-interactive contexts.** Confirm blocks for operator input, but planning is often invoked headless or in CI where no TTY exists. The brief does not specify the fallback. `[ASSUMPTION]` Confirm requires an interactive terminal; a defined non-interactive behavior (hard error, or documented degrade to advisory) is needed and should be settled before implementation.
- **The planner may not honor the constraint.** Sizing is delivered as an instruction to an LLM-driven planner. `[ASSUMPTION]` the constraint is injected as explicit prompt text. There is residual risk the planner still over-decomposes on a `story` verdict; the story→single-story behavior should be verified by an outcome-level test, not assumed from the instruction's presence.
- **Override scope.** The brief scopes operator override to **type and size**. Confidence and rationale are classifier outputs and `[ASSUMPTION]` are not operator-editable. Confirm before building the prompt.
- **Provenance schema.** The audit record must distinguish *accepted* from *overridden* and capture both the original verdict and the final routed values. The exact field shape is an open design detail.
- **Interaction with existing approval/checkpoint flows.** `[ASSUMPTION]` the confirm prompt is a new, self-contained CLI checkpoint distinct from epic approval; any ordering relative to existing gates should be confirmed.

## Success Criteria

- [ ] A policy knob (default `off`) gates intake routing with levels `off`, `advisory`, `confirm`.
- [ ] **Off:** the classifier is observe-only and planning is byte-identical to today — **proven by an automated test**.
- [ ] **Advisory:** planning routes on the verdict automatically, and the classification plus rationale are printed before planning begins, without blocking.
- [ ] **Confirm:** the operator is prompted to confirm or override type and size before planning, and the routed verdict reflects any override.
- [ ] Routing feeds the **effective size into the planner as a sizing constraint** — `story` yields a single cohesive story or minimal decomposition; `epic` yields full decomposition — and is demonstrably **not** a separate pipeline.
- [ ] The confirm-mode decision and any override are recorded in the **audit log with provenance**, alongside the original verdict.
- [ ] `docs/capabilities.md` documents the knob and routing behavior, and the **capabilities drift check passes**.
- [ ] The **full build and test suite pass.**
