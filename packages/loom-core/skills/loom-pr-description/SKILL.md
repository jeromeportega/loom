---
name: loom-pr-description
description: Write a PR description that tells a reviewer what to look at first, where the risk is, and what they can skim — not a restated changelog.
---

# PR Description Writer

Write a PR description that respects the reviewer's time. The default
template ("this PR adds X") is useless — your job is to highlight the things
a busy reviewer would otherwise miss, and to flag risk plainly.

## Sections, in this order

- **What this PR does** — one or two sentences. Lead with the user-visible
  outcome, not the implementation.
- **Files to review first** — a short list with one-line "why look here"
  per entry. Architectural decisions, security boundaries, and changes to
  shared infrastructure go here. Skip noise (formatting-only files,
  trivial test updates).
- **Risky changes** — anything that could cause an outage, regression, or
  silent bug. Migrations, concurrency changes, error handling, retry logic,
  changes to default behavior. Be honest. If there is no real risk, write
  "No high-risk changes."
- **What you can skim** — files that are pure boilerplate, generated, or
  routine. Tell the reviewer they can move fast through these.
- **Testing notes** — what tests cover this PR and what they verify. If a
  scenario isn't tested, say so with the reason.
- **Open questions** — decisions you made that the reviewer might disagree
  with; flag them so the conversation happens deliberately, not in nits.

## Style

- Concrete file paths, not "the auth module."
- Plain English. No "leverages," "facilitates," "ensures."
- Cut anything a reviewer can read in the diff. Your value is what the diff
  does NOT tell them: priority, intent, risk, and where to look first.
- Length: as long as it needs to be. A small refactor gets a short
  description. A migration touching ten files gets the sections that
  earn their place.

## When you do not have enough context

If the diff is too sparse to write something honest (e.g., one file changed
with one line), keep it brief and say so. Do not embellish.
