I'll quickly verify the key referenced artifacts so the brief is evidence-grounded rather than assumption-heavy, then write it.I have the architecture doc — the key grounding. Let me re-run the inspection without semicolons.The guard blocks chaining. Let me issue commands separately, in parallel.Strong grounding now. One more targeted check — does a delivered epic YAML actually contain the brief text and story breakdown the labeled set will bootstrap from?# Classifier Evaluation Harness — Phase 0.5 Go/No-Go Gate for `loom weave`

**Status:** Brief for planning. Developer-facing research & evaluation tooling. Design of record: `docs/architecture/intake-classification.md`.

## The Problem

Phase 0 shipped an observe-only `IntakeClassifier` (`packages/loom-core/src/intake/IntakeClassifier.ts`) that, given a brief, returns `{ type: feature|bug|chore, size: story|epic, confidence, rationale }`, and `loom weave` records that verdict without acting on it. Recording tells us **what** the classifier decided, never whether it decided **well**.

That gap blocks the whole rollout. Phases 1–2 progressively let the classifier influence planning depth and routing, and the architecture doc warns misclassification is **asymmetric**: under-sizing an epic into one story yields a thin unit that fails, while over-sizing only wastes planning. Before any later phase trusts the verdict, we need an evidence-based answer to "is this classifier good enough?" — and we need it calibrated correctly.

The methodological trap that shapes this entire phase: **the planner's output is not ground truth.** The planner over-decomposes unpredictably (the doc records it splitting single briefs into 2–4 epics). Measuring classifier-vs-planner agreement measures *consistency*, not *correctness*. We therefore need an independent correctness signal — an LLM-as-judge from a stronger model tier — anchored to a small human-labeled set.

## Target Users

- **Primary:** Loom maintainers deciding go/no-go on Phase 1. They consume the report's confusion matrices and the plain proceed/don't-proceed verdict.
- **Secondary:** The future Phase 2 author, who reads the confusion matrix to calibrate how conservative the default-to-richer confidence threshold must be (the doc explicitly defers this: "calibrate from P0 data, don't guess").
- **Anti-persona:** Operators running `loom weave` in production. This is an offline harness; it must surface no operator-facing CLI command and touch no planning or execution path.

## Proposed Solution

An **offline evaluation harness** that grades the Phase 0 classifier against two independent signals and emits a report artifact. It follows the repo's established evaluation convention — the `loom-bench` binary (`packages/loom-cli`, `dist/loom-bench.js`) and `scripts/eval.mjs` — rather than adding an operator command, and reuses the existing LLM-judge pattern in `packages/loom-core/src/skills/SkillJudge.ts` (zod-validated `{score, reason}`, bundled prompt, graceful degradation) rather than inventing parallel judge infrastructure.

The harness never modifies the classifier; it only measures it.

## Key Capabilities

1. **Labeled eval set as a fixture.** Bootstrap most cases from loom's 19 delivered epics (`epics/epic-0NN.yaml`), each carrying a brief and an observed shape derivable from its story count (e.g. `epic-019` → 4 stories). Add a few hand-curated anchor cases pinning the extremes (an obvious single-story change, an obvious bug, an obviously large multi-story epic). Each case stores brief text + a human `type`/`size` label + a short rationale.
2. **Calibrate size on human anchors, not history.** Treat historical story counts as *evidence*, not absolute truth (the planner over-decomposes); the human-curated anchors are what pin size.
3. **Run the classifier.** Pass every brief through the Phase 0 `IntakeClassifier`; collect `type`, `size`, `confidence`, `rationale` — one classifier call per case.
4. **Objective agreement.** Exact-match accuracy of classifier verdict vs human label, reported **separately for type and for size**.
5. **LLM-as-judge (stronger tier).** For each brief, one call to a stronger/different model (planning-tier, not the cheap triage Haiku) to independently classify and to grade the classifier's verdict + rationale as agree/disagree-with-reason — one judge call per case.
6. **Validate the judge itself.** Cross-check the judge against the human labels and report **judge-vs-human agreement**, so we know whether the judge is trustworthy — never resting on judge-vs-classifier agreement alone.
7. **Report artifact.** Per axis (type, size): overall accuracy; a **confusion matrix** of predicted vs labeled; judge-vs-classifier agreement; judge-vs-human agreement; the full list of disagreements with rationales; and a plain-language statement of whether the classifier clears the bar for Phase 1.

