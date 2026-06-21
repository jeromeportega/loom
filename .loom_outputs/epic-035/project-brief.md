# Sharpen BriefRefiner Readiness Determination

## The Problem

The BriefRefiner (loom's brief-quality scorer) is over-cautious when it decides whether a brief is plan-ready. It correctly scores brief quality and correctly surfaces what is wrong — but its binary readiness flag does not track its own judgment. It flips otherwise plan-ready briefs to **not ready** whenever it can think of one more clarification question to ask, even when that question is minor or optional and a planner could reasonably proceed without the answer.

The offline brief-quality eval isolated this precisely. Across three judged axes on the labeled set:

| Axis | Current accuracy |
|---|---|
| Quality-score band agreement | 100% |
| Critique faithfulness | 100% |
| **Readiness correctness** | **~67%** |

Every readiness miss is in the same direction: briefs labeled **ready** that the scorer called **not ready**. The score is right and the critique is right; only the ready-versus-not-ready flag is wrong, and it is wrong with a consistent bias toward demanding more clarification than planning actually requires. The result is friction — operators are told a clean, plannable brief needs more work when it does not.

## Target Users

- **Primary — loom operators running planning.** They depend on the readiness flag to tell a *clean pass* apart from a *pass-with-clarifications*. A false "not ready" sends them chasing answers that planning never needed.
- **Secondary — loom maintainers running the brief-quality eval.** They re-run the operator-run eval harness to confirm the readiness axis improves while band agreement and critique quality hold.
- **Anti-persona — anyone seeking a looser quality gate.** This work does not lower the bar for what gets planned. Planning still gates on the quality score; only the *meaning* of the readiness flag is corrected. A brief below the ready band is still not ready.

## Proposed Solution

Sharpen the readiness criteria inside the BriefRefiner prompt so that **ready** means the brief is concrete enough to plan: its quality is in the ready band *and* there is no critical ambiguity or missing scope that would actually block planning. Tie the flag to two things the scorer already produces correctly — the quality score and the *severity* of the gaps in the critique — instead of to the mere existence of a clarification question.

This is a principled criteria change expressed in the prompt. It is not tuning against the eval's labeled cases; the prompt must not reference or fit any eval fixture.

## Key Capabilities

1. **Readiness keyed to plan-readiness, not question-availability.** The flag reads "ready" when quality is in the ready band and no critical, planning-blocking gap exists.
2. **Severity-aware gating.** Critical gaps — blocking ambiguity or missing scope — make a brief not ready. Minor or optional gaps a planner can reasonably proceed past do not.
3. **Decoupling of clarification questions from the flag.** The presence of minor or optional clarification questions must never, by itself, flip an otherwise plan-ready brief to not ready. Questions may still be surfaced; they just stop forcing a "not ready" verdict.
4. **Internal consistency.** The readiness flag agrees with the brief's own quality score and the severity expressed in its critique.
5. **Fixture-independence.** The criteria are stated as general principles of plan-readiness, with no dependence on the specific eval cases.

## Constraints

- **Quality-band agreement and critique faithfulness must not regress** — both are at 100%. Only the readiness axis may move.
- **Output schema, parsing, and fallback behavior are unchanged.** The scorer continues to return: readiness flag, 0–10 quality score, optional refined brief, structured critique, and clarification questions.
- **The scorer stays on the non-agentic completion path.** No change to its transport.
- **No guardrail is weakened.**
- **No overfitting to eval fixtures** — the prompt change references no fixture and is not tuned to specific cases.
- **The full brief-quality eval is not run as a worker story.** It is operator-run. This epic ships the criteria change plus unit tests; the operator re-runs the eval to confirm the result.
- **Docs and capabilities drift:** update readiness semantics wherever they are documented, and pass the capabilities drift check if any user-visible surface changes.

## Risks and Open Questions

- **Defining "critical" precisely enough.** The fix hinges on the prompt drawing a clean line between planning-blocking gaps and proceed-past gaps. Too loose and readiness over-corrects into false positives (briefs called ready that are not); too tight and the original bias persists. The eval's single-direction error today gives headroom, but the new criteria should be checked for the opposite failure mode appearing.
- **Ready-band boundary.** [ASSUMPTION] The "ready band" the flag references is the same quality threshold planning already gates on; the change adds the no-critical-gap condition on top of it rather than redefining the band. To confirm against the current scorer definition.
- **Flag visibility.** [ASSUMPTION] The readiness flag is surfaced to operators (CLI and/or eval output) as the clean-pass vs. pass-with-clarifications signal; if so, the docs update should cover that surface and trigger the capabilities check.
- **Score/critique stability under prompt edits.** Editing the same prompt that produces the score and critique risks unintended drift on the two axes already at 100%. Unit tests should assert the readiness intent without re-validating — or destabilizing — band and critique.
- **Unit tests without live model calls.** [ASSUMPTION] Readiness-intent tests will exercise the decision logic via fixed/mocked scorer outputs rather than real completions, consistent with "no real model calls."

## Success Criteria

- The BriefRefiner readiness criteria are sharpened so the **ready** flag reflects genuine plan-readiness — quality in the ready band and no critical blocking gap — rather than the mere availability of clarification questions.
- The change is a principled prompt edit that references no eval fixture.
- Minor or optional clarification questions no longer, on their own, flip a plan-ready brief to not ready.
- Output schema, parsing, fallback behavior, and the non-agentic transport are unchanged.
- Unit tests covering the readiness-criteria intent are added or updated and pass **without** spawning real model calls.
- Documentation of readiness semantics is updated wherever it exists, and the capabilities drift check passes if a user-visible surface changed.
- No guardrail is weakened.
- The full build and test suite pass.
- The full brief-quality eval is **not** run as a worker story; it is left for the operator to re-run, expecting readiness accuracy to rise while band agreement and critique quality stay at 100%.
