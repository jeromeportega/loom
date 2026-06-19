# Phase 0.5 — Wire and Harden the Intake Classifier

## The Problem

Phase 0 shipped two artifacts: the `IntakeClassifier` in `loom-core` and the `loom weave` command. Both passed CI green. But the first live run against the real session-based (`claude-cli`) backend — dogfooding, not mocks — exposed that the classifier does not work end to end, and that the evaluation harness was hiding this fact behind a false green light.

Four concrete defects:

1. **The command never calls the classifier.** `loom weave` is a pass-through to the epic planner. No verdict is ever produced or persisted — even though the schema column, the persistence method, the status surfacing, and the `describe` spec all already exist. The wiring shipped disconnected and no test caught it.
2. **Every classification times out.** The classifier has a hardcoded 20-second timeout. A single cheap-model call through the subprocess backend incurs cold start plus completion of ~100 seconds, so every call exceeds the cap.
3. **Output parsing fails.** Given enough time, the cheap model returns conversational prose, not the required JSON object. The classifier was only ever tested against a mock LLM, never against the real backend's actual output shape.
4. **The eval gate fails open.** The harness printed `PROCEED` with "zero dangerous confusions" while all 22 classifier calls failed. Zero successful classifications means zero confusions — so the go/no-go gate silently green-lights the next phase on a completely broken classifier.

The compounding danger is defect 4: a broken classifier that *reads as passing*. This phase fixes all four and validates the result with real numbers.

Reference: `docs/architecture/intake-classification.md`.

## Target Users

- **Primary — loom maintainers running the intake pipeline.** Developers who invoke `loom weave` and run the offline intake eval. They need a verdict actually produced and persisted, and an eval gate they can trust to tell the truth.
- **Secondary — loom operators inspecting intake verdicts.** They read verdicts via the database, audit log, and status surface for observability — never to drive a decision (see invariant below).
- **Anti-persona — anything that consumes the verdict to make a decision.** The planner, the quality gate, persona selection, and execution must remain blind to the verdict. This phase must not create a consumer that breaks observe-only.

## Proposed Solution

Harden the existing Phase 0 machinery — do not rebuild it — across five parts:

1. Wire the classifier into `loom weave` (best-effort, observe-only) so a real invocation records a real verdict.
2. Make the timeout fit the backend's real latency and make it configurable.
3. Harden JSON extraction so prose- and fence-wrapped model output still yields a parseable verdict.
4. Make the eval go/no-go gate fail closed and report honest counts.
5. Re-run the eval against the labeled set and record real per-axis accuracy and the gate's honest decision.

## Key Capabilities

1. **Invoke and persist (observe-only).** `loom weave` calls the classifier before planning and persists the resulting verdict against the epic it creates — to the database, the audit log, and the status surface. Best-effort: a classifier failure must not block weave.
2. **Backend-appropriate timeout.** Replace the fixed 20s cap with a bound that accommodates the ~100s real session-backend latency — a generous default or backend-aware value — and make it configurable. A single cheap classification must never be capped below the backend's real latency.
3. **Robust verdict extraction.** Extract the JSON object from responses that include surrounding prose or markdown fences; use a more forceful instruction; consider an assistant prefill that opens the JSON object so the cheap model returns a parseable verdict.
4. **Honest, fail-closed eval gate.** Require a minimum number of successfully scored cases before `PROCEED` is possible; report `DO NOT PROCEED` or `INCONCLUSIVE` when the classifier-failure rate or the judge-inconclusive rate exceeds a low threshold; surface failure-reason counts (timeout, invalid output, other errors) in the report instead of silently dropping failed cases.
5. **Validated re-run.** Re-run the eval, confirm parseable verdicts across cases, and record per-axis accuracy and the gate's honest decision.

## Constraints

- **Observe-only invariant is sacred.** The verdict must never influence planning, the quality gate, persona selection, or execution. Planning and execution must remain byte-identical regardless of the verdict.
- **No guardrail weakening.** Hardening only; no policy relaxation.
- **Model budget fixed.** One cheap model call per classification; one stronger model call per case for the judge.
- **Eval stays offline.** It remains a developer harness, not wired into planning or execution.
- **Reuse, don't rebuild.** Harden the existing classifier, eval, and judge machinery.

## Risks and Open Questions

- **Timeout strategy.** A generous fixed default is simpler but blunt; backend-aware is precise but adds coupling. `[ASSUMPTION]` A generous default (comfortably above ~100s) is acceptable for this phase, with configurability as the escape hatch.
- **Cheap-model JSON reliability.** Even with a forceful instruction and prefill, the cheap model may intermittently emit unparseable output. Open question: what residual failure rate is tolerable, and does the prefill approach generalize across the cases? Tests must feed *realistic* prose- and fence-wrapped responses, not idealized ones.
- **Gate thresholds.** The exact "minimum scored cases" count and the failure/inconclusive-rate thresholds are unspecified. `[ASSUMPTION]` These will be set low/strict enough that a high-failure run is glaring; values to be fixed during implementation and recorded in the report.
- **Re-run outcome is unknown.** After fixes, the classifier may still score poorly on accuracy. That is an acceptable, honest result for this phase — the goal is a *trustworthy* gate decision, not necessarily a `PROCEED`. The phase succeeds even if the honest decision is `DO NOT PROCEED`.
- **Latency cost of validation.** At ~100s per cheap call, a full re-run across the labeled set is slow. `[ASSUMPTION]` Acceptable for an offline harness.

## Success Criteria

- A real `loom weave` invocation calls the classifier and persists a **non-null verdict** to the database, audit log, and status surface — proven by an **end-to-end test** (the test that was missing and let the disconnected wiring ship green).
- Planning and execution outputs are **byte-identical** regardless of the verdict.
- The classifier timeout **accommodates the real session-backend latency** and is **configurable**; a single cheap classification is never capped below the backend's real latency.
- The classifier **reliably recovers a JSON verdict** from prose-wrapped and fence-wrapped model output — proven by tests that feed realistic non-pure-JSON responses through the parsing path.
- The eval go/no-go gate **requires a minimum number of scored cases** and reports `DO NOT PROCEED` or `INCONCLUSIVE` when the failure or inconclusive rate is high; the report **surfaces failure-reason counts** (timeout, invalid output, other).
- A **re-run** produces parseable verdicts and an **honest gate decision**, with **per-axis accuracy recorded**.
- The **full build and test suite pass.**