## Constraints

- **Observe-only is sacred.** Do not modify Phase 0 classifier behavior; do not wire any of this into planning or execution. The harness reads the classifier; it never changes what reads the verdict (mirrors the P0 load-bearing invariant).
- **Do not weaken any guardrail.**
- **Judge must be a strictly stronger/different tier** than the cheap classifier model, so it does not share the classifier's blind spots.
- **Cheap and small.** Exactly one classifier call + one judge call per case; keep the labeled set small.
- **Reuse, don't reinvent:** `loom-bench` / `scripts/eval.mjs` convention + the `SkillJudge` LLM-judge pattern.
- **Full build and test suite must pass.**

## Risks and Open Questions

- **The confusion matrix is the load-bearing output, not headline accuracy.** It reveals *which* categories the classifier confuses, which directly sets how conservative Phase 2's default-to-richer threshold must be. A high overall accuracy that hides systematic epic→story under-sizing should still fail the bar, given the asymmetric-cost rule. The "bar for Phase 1" must be defined in terms of the dangerous confusions, not a single accuracy number. `[ASSUMPTION]` exact pass thresholds are a planning decision; recommend stating them as explicit per-axis + per-cell criteria.
- **Small-set statistics.** ~19 epics + a handful of anchors is a small sample; per-cell confusion counts will be tiny and noisy. Report should present counts honestly, not over-interpret a single misclassification. `[ASSUMPTION]` no minimum-N requirement is specified.
- **Brief text provenance in epic YAMLs.** Confirmed each epic YAML has `title` and a `stories` list; the harness must locate the actual *brief text* per epic (in the YAML or a sibling planning artifact) to feed the classifier. Worth verifying during planning that brief text is reliably recoverable for all 19.
- **`chore` is contested.** The architecture doc lists chore as an open question (lean: start with feature/bug). The classifier's type enum includes it, so the eval set and confusion matrix should accommodate `chore` labels even though few historical cases may exist.
- **Judge non-determinism / unavailability.** LLM judges vary run-to-run; `SkillJudge` degrades to a permissive accept when unavailable. For evaluation, a missing judge result must be recorded as *inconclusive*, never silently counted as agreement.
- **Doc registration gap.** The architecture doc's rollout is labeled P0–P4 with the measurement folded into P0's "Measures:" bullet; it has no explicit "Phase 0.5" entry. `[ASSUMPTION]` this phase should also register itself as the named go/no-go gate in `docs/architecture/intake-classification.md`.

## Success Criteria

- [ ] A labeled eval set exists **as a fixture the harness reads**, bootstrapped from loom's delivered epics plus a few hand-curated anchor cases; each case has brief text and a human `type` + `size` label with rationale.
- [ ] The harness runs every brief through the **Phase 0 `IntakeClassifier`** and a **stronger-tier LLM judge** — exactly **one classifier call and one judge call per case**.
- [ ] The report shows, **per axis (type, size)**: exact-match accuracy; a **confusion matrix** (predicted vs labeled); **judge-vs-classifier** agreement; **judge-vs-human-label** agreement; the **list of disagreements with rationales**; and a **plain statement** of whether the classifier clears the bar for Phase 1.
- [ ] The harness follows the **`loom-bench` / `scripts/eval.mjs`** convention and reuses the **`SkillJudge`** pattern; it adds **no operator CLI command**.
- [ ] **No planning or execution path is modified**; Phase 0 classifier behavior is unchanged; no guardrail is weakened.
- [ ] **Full build and test suite pass.**
