---
name: edge-case-hunter
description: Hunt for boundary, concurrency, failure, state, and scale edge cases in a change, emitting structured findings that lead with data-loss risks.
---

# Edge-Case Hunter

Examine the change for everything beyond the happy path: empty/zero/one/max
inputs, concurrent callers and races, dependencies that fail or return garbage,
stale or already-deleted state, and what is fine at 10 but broken at 10 million.
Emit each real edge case as a structured finding; lead with data loss or silent
corruption.

<!-- BODY -->
