# Loom Weave Intake Classifier — Correctness, Reliable Wiring, and an Honest Re-Run

## The Problem

The `loom weave` intake classifier is meant to triage an incoming brief by **type** and **size** before planning begins. A prior attempt repaired the classifier's timeout handling and JSON parsing and made the eval's go/no-go gate fail closed. The eval then ran cleanly and produced a clear, honest verdict:

- **Type accuracy: 95%** — acceptable.
- **Size accuracy: 82%**, with a **systematic under-sizing bias**: four epic→story confusions and zero story→epic confusions. The honest gate's decision is **do-not-proceed**.

Two compounding problems sit underneath that result:

1. **The classifier is unproven in the real path.** The prior end-to-end wiring test failed — but on a database module-singleton artifact, not a logic defect. `openDatabase` returns a process-global singleton, and the test read the verdict through a fresh read-only connection that saw a different (empty) view than the write used. The wiring may well work; we cannot yet prove it.
2. **The eval's labels are partly untrustworthy.** Some size labels were bootstrapped from how many stories loom decomposed each brief into — and loom over-decomposes. The independent judge already sided with the classifier against the human label on two cases. So part of the measured "error" is the rubric being wrong, not the model.

The net effect: a classifier biased toward the *dangerous* direction (collapsing an epic into a single story), measured against a *partly invalid* yardstick, with *no trustworthy proof* it is even wired in.

## Target Users

- **Primary — loom maintainers dogfooding weave intake.** They need a classifier that is correct, demonstrably wired, conservatively biased, and an eval they can trust to gate the next phase honestly.
- **Secondary — future loom operators.** The verdict is observe-only today, but they are the eventual consumers once it influences routing. Today's job is to earn that trust without yet acting on it.
- **Anti-persona — the score-chaser.** Anyone inclined to relabel the eval set to make the gate pass. This work explicitly rejects inflated accuracy; only genuinely wrong labels may change, and every change must be documented.

## Proposed Solution

Supersede the prior attempt rather than restart it. **Carry forward its working fixes**, then close the four gaps that kept it from landing:

1. Wire the classifier end-to-end into a real `loom weave` invocation — best-effort, observe-only — and prove it with a **singleton-robust** test.
2. Bias the classifier **conservative** and sharpen the epic-versus-story boundary so it stops under-sizing.
3. **Re-anchor the noisy size labels** on genuine human scope judgment, with documented, conservative corrections.
4. **Re-run the eval** against the corrected set and record the result honestly — stating plainly whether the dangerous under-sizing confusions are reduced and whether the classifier now clears the bar.

Reuse and harden the existing classifier, eval, and judge machinery throughout; do not rebuild it.

*Reference: `docs/architecture/intake-classification.md`.*

## Key Capabilities

1. **End-to-end wiring (observe-only).** A real `loom weave` invocation calls the classifier before planning and persists the verdict to all three sinks — database, audit log, and status surface — best-effort. Planning and execution remain **byte-identical regardless of the verdict**.
2. **Singleton-robust end-to-end test.** A test runs the real weave path and asserts a non-null persisted verdict, reading it back **through the same database handle the write used** — never a fresh read-only connection. This is the exact failure mode that sank the prior attempt; it must not recur.
3. **Backend-appropriate timeout.** A generous, configurable default sized to the session-subprocess backend's real ~100s latency — not the old 20s cap.
4. **Robust JSON recovery.** Extract the JSON object from conversational or markdown-fenced model output, using a forceful instruction plus an assistant prefill that begins the JSON. Proven by tests feeding realistic non-pure-JSON responses through the parsing path.
5. **Fail-closed honest eval gate.** Require a minimum number of successfully scored cases; report do-not-proceed or inconclusive when classifier-failure or judge-inconclusive rates are high; surface failure-reason counts in the report rather than silently excluding failed cases.
6. **Conservative sizing bias with sharpened criteria.** Under low confidence or ambiguous scope signals, default to the **richer size (epic over story)**. Strengthen the instruction with concrete criteria: multiple functional areas / multiple services / a cross-cutting change ⇒ epic; a single bounded change ⇒ story.
7. **Trustworthy labels + re-run, plus housekeeping.** Re-anchor size labels on intrinsic brief scope (not loom's historical story count), correcting only labels the judge and a careful reading agree are wrong, with each change documented. Gitignore the eval output directory. Re-run and record per-axis accuracy, the confusion matrix, and the gate's honest decision.

## Constraints

- **Observe-only invariant (hard).** The verdict must never influence planning or execution. Pinned by a regression test; planning and execution must be byte-identical with or without the verdict.
- **No guardrail may be weakened.**
- **Budget per case:** exactly one cheap classifier call and one stronger-model judge call.
- The eval **remains an offline developer harness** — not a production code path.
- **Reuse and harden** existing classifier/eval/judge machinery; do not rebuild.
- **Label discipline:** correct only genuinely wrong labels, conservatively, and document each change. Do not tune labels to raise the score. The goal is a trustworthy labeled set, not inflated accuracy.

## Risks and Open Questions

- **Will the conservative bias actually reduce epic→story confusions** without simply trading them for new story→epic over-sizing? Measurable in the re-run, but not guaranteed. The success bar is *fewer dangerous confusions than the prior 4-of-22*, not zero error.
- **How many labels are genuinely wrong?** The judge flagged two. `[ASSUMPTION]` the total set of corrections is small (single digits); if a careful reading surfaces many, that itself signals the rubric — and possibly loom's decomposition behavior — needs separate scrutiny.
- `[ASSUMPTION]` **The database singleton is the sole cause** of the prior end-to-end test failure, with no latent logic defect in the wiring. The singleton-robust test must confirm this, not assume it.
- `[ASSUMPTION]` **The ~100s backend latency is representative.** Tail latencies could still exceed a generous default; configurability is the mitigation, but the default should be chosen with headroom.
- **Gate thresholds are unspecified.** The minimum scored-case count and the failure/inconclusive-rate cutoffs that trigger do-not-proceed/inconclusive must be chosen and justified.
- **Perception risk:** label cleaning can look like score-gaming. The documentation-per-change requirement and the conservative-only rule are the controls; they must be applied visibly.
- **The re-run may still say do-not-proceed.** That is an acceptable, honest outcome. Reporting an inflated pass is not.

## Success Criteria

- [ ] A real `loom weave` invocation persists a **non-null verdict to all three sinks** (database, audit log, status surface), proven by a **singleton-robust end-to-end test** that reads through the write's database handle.
- [ ] A regression test confirms planning and execution are **byte-identical regardless of the verdict** (observe-only invariant holds).
- [ ] The classification timeout accommodates the real ~100s backend latency and is **configurable**.
- [ ] The classifier **recovers JSON from prose- or fence-wrapped output**, proven by tests on realistic non-pure-JSON responses.
- [ ] The eval gate **requires a minimum number of scored cases** and reports do-not-proceed or inconclusive on high failure/inconclusive rates, **surfacing failure-reason counts** in the report.
- [ ] The classifier **defaults to the richer size** under low confidence or ambiguity, with sharpened epic-versus-story criteria in the instruction.
- [ ] Size labels are **re-anchored on human scope judgment**, with each change documented (what changed and why); no label changed solely to raise the score.
- [ ] The eval output directory is **gitignored**.
- [ ] A re-run **records per-axis accuracy, the confusion matrix, and an honest gate decision**, and states plainly whether the classifier clears the bar to proceed to phase one — with the **epic→story under-sizing confusions measurably reduced versus the prior 4-of-22**.
- [ ] No guardrail is weakened; **the full build and test suite pass.**
