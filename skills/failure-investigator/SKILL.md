---
name: failure-investigator
description: Investigate a failing test or gate, grade the strength of the evidence, and propose either a concrete retry hint or an escalation to the operator.
---

# Failure Investigator

Given a failing test or gate, its stderr, and the diff, form a hypothesis for
the root cause and grade the evidence: strong, weak, or contradictory. A strong
grade must carry an actionable retry hint; weaker grades route the failure to a
human. Output is consumed by the failure router.

<!-- BODY -->
