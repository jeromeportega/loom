# Loom Weave Intake Classifier — Correctness, Wiring, and an Honest Re-Run

## Overview

The `loom weave` intake classifier triages an incoming brief by **type** and **size** before planning begins. A prior attempt fixed the classifier's timeout handling and JSON parsing and made the eval gate fail closed; the eval then ran honestly and returned **95% type accuracy** but **82% size accuracy with a systematic under-sizing bias** (four epic→story confusions, zero story→epic), yielding an honest **do-not-proceed**. That result rests on two compounding weaknesses: the classifier is **unproven in the real path** (the end-to-end test failed on a database singleton artifact, not a logic defect), and the eval's size labels are **partly untrustworthy** (some were bootstrapped from loom's own over-decomposition). This work supersedes the prior attempt — carrying forward its working fixes — and closes four gaps: prove the wiring with a singleton-robust test, bias the classifier conservative, re-anchor the noisy labels on genuine human scope judgment, and re-run the eval honestly. The verdict remains **observe-only**: it must never influence planning or execution.

## Goals

1. **Prove the classifier is wired in the real path.** A real `loom weave` invocation persists a non-null verdict to all three sinks (database, audit log, status surface), demonstrated by a singleton-robust end-to-end test that reads through the write's own database handle.
2. **Reduce the dangerous under-sizing bias.** The re-run shows **fewer epic→story confusions than the prior 4-of-22**, achieved by conservative biasing without simply trading them for new story→epic over-sizing.
3. **Earn a trustworthy yardstick.** Size labels are re-anchored on intrinsic brief scope with every correction documented; the re-run records per-axis accuracy, the confusion matrix, and an honest gate decision (proceed / do-not-proceed / inconclusive).
4. **Preserve safety.** Planning and execution stay byte-identical regardless of the verdict, no guardrail is weakened, and the full build and test suite pass.

## User Stories

- **As a loom maintainer dogfooding weave intake**, I want the classifier proven to be wired and conservatively biased, so that I can trust the eval gate's verdict on whether to advance to the next phase. *(Must)*
- **As a loom maintainer**, I want every size-label correction documented and conservative, so that I can distinguish genuine rubric repair from score-gaming. *(Must)*
- **As a future loom operator**, I want the verdict persisted and observable but inert today, so that the routing signal earns trust before it ever influences planning. *(Should)*

## Functional Requirements

- **FR-1** — A real `loom weave` invocation calls the classifier before planning and persists the resulting verdict, **best-effort**, to all three sinks: the database, the audit log, and the status surface.
- **FR-2** — Planning and execution proceed **byte-identical regardless of the verdict** (or its absence); a classifier failure must not block or alter the weave path.
- **FR-3** — A singleton-robust end-to-end test runs the real weave path and asserts a **non-null persisted verdict**, reading it back **through the same database handle the write used** (never a fresh read-only connection).
- **FR-4** — A regression test pins the observe-only invariant: planning and execution outputs are identical with and without the verdict present.
- **FR-5** — The classification timeout defaults to a generous value sized to the session-subprocess backend's real ~100s latency (with headroom) and is **configurable**.
- **FR-6** — The classifier recovers the JSON verdict from prose- or markdown-fence-wrapped model output, using a forceful instruction plus an assistant prefill that begins the JSON; tests feed realistic non-pure-JSON responses through the parsing path.
- **FR-7** — Under low confidence or ambiguous scope signals, the classifier defaults to the **richer size (epic over story)**.
- **FR-8** — The sizing instruction carries concrete criteria: multiple functional areas / multiple services / a cross-cutting change ⇒ epic; a single bounded change ⇒ story.
- **FR-9** — The eval gate requires a **minimum number of successfully scored cases** and reports do-not-proceed or inconclusive when classifier-failure or judge-inconclusive rates are high.
- **FR-10** — The eval report **surfaces failure-reason counts** rather than silently excluding failed cases.
- **FR-11** — Size labels are re-anchored on intrinsic brief scope (not loom's historical story count); **only** labels a careful reading and the judge agree are wrong may change, **conservatively**, with each change documented (what changed and why).
- **FR-12** — The eval output directory is gitignored.
- **FR-13** — A re-run against the corrected set records per-axis accuracy, the confusion matrix, and an honest gate decision, and states plainly whether the classifier clears the bar to proceed to phase one.

## Non-Functional Requirements

- **NFR-1 — Observe-only (hard).** The verdict must never influence planning or execution; pinned by FR-4's regression test.
- **NFR-2 — No guardrail weakened.** No existing guardrail may be loosened by this work.
- **NFR-3 — Budget per case.** Exactly one cheap classifier call and one stronger-model judge call per case.
- **NFR-4 — Offline harness.** The eval remains an offline developer harness, not a production code path.
- **NFR-5 — Reuse and harden.** Extend the existing classifier, eval, and judge machinery; do not rebuild it.

## Epics

This PRD is **one epic**: harden and prove the weave intake classifier — wire it observe-only with a singleton-robust test, bias it conservative, re-anchor the size labels honestly, and re-run the eval to record an honest gate decision. The four threads (wiring, bias, labels, re-run) are sequential facets of one cohesive deliverable, not independently shippable units.

## Out of Scope

- Acting on the verdict — any influence on routing, planning, or execution. The verdict stays observe-only.
- Rebuilding the classifier, eval, or judge from scratch.
- Forcing the gate to a "proceed" outcome; a do-not-proceed or inconclusive re-run is an acceptable, honest result.
- Relabeling the eval set to raise the score; only genuinely wrong labels may change.
- Broader investigation of loom's over-decomposition behavior (flagged only if label corrections turn out to be numerous).
- Promoting the eval into a production or CI-blocking code path.
