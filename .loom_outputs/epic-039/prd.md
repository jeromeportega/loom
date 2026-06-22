# PRD: Reliable Rejection of Unsafe and Non-Reusable Skill Candidates

## Overview

Loom's skill judge gates what enters the shared skill library: it scores a candidate skill 0–10 on the non-agentic completion path and returns an accept/reject verdict with a reason. The skill-judge eval surfaced a false-accept gap — decision accuracy was 70%, and **every error was a wrong accept**, the dangerous direction. Two anchor cases that should have been rejected (one non-reusable, tied to loom-internal SQLite specifics; one unsafe, teaching a destructive force-push) were accepted, and an independent judge rated those accepts indefensible. This effort sharpens the judge's **admission-criteria prompt text** so that safety and reusability become explicit, high-priority rejection criteria that override surface quality — without changing the judge's path, output schema, parsing, or fail-open-on-error behavior. The criteria must be principled, not tuned to the eval fixtures.

## Goals

1. **Close the false-accept gap on safety.** Candidates that teach or encourage dangerous/destructive operations are rejected via the verdict. *Metric:* the eval's unsafe anchor case rejects on operator re-run.
2. **Close the false-accept gap on reusability.** Candidates that are repo-specific, one-off, or non-generalizable are rejected via the verdict. *Metric:* the eval's non-reusable anchor case rejects on operator re-run.
3. **No regression on good skills.** Genuinely good, safe, reusable candidates continue to be accepted. *Metric:* the eval's good-skill cases still accept on operator re-run; pre-merge, unit tests over mocked judge outputs encode this intent.
4. **Contract stability.** The 0–10 score, accept/reject verdict, reason field, parsing, and fail-open default are unchanged in shape. *Metric:* existing parsing/contract behavior remains green; full build and test suite pass.

## User Stories

- **As a loom operator**, I want the skill judge to reject unsafe and non-reusable candidates with high priority, so that admitting one bad skill cannot pollute the shared library for every downstream agent. *(Must)*
- **As a loom operator**, I want the new criteria expressed on general principles rather than against the eval's specific cases, so that the judge generalizes instead of memorizing fixtures. *(Must)*
- **As a loom operator**, I want good, safe, reusable skills to keep being accepted, so that hardening the gate does not tip into indiscriminate strictness. *(Must)*
- **As a loom maintainer**, I want unit tests that exercise the sharpened criteria with mocked judge outputs and no real model calls, so that I get a pre-merge signal that intent is encoded correctly. *(Must)*

## Functional Requirements

- **FR-1** — The judge's admission criteria MUST explicitly and with high priority reject a candidate that teaches or encourages a dangerous or destructive operation (e.g., force-pushing, history rewriting, deleting data, disabling safety checks). Examples are representative, not an exhaustive blocklist.
- **FR-2** — The judge's admission criteria MUST explicitly and with high priority reject a candidate that is not genuinely reusable: narrowly tied to one repo's internals, a one-off, or not generalizable.
- **FR-3** — Safety and reusability rejections MUST take precedence over surface quality: a well-written, polished candidate that is unsafe or non-reusable is still rejected.
- **FR-4** — The criteria MUST be principled and generic, with **no reference** to the eval's specific fixtures or cases.
- **FR-5** — The criteria MUST give a clear handling stance for the edge case of a legitimately reusable skill that *mentions* a destructive command in a safe, guarded way, so such skills are not falsely rejected.
- **FR-6** — The judge MUST remain on the non-agentic completion path; only the admission-criteria prompt text changes. The output schema, parsing, and fail-open-on-error (default-accept) behavior are unchanged in shape.
- **FR-7** — An unsafe or non-reusable candidate MUST reject via the **verdict**, independent of any score it might otherwise earn (i.e., the verdict, not just the `judge-minimum-score` knob, enforces the gate). *(Verdict-vs-score precedence to be confirmed by the architect.)*
- **FR-8** — Unit tests MUST cover the sharpened criteria intent using mocked judge outputs, with **no real model calls**.
- **FR-9** — If admission criteria are documented in the skill docs, those docs MUST be updated to reflect the sharpened criteria. *([ASSUMPTION] whether such docs exist is unconfirmed; the update is conditional on that.)*
- **FR-10** — If any user-visible surface changes, the capabilities drift check MUST pass.

## Epics

This PRD is delivered as a **single epic**: *Harden skill-judge admission criteria against unsafe and non-reusable candidates.* The work is one cohesive change — prompt criteria text plus accompanying unit tests and conditional doc updates — not a set of separable shipping units.

## Out of Scope

- **Hardening the fail-open default.** Fail-open (default-accept on judge error) is preserved as-is; a candidate can still be admitted when the judge errors. This residual gap is intentionally deferred to a future effort. *([ASSUMPTION] acceptable for this phase.)*
- **Running the full skill-judge eval as a worker story.** The eval is operator-run; this effort ships the criteria change and unit tests, and the operator re-runs the eval to confirm the unsafe and non-reusable cases now reject while good cases still accept.
- **Weakening any guardrail.** No guardrail is modified or relaxed.
- **Changing the judge's path, output schema, parsing, or score knob mechanics** beyond the admission-criteria prompt text.
- **Fixture-tuning.** Criteria are not shaped to the eval's specific cases.
