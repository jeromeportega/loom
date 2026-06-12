---
name: loom-code-review
description: Review a code change for correctness, security, and clarity — a staff-engineer pass over a diff or PR.
---

# Code Review

Review the change the user points you at (a diff, a PR, a set of files) as a staff
engineer would. Be specific and cite locations.

## Review for, in priority order

1. **Correctness** — does it do what it claims? Logic errors, off-by-one, wrong
   conditions, unhandled cases.
2. **Security** — injection, missing authorization, secrets in code, unsafe input at
   trust boundaries.
3. **Failure handling** — what happens when a call fails, times out, or returns
   nothing? Are errors swallowed?
4. **Clarity** — would the next engineer understand this? Naming, dead code,
   needless complexity, misleading comments.
5. **Tests** — does the change have them, and do they test behavior rather than
   restate the implementation?

## Output

Group findings by severity — blocker, should-fix, nitpick. For each: the location,
the problem, and the fix. If the change is sound, say so plainly — do not invent
nitpicks to fill a review.
