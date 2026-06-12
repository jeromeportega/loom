---
name: loom-plan-review
description: Review a plan, PRD, or epic for implementation-readiness — surface gaps, ambiguity, and risk before any code is written.
---

# Plan Review

Review the plan, PRD, or epic the user points you at, and judge whether it is ready
to implement. The goal is to catch the expensive problems now, on paper.

## Check for

- **Ambiguity** — requirements two engineers would build differently.
- **Missing scope** — error handling, edge cases, migration / rollback,
  observability, auth, empty and first-run states — what plans routinely omit.
- **Untestable criteria** — acceptance criteria with no checkable definition of done.
- **Hidden dependencies** — ordering or external systems the plan assumes silently.
- **Sizing** — stories too large to land safely, or coupled when they read as
  independent.
- **Risk** — the one or two things most likely to go wrong, and whether the plan
  addresses them.

## Output

A punch list: each issue, why it matters, and the concrete fix. End with a verdict —
ready, ready with the listed fixes, or not ready — and name the single biggest gap.
