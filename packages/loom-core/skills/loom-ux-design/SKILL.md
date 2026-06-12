---
name: loom-ux-design
description: Produce a UX design spec for a feature — user flows, screen states, and interaction details — before implementation.
---

# UX Design Spec

Produce a UX design specification for the feature the user names. The goal is a
document an engineer can implement from and a reviewer can check against.

## Output

Write a markdown spec covering:

- **Feature** — what is being designed and the user goal it serves
- **Primary flow** — the happy path, step by step, from entry to completion
- **States** — every screen / component state: default, empty, loading, success,
  error, and edge states (long content, no permission, offline)
- **Interactions** — what each control does, and what feedback confirms it
- **Accessibility** — keyboard path, focus order, contrast, screen-reader labels
- **Open questions** — UX decisions that need a product call

Keep it concrete and buildable. Tag anything you assumed with `[ASSUMPTION]`.
