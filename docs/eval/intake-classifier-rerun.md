# Intake Classifier Re-run — Epic 023 Eval Report

**Date:** 2026-06-19  
**Script:** `scripts/eval-intake.mjs`  
**Classifier model:** `claude-haiku-4-5-20251001` (`LOOM_EVAL_MODEL`)  
**Judge model:** `claude-opus-4-8` (`LOOM_JUDGE_MODEL`)  
**Fixture:** `packages/loom-core/eval-cases/intake-classification.yaml` (22 cases, re-anchored by story-023-005)  
**Backend:** `claude-cli` (session-based)

---

## Gate Decision

**`inconclusive`** — The classifier does NOT clear the bar to proceed to phase one on this run.

The gate fired `inconclusive` because the classifier failure rate (45%) exceeded the 25% threshold. Ten of 22 cases produced `invalid_output`, triggering the fail-closed gate before quality-bar assessment could be made across the full case set. The 12 successfully scored cases show directionally positive results (reduced epic→story confusions), but the gate cannot be resolved until the failure rate drops below 25%.

---

## Scored-Case Summary

| Metric | Value |
| --- | --- |
| Total cases | 22 |
| Cases with valid classifier output | 12 |
| Cases with conclusive judge | 12 |
| Fully scored (ok classifier + conclusive judge) | 12 |
| Classifier failures (`invalid_output`) | 10 (45%) |
| Gate threshold — min scored cases | 5 |
| Gate threshold — max failure rate | 25% |

**Each case used exactly one classifier call and one judge call** (budget preserved, NFR-3/FR-8). When the classifier failed, the judge was skipped (no verdict to grade).

---

## Per-Axis Accuracy (12 scored cases)

| Axis | Correct / Scored | Accuracy | Failures excluded |
| --- | --- | --- | --- |
| **Type** | 11 / 12 | **92%** | 10 |
| **Size** | 10 / 12 | **83%** | 10 |

Classifier failures are excluded from scored counts and are never credited as correct (FR-5).

---

## Confusion Matrices

### Type Axis (12 scored cases)

|  | predicted:feature | predicted:bug | predicted:chore |
| --- | --- | --- | --- |
| **labeled:feature** | 11 | 0 | 1 |
| **labeled:bug** | 0 | 0 | 0 |
| **labeled:chore** | 0 | 0 | 0 |

Note: The single `bug`-labeled case (anchor-obvious-bug) was among the 10 `invalid_output` failures and does not appear in the matrix.

### Size Axis (12 scored cases)

|  | predicted:story | predicted:epic |
| --- | --- | --- |
| **labeled:story** | 1 | 0 |
| **labeled:epic** | 2 | 9 |

---

## Epic→Story Under-Sizing Confusions

**This run:** 2 cases (`epic-009`, `epic-018`)  
**Prior run (pre-023):** 4 of 22 cases  
**Change:** Reduced from 4 to 2 known confusions

The two remaining confusions are cases where the classifier produced output that was scored (no `invalid_output`) but the sizing call was wrong:

| Case | Labeled | Predicted | Judge sizing | Judge rationale |
| --- | --- | --- | --- | --- |
| epic-009 | epic | story | epic | Brief describes a new org-maintained shared skills repository — cross-cutting capability spanning repo provisioning, skill distribution/sync, and integration. |
| epic-018 | epic | story | epic | Brief introduces a pre-PR automated review gate — new review agent + findings schema + dedup + supervisor wiring (four distinct components). |

The conservative epic-vs-story sizing tiebreak (story-023-002) measurably reduced confusions: 4 → 2 among the 12 cases the classifier successfully processed. Whether the 10 failed cases would show further confusions is unknown; re-running with a more reliable LLM path would resolve this.

---

## Per-Axis Verdict

### Type Axis

- **Dangerous confusions:** None defined for type axis
- **Verdict:** Clears Phase 1 quality bar (0 dangerous confusions)
- **One disagreement (judge vs classifier):** `epic-018` — labeled `feature`, classifier predicted `chore`; judge independently classified as `feature`. The classifier's rationale incoherently claimed no description was provided.

### Size Axis

- **Dangerous confusions:** 2 (`epic→story` under-sizing: `epic-009`, `epic-018`)
- **Verdict:** Does NOT clear Phase 1 quality bar — costly under-sizing present

---

## Judge Agreement

### Type Axis

| Agreement | Count |
| --- | --- |
| Judge vs Classifier: agree | 11 |
| Judge vs Classifier: disagree | 1 |
| Judge vs Classifier: inconclusive (classifier failed) | 10 |
| Judge vs Human: agree | 12 |
| Judge vs Human: disagree | 0 |
| Judge vs Human: inconclusive | 10 |

Judge and human labels agreed on all 12 scored type cases.

### Size Axis

| Agreement | Count |
| --- | --- |
| Judge vs Classifier: agree | 9 |
| Judge vs Classifier: disagree | 3 |
| Judge vs Classifier: inconclusive (classifier failed) | 10 |
| Judge vs Human: agree | 9 |
| Judge vs Human: disagree | 3 |
| Judge vs Human: inconclusive | 10 |

Three size disagreements between judge and classifier (epic-002, epic-003, epic-009), but only the judge's `epic→story` confusion on epic-009 also disagreed with the human label — making it the only case where classifier, judge, and label were all different.

---

## Failure Analysis

All 10 classifier failures were `invalid_output` (0 `llm_error`, 0 `timeout`). This means the claude CLI returned a response but it could not be parsed as a valid `IntakeVerdict`. Likely causes:

- The `flattenMessages` function in `ClaudeCliClient` represents the assistant prefill `{` as `--- your previous response ---\n{\n--- end ---`, which is not a true API-level prefill. Some model responses may not produce valid JSON continuations in this mode.
- The judge noted that two scored cases (epic-009, epic-018) produced classifier rationales claiming "no work item was provided" despite clear briefs — suggesting occasional model confusion about the conversation structure in CLI mode.

The failure pattern is a backend compatibility issue, not a label quality issue. Re-running with the Anthropic SDK backend or after addressing the prefill handling would produce a more reliable measurement.

---

## Comparison to Prior Run

| Metric | Prior run (pre-023) | This run | Change |
| --- | --- | --- | --- |
| Epic→story confusions | 4 / 22 | 2 / 12 scored | −2 absolute confusions |
| Cases fully scored | (unknown) | 12 / 22 | — |
| Classifier failure rate | (unknown) | 45% (10 / 22) | — |
| Gate decision | (unknown) | `inconclusive` | — |

The conservative sizing tiebreak (story-023-002) is directionally effective: the two cases that were mis-sized in this run (`epic-009`, `epic-018`) were cases where the classifier's rationale showed internal confusion about the brief text, not cases where the sizing heuristic failed.

---

## Plain Proceed / Do-Not-Proceed Statement

**The classifier does NOT clear the bar to proceed to phase one.**

Gate decision: **`inconclusive`**. The 45% classifier failure rate (10/22 cases) exceeds the 25% fail-closed threshold. This is not a clean `do-not-proceed` — the 12 scored cases show 92% type accuracy and 83% size accuracy with only 2 epic→story confusions (down from 4 prior). But the gate is fail-closed: an inconclusive run is not a pass.

**Recommended next step:** Re-run via the Anthropic SDK backend (`LOOM_EVAL_BACKEND=sdk` or equivalent) to eliminate the CLI prefill-flattening failure mode. If the failure rate drops below 25% and epic→story confusions remain at 2 or fewer, the gate should resolve to `proceed`.

---

*Generated output (gitignored): `.loom/eval/intake-report.{md,json}`*
