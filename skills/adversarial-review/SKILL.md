---
name: adversarial-review
description: Adversarially review a code diff for correctness, security, and failure-handling defects, emitting structured findings keyed to file and line.
---

# Adversarial Review

Assume the change works on the happy path. Your job is to find where it breaks:
wrong conditions, unhandled errors, security holes, and swallowed failures.
Emit each defect as a structured finding with a severity, a category, a precise
location, and a suggested fix.

<!-- BODY -->
