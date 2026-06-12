---
title: "Epic 12 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 12 Review: Research & Q&A Mode

Reviewing the `ResearchAgent`, the `researcher` persona, `loom research` /
`loom ask`, and the `loom epic --research` planning hand-off.

The build went green with no surprises — there is no "caught and fixed" section
this epic. One deliberate design decision is noted below; the rest are
documented limitations.

## Design note

**`PersonaId` widened; `PersonaLoader.available()` deliberately did not.**
`researcher` was added to the `PersonaId` union so `PersonaLoader.load()` can
load it, but `available()` still returns only `['analyst', 'pm', 'architect']`
— the planning *pipeline*. The researcher is a loadable persona that is not part
of the Analyst→PM→Architect flow. A doc comment on `available()` makes the
distinction explicit so a future reader does not "fix" the apparent omission.

## Findings — documented

### Medium

**1. Research quality is backend-dependent.**
- With `llm_backend: claude-cli`, the research call runs inside the claude CLI's
  agentic `-p` mode — it can genuinely read the codebase and search the web,
  which is what makes a decision document *grounded*. With `anthropic-api` or a
  mock, the call is a single plain completion: the agent answers from model
  knowledge with no live file or web access.
- This is acceptable — `claude-cli` is the default and the session-based path
  loom is built around — but it means the depth of a `loom research` result
  is not uniform across backends. Documented.

### Low

**2. `loom research` delegates the loop; it does not own one.**
- `ResearchAgent` makes exactly one `complete()` call. Multi-step investigation
  happens *inside* that call, performed by the agentic backend. loom does not
  orchestrate a research tool-loop of its own. Right-sized for claude-cli;
  a non-agentic backend simply gets a shallower answer.

**3. `--research` reaches the PM and Architect only through the Analyst.**
- The decision doc is fed to the Analyst, which carries the chosen approach into
  the project brief; the brief then flows downstream. The PM and Architect see
  the brief's framing of the decision, not the raw research doc. Indirect, but
  correct — the Analyst owns the project's framing, so that is the right seam.

**4. The decision document is unvalidated freeform markdown.**
- Unlike epic YAML (zod-validated), the research doc has no schema —
  `trimToFirstHeading` is the only shaping. A persona that drops a required
  section yields a doc without it. Consistent with the brief and PRD, which are
  also freeform persona output.

## Downstream impact matrix

| Finding | Epic 9 (shared skills — deferred) | Epic 14 (pi dashboard) |
|---|---|---|
| #1 backend-dependent quality | — | a research panel should show the active backend |
| #2 single delegated call | — | — |
| #3 Analyst-only hand-off | — | — |
| #4 freeform doc | — | a panel rendering research docs cannot assume structure |

Note: the Epic 12 spec flagged the pi.dev surface as the natural home for an
interactive option-presentation step — `loom research` produces the options
today; an Epic 14-style panel could present them and capture a choice later.

## What's solid

- **Read-only by construction, not by discipline.** `ResearchAgent` imports no
  `Database`, no `WorktreeManager`, no `Supervisor` — it *cannot* touch git or
  worktrees even by mistake. The test asserts no `loom.db` and no `worktrees/`
  appear after a run. The acceptance criterion "does NOT touch git, worktrees,
  or the supervisor" is enforced by the dependency graph.
- **It reuses seams, it does not add a subsystem.** Research is a new persona
  plus a ~120-line agent built on the existing `LLMClient`, `PersonaLoader`,
  `trimToFirstHeading`, and `modelFor`. No new state, no new orchestration.
- **The `--research` plumbing is minimal and aimed correctly.** Three small
  edits — `PlannerOptions`, `PlannerContext`, `AnalystAgent` — thread the doc to
  exactly the persona that should own a settled decision (the Analyst), framed
  explicitly as a "fixed, settled constraint" so the model does not re-litigate
  it.
- **`loom ask` is honestly thin.** One `complete()` call with its own minimal
  system prompt — no persona machinery, no file I/O. The spec said "a thin
  single-call wrapper"; it is exactly that.
- **Session-based by default.** Research and ask run on the configured
  `llm_backend`, which defaults to the no-API-billing `claude-cli` path — the
  same hard constraint every other loom path honours.

## Verdict

Epic 12 is sound and the build is green (274 tests). Research mode is a clean
addition — it composes with the existing planner rather than duplicating it, and
its read-only guarantee is structural. No blocker; all findings are acceptable
trade-offs of delegating the research loop to the agentic backend.
