# Intake Classifier Evaluation Report

Generated from **22** cases — classifier: `claude-haiku-4-5-20251001`, judge: `claude-opus-4-8`

**Inconclusive judge calls:** 0

### Failure Counts

- Scored: 22 of 22
- timeout: 0 | invalid_output: 0 | llm_error: 0

### Thresholds

- minScoredCases: 18
- maxClassifierFailureRate: 10%
- maxJudgeInconclusiveRate: 10%

---

## Type Axis

**Accuracy:** 21/22 correct (95%)

### Confusion Matrix

|  | predicted:feature | predicted:bug | predicted:chore |
| --- | --- | --- | --- |
| **feature** | 20 | 0 | 1 |
| **bug** | 0 | 1 | 0 |
| **chore** | 0 | 0 | 0 |

### Agreement

- Judge vs Classifier: agree 20 | disagree 2 | inconclusive 0
- Judge vs Human: agree 21 | disagree 1 | inconclusive 0

### Disagreements (1)

| Case | Labeled | Predicted | Judge | Rationale |
| --- | --- | --- | --- | --- |
| epic-009 | feature | feature | chore | Setting up an org-maintained skills repo is infrastructure/process work with no new user-visible product behavior, so it is a chore, not a feature; the classifier's size (epic) is right but its type is wrong. |

### Dangerous Confusions

None defined for type axis.

### Verdict

Type axis: 0 dangerous confusion(s) detected. Clears Phase 1 bar.

---

## Size Axis

**Accuracy:** 18/22 correct (82%)

### Confusion Matrix

|  | predicted:story | predicted:epic |
| --- | --- | --- |
| **story** | 2 | 0 |
| **epic** | 4 | 16 |

### Agreement

- Judge vs Classifier: agree 19 | disagree 3 | inconclusive 0
- Judge vs Human: agree 19 | disagree 3 | inconclusive 0

### Disagreements (3)

| Case | Labeled | Predicted | Judge | Rationale |
| --- | --- | --- | --- | --- |
| epic-008 | epic | story | story | Connecting loom to an approved MCP registry is a new user-visible capability (feature) and reads as a bounded single-PR integration—point at a registry, fetch, and provision approved servers (story)—and the classifier's rationale coherently names the capability and its scope drivers. |
| epic-017 | epic | epic | story | Changing the default so an epic ships as one PR instead of N story PRs is a user-visible behaviour change (feature, not chore), and it is a single focused delivery-model change shippable in one PR (story, not epic) — corroborated by it being scoped here as the single story-022-005 — so both axes are wrong. |
| epic-018 | epic | story | story | This adds a new user-visible capability (automated pre-PR code review), making it a feature, and it is a bounded, self-contained step that one developer can build in a single PR, making it a story — the classifier's verdict and coherent rationale both match. |

### Dangerous Confusions

**epic → story:** 4 case(s) — epic-005, epic-008, epic-013, epic-018

### Verdict

Size axis: 4 epic→story under-sizing confusion(s) detected. Does NOT clear Phase 1 bar — costly under-sizing present.

---

## Overall

**Decision:** DO_NOT_PROCEED

DO NOT PROCEED: axis bar(s) not cleared across 22 scored cases. Size axis: 4 epic→story under-sizing confusion(s) detected. Does NOT clear Phase 1 bar — costly under-sizing present.
