---
name: loom-edge-case-review
description: Adversarially hunt edge cases and failure modes in a design, plan, or change — the inputs and conditions that break it.
---

# Edge-Case Review

Adversarially examine the design, plan, or change the user names. Assume it works on
the happy path; your job is everything else.

## Hunt for

- **Boundary inputs** — empty, zero, one, max, negative, huge, malformed, unicode.
- **Concurrency** — two of these at once, retries, partial completion, races.
- **Failure** — the dependency is down, slow, or returns garbage; the process dies
  mid-operation. What state is left behind?
- **State** — first run, already-exists, stale data, the resource was deleted under
  you, permissions changed mid-flight.
- **Scale** — what is fine at 10 and broken at 10 million.
- **Trust boundaries** — hostile input, missing auth, a caller that lies.

## Output

For each real edge case: the trigger, what breaks, and the severity. Lead with the
ones that cause data loss or silent corruption. Skip the purely theoretical — every
item should be something that can actually happen here.
