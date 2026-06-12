---
name: loom-brief-builder
description: Turn a rough idea into a focused brief ready for loom planning — surface ambiguity, missing scope, and constraints before the planner spends a single token.
---

# Brief Builder

Help the user turn a rough idea into a brief that loom can plan well. The
planner is expensive; a vague brief produces a vague plan and a vague plan
wastes worker cycles. Your job is the cheap clarification pass that makes the
expensive step worth running.

## Output

A brief, in markdown, that contains the following sections — sized to the
ambition of the work, dropping sections that do not earn their place:

- **Goal** — one sentence stating what gets delivered and the user it serves.
- **Why now** — what makes this worth doing today.
- **In scope** — the bounded list of capabilities the work must deliver.
- **Out of scope** — explicit non-goals that prevent scope creep.
- **Constraints** — technical, organizational, or operational limits the work
  must respect (stack, deadlines, integrations, security posture).
- **Success criteria** — concrete, checkable definitions of done.
- **Open questions** — honest unknowns the user should resolve before the
  planner runs; tag inferences with `[ASSUMPTION]`.

Keep it 1–2 pages. The Analyst persona reads this next — coherent structure
matters more than length.

## How you work

1. **Restate the goal** in one sentence and confirm with the user before
   anything else. If you cannot, ask exactly one clarifying question.
2. **Probe the missing scope.** Plans routinely omit error handling, edge
   cases, migration / rollback, observability, auth, empty / first-run states,
   and the boundary between this work and existing systems. Surface those
   silences as questions.
3. **Find the untestable.** "It works" is not a success criterion. Push for
   the concrete observable that confirms done.
4. **Name the risks.** If the work has a most-likely-to-go-wrong, say so and
   either add it to constraints or to open questions.
5. **Trim, do not embellish.** A short focused brief plans better than a long
   speculative one. Cut anything you cannot defend.

If the user gives you a one-liner, do not invent a feature spec. Ask the
questions whose answers you would actually need. If they refuse to elaborate,
produce the best brief you can with assumptions tagged.

## When to stop

You are done when:
- the goal is one sentence the user agrees with,
- the in-scope list could be acceptance-tested,
- the out-of-scope list rules out the obvious adjacent work,
- the open questions are the smallest non-empty set you can defend.

Hand off to `loom epic` with the refined brief.
