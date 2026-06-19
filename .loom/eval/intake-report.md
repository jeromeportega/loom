# Intake Classifier Evaluation Report

Generated from **22** cases — classifier: `claude-haiku-4-5-20251001`, judge: `claude-opus-4-8`

**Inconclusive judge calls:** 0

### Failure Counts

- Scored: 8 of 22
- timeout: 0 | invalid_output: 14 | llm_error: 0

### Thresholds

- minScoredCases: 18
- maxClassifierFailureRate: 10%
- maxJudgeInconclusiveRate: 10%

---

## Type Axis

**Accuracy:** 8/8 correct (100%)

### Confusion Matrix

|  | predicted:feature | predicted:bug | predicted:chore |
| --- | --- | --- | --- |
| **feature** | 8 | 0 | 0 |
| **bug** | 0 | 0 | 0 |
| **chore** | 0 | 0 | 0 |

### Agreement

- Judge vs Classifier: agree 8 | disagree 0 | inconclusive 14
- Judge vs Human: agree 8 | disagree 0 | inconclusive 14

### Disagreements (0)

None.

### Dangerous Confusions

None defined for type axis.

### Verdict

Type axis: 0 dangerous confusion(s) detected. Clears Phase 1 bar.

---

## Size Axis

**Accuracy:** 3/8 correct (38%)

### Confusion Matrix

|  | predicted:story | predicted:epic |
| --- | --- | --- |
| **story** | 0 | 0 |
| **epic** | 5 | 3 |

### Agreement

- Judge vs Classifier: agree 6 | disagree 2 | inconclusive 14
- Judge vs Human: agree 5 | disagree 3 | inconclusive 14

### Disagreements (2)

| Case | Labeled | Predicted | Judge | Rationale |
| --- | --- | --- | --- | --- |
| epic-003 | epic | story | epic | Story Dispatch bundles three substantial subsystems (supervisor, worktree isolation, subagent runner) that need coordination beyond a single PR, making it an epic, and the classifier's rationale is incoherent—it describes eval-intake/go-no-go gating from recent commits rather than the dispatch brief it was given. |
| epic-004 | epic | story | epic | Standing up an MCP server with 7 distinct tools across two client integrations is a multi-story effort that needs decomposition (epic), and the classifier's rationale is incoherent—it justifies the verdict from branch/file metadata about an unrelated eval-intake system rather than the brief's actual content, which conflicts with the project's stated direction of removing the MCP surface. |

### Dangerous Confusions

**epic → story:** 5 case(s) — epic-003, epic-004, epic-008, epic-013, epic-015

### Verdict

Size axis: 5 epic→story under-sizing confusion(s) detected. Does NOT clear Phase 1 bar — costly under-sizing present.

---

## Overall

**Decision:** INCONCLUSIVE

INCONCLUSIVE: only 8 of 22 case(s) scored (minimum 18 required). Failure breakdown: timeout=0, invalid_output=14, llm_error=0.
