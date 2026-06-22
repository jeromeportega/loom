# Fix Skill-Generator Eval: Decision-Correctness Scoring

## The Problem

The skill-generator eval's decision-correctness scoring is defective and is producing a false negative gate. In a recent run, the skill generator behaved correctly across all eight cases — it returned `NONE` for the four trivial cases (a typo fix, a version bump, a constant rename, a README update) and generated skills for the worthy cases, with healthy skill quality and zero spurious or low-quality generations. Yet the eval reported **0% decision correctness over only four of eight scored cases** and raised a **do-not-proceed gate**.

The generator is fine. The eval's decision-scoring logic is wrong, and as a result the gate cannot be trusted. Two distinct defects compound:

1. **NONE cases are silently dropped.** The eval invokes the judge to grade skill *quality*. When the generator returns `NONE`, there is no skill body to grade, so the case is skipped — and skipping it also removes the case from **decision-correctness scoring** and from the **scored-case count**. But deciding `NONE` on trivial work is a *correct decision*, and it is precisely the restraint the gate is meant to measure. Dropping it both understates coverage (8 → 4 cases) and hides correct behavior.

2. **Generate cases score as incorrect.** For the cases that *did* generate — and were correctly expected to generate — decision correctness still computed 0%. This points to a broken actual-versus-expected comparison: comparing the wrong fields, not reading the case's expected decision, or inverted polarity.

Together these make a perfectly healthy generator look like a gating failure.

## Target Users

- **Primary — loom operators** who run the skill-generator eval and rely on its gate verdict to decide whether the generator is safe to proceed. They need decision correctness that reflects the generator's *actual* generate-versus-NONE behavior across all cases.
- **Secondary — loom maintainers** who consume the eval's metrics over time to track generator regression/improvement.
- **Anti-target — the skill generator itself.** This phase deliberately does **not** touch the generator's production behavior. The generator is correct; only its eval consumer is being repaired.

## Proposed Solution

Repair the skill-generator eval consumer by **decoupling decision-correctness scoring from skill-quality judging**.

- Score the generate-versus-`NONE` **decision for every case**, by comparing the generator's *actual* decision against the *case's expected* decision — independent of whether a skill body exists to grade.
- Treat a correct `NONE` on trivial work as a **correct, counted, scored decision**.
- Continue to judge skill **quality and faithfulness only on cases that actually produced a skill**; a `NONE` result has no skill to grade, and that is fine — but it no longer drops the case from decision scoring or the scored count.
- Fix the actual-versus-expected comparison so that **both** a correct generate and a correct `NONE` score as correct.

After the fix, decision correctness reflects the generator's real decisions across all eight cases, and the gate verdict is based on true numbers. This is a consumer-side fix only; it reuses the existing gate-eval framework.

## Key Capabilities

1. **Score every case's decision** — compute generate-versus-`NONE` correctness for all cases, not only the ones that generated a skill.
2. **Count NONE cases as scored** — a correct `NONE` on trivial work is included in the scored-case count and scores as a correct decision.
3. **Correct the comparison** — read the case's expected decision and compare it to the actual decision with correct polarity, so correct-generate and correct-NONE both register as correct.
4. **Separate quality judging** — judge skill quality and faithfulness only on cases that produced a skill, decoupled from decision scoring.
5. **Gate on true numbers** — drive the proceed / do-not-proceed verdict from the corrected decision-correctness figures.
6. **Deterministic test coverage** — mocked-LLM unit tests proving the four scoring behaviors below.

## Constraints

- **Scope: eval consumer only.** Do not change the skill generator's production behavior, and do not change any other eval consumer.
- **Reuse the gate-eval framework** rather than introducing a parallel scoring path.
- **Keep the eval observe-only and operator-run.** Do **not** run the full skill-generator eval as a worker story — the operator re-runs it after the fix.
- **No weakened guardrails.** No guardrail may be relaxed as a side effect.
- **Tests must be deterministic** with mocked LLM responses — no live judge calls in unit tests.
- **Docs and capabilities:** update the skill-generator eval docs if the scoring semantics are documented there, and pass the capabilities drift check if any user-visible surface changes.

## Risks and Open Questions

- **Gate threshold definition.** The corrected numbers will change the gate's inputs. `[ASSUMPTION]` The do-not-proceed threshold itself is correctly specified and does not also need adjustment — only its *inputs* were wrong. If the threshold logic also assumes the old (dropped-NONE) denominator, it may need a paired fix. *Confirm whether the gate threshold is expressed against the scored-case count.*
- **Exact nature of defect #2.** The brief lists three candidate root causes (wrong fields, expected decision not read, inverted polarity). `[ASSUMPTION]` The fix will identify and correct the specific cause during implementation; all three are covered by the required incorrect-in-both-directions tests regardless.
- **Decision field shape.** `[ASSUMPTION]` The generator's actual decision (generate vs. none) and the case's expected decision are both already available to the consumer; the defect is in comparing them, not in capturing them. *Verify the expected-decision field exists on each case fixture.*
- **User-visible surface.** `[ASSUMPTION]` This is an internal scoring fix with no new CLI/MCP surface; the capabilities drift check applies only if eval output or docs are operator-facing. *Confirm whether eval metrics/docs count as a user-visible surface for the drift check.*
- **Other consumers sharing scoring code.** If decision-scoring logic is shared with other eval consumers, the fix must be isolated to the skill-generator path so other consumers remain unchanged.

## Success Criteria

- [ ] The eval scores the generate-versus-`NONE` decision for **every case**, including cases where the generator correctly returned `NONE`.
- [ ] Decision scoring compares **actual against the case's expected** decision; both a correct generate and a correct `NONE` count as correct.
- [ ] `NONE` cases are **no longer skipped** from decision scoring or from the scored-case count (all eight cases scored, not four).
- [ ] Skill **quality and faithfulness** continue to be judged **only** on cases that produced a skill.
- [ ] Deterministic mocked-LLM unit tests cover: (a) a correct `NONE` on a trivial case scores as correct **and** is counted as scored; (b) a correct generate scores as correct; (c) an incorrect decision in **either** direction scores as incorrect; (d) quality grading applies only to generated skills.
- [ ] The skill generator's production behavior is **unchanged**; other eval consumers are **unchanged**.
- [ ] No guardrail is weakened.
- [ ] Eval docs updated if scoring semantics are documented; capabilities drift check passes if a user-visible surface changes.
- [ ] The full skill-generator eval is **not** run as a worker story — left for the operator to re-run.
- [ ] The full build and test suite pass.
