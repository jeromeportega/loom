---
title: "Epic 18 — Staff Engineer Review (foundation slice)"
reviewer: Claude (Opus 4.7)
date: 2026-05-22
status: reviewed
scope: "story-018-001 (CodeReviewAgent) + story-018-003 (PrDescriptionAgent) + EpicFinalizer integration. Story-018-002 (worker-side block-and-revise) and story-018-004 (loom review CLI + dashboard surfacing) remain specced."
---

# Epic 18 (foundation) Review

Reviewing the `CodeReviewAgent` and `PrDescriptionAgent` modules in
`loom-core/src/review/`, the bundled `loom-pr-description` skill, and the
`EpicFinalizer` integration that hands PR-body authorship to the LLM (with a
deterministic hand-rolled fallback).

One issue was caught at the compiler and fixed before commit. The rest are
deliberate scope cuts and trade-offs.

## Caught and fixed during the build

**A. `extractJsonBlock` returns `unknown`, not a string.** The first version
of `parseReviewReport` called `JSON.parse` on the result of
`extractJsonBlock` — but that helper already parses the JSON and returns the
value. TS2345 caught the type mismatch at build time. Fixed: treat the
`unknown` return as the value, validate shape, never `JSON.parse` again. The
defensive `try`/`catch` around `extractJsonBlock` also handles the no-JSON
case (where it now throws) without breaking the caller.

## Findings — documented

### Medium

**1. The worker-side review pass is NOT shipped (intentional scope cut).**
- This commit ships the *agents* and the EpicFinalizer's PR description
  integration. It does NOT ship the `CodeReviewAgent → worker → PR comment /
  block-and-revise` integration described in story-018-002. So today's PRs
  (per-story OR per-epic) get the LLM-written description but no automated
  review pass. That's the next slice of Epic 18 and is the story that
  delivers the "catch issues before the human" value-prop.
- Acceptable for v1: the agents exist as building blocks, are tested, and
  the EpicFinalizer integration proves the LLM path works end-to-end.

**2. Diff size to the review agent is unbounded.**
- `CodeReviewAgent.review` feeds the *full* unified diff to the LLM. A
  thousand-line epic diff is fine for Opus's context; a five-thousand-line
  refactor isn't. No chunking, no per-file iteration, no diff summarization.
  Acceptable for the agent layer in isolation; the future worker integration
  needs to address this (either per-story scoping — workers see only their
  own diff — or a chunking strategy).

**3. `CodeReviewAgent` is dead-on-arrival from a feature perspective.**
- The class exists, tests pass, no production caller invokes it. It becomes
  live when story-018-002 lands. Until then, it's a tested building block.
  This is the same pattern Epic 18's spec calls for — the agent and the
  worker integration are separately reviewable.

### Low

**4. PR description uses the worker model, not the planner model.**
- Deliberate cost choice — Sonnet, not Opus. Writing a PR body is a
  body-text task, not a deep-reasoning task; Opus would be expensive overkill.
  Configurable via `llmModel` on `EpicFinalizerOptions`. Revisit if
  descriptions feel shallow on real epics.

**5. Single-model review is the reviewer-as-author problem.**
- The personas flagged this in the consultation: Claude reviewing Claude code
  misses what Claude missed. Cross-vendor or multi-model review is the real
  win. Epic 19 (repo-specific learning skills) is one path to coverage; an
  explicit multi-model mode is another. Both are specced; neither lands
  here. Today's review is "better than nothing," not "best in class."

**6. Defensive JSON parsing is permissive on purpose.**
- A malformed agent response surfaces as a single `should-fix` finding with
  the raw text as `summary` — the human reviewer still gets a useful artifact
  rather than a crash. Could be stricter (reject and re-prompt the model);
  this is the right v1 call. Future loop in Epic 19 can use the rejection
  rate as signal.

## Downstream impact matrix

| Finding | Epic 18 remaining (review pass) | Epic 19 (learning) |
|---|---|---|
| A `extractJsonBlock` (fixed) | — | — |
| #1 no worker integration | story-018-002 is exactly this | depends on it for signal capture |
| #2 unbounded diff | story-018-002 must decide per-story vs chunked | drives finding density |
| #3 dead-on-arrival CodeReviewAgent | resolved when 018-002 lands | — |
| #4 worker model for PR desc | possibly fine; revisit per-output | — |
| #5 reviewer-as-author | multi-model is later; Epic 19's per-repo skill is partial coverage | the learning loop addresses it indirectly |
| #6 permissive parse | the loop in 019 turns rejections into signal | direct dependency |

## What's solid

- **Both agents share a clean shape.** Constructor takes `{ projectRoot, llm,
  model }`. One `complete()` call. One method per agent (`review` / `generate`).
  Easy to swap models per role; easy to reuse from the CLI, MCP, or pi.
- **Defensive parsing throughout.** `parseReviewReport` cannot throw. Every
  failure mode (no JSON block, non-object root, malformed `findings` entries,
  unknown `severity`) degrades to a single `should-fix` note with the raw text
  in `summary`. The human reviewer always sees something useful, even when the
  model returns garbage. Tested for all three branches.
- **EpicFinalizer integration is opt-in via dependency injection.** `llmClient`
  + `llmModel` are optional fields on `EpicFinalizerOptions`. When unset, the
  hand-rolled `epicPrBody` runs unchanged — no regression for users without an
  LLM available. When set, the LLM body wins UNLESS the agent throws, in which
  case `composeBody` falls back to `epicPrBody` automatically.
- **Conflict note is deterministic.** The LLM does not know which stories were
  dropped to merge conflicts. The finalizer appends the conflict section AFTER
  the LLM body so the model cannot lose it. Right separation of concerns —
  the LLM owns the prose, the finalizer owns the structural facts.
- **Bundled skill is loom-branded, freshly authored.** `loom-pr-description`
  matches the rest of the bundled library — clean SKILL.md, no inherited
  machinery, written for loom's voice.
- **Tests cover the real surface.** `parseReviewReport` has three cases (valid
  fenced JSON, no JSON block, malformed finding entries). `CodeReviewAgent.review`
  exercises the full call with a scripted MockLLMClient. `PrDescriptionAgent.generate`
  asserts the LLM output passes through trimmed.

## Verdict

Epic 18 foundation is sound and the build is green (232 core / 301 total).
The cut is honest — agents shipped, EpicFinalizer integration done, worker
integration deferred. The biggest gap (no `loom review` story-by-story
yet) is in the spec, owned by story-018-002, and the rest of Epic 18 is the
next natural piece of work.

Per-PR cost added: one extra Sonnet call when the EpicFinalizer composes the
body. Trivial against the worker LLM spend the rest of the run consumes.
