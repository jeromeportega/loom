# Epic D — Flywheel: loom learns and proposes (v4.0, stretch)

## Problem

Every epic loom completes generates evidence — decision traces, review
findings, retry history, guidance given — and today that evidence dies in
the database. Loom should convert outcomes into lessons, lessons into
behavior changes, and accumulated learning into proposals for its own
roadmap: a self-improving, governed loop.

## Who it's for

Anyone running loom continuously: each epic should make the next one
measurably better, without a human running retrospectives.

## What to build

1. **Auto-retrospective** — on epic completion (done/failed), run the
   `lesson-extractor` skill (Epic A) over decision_traces, review summaries,
   retry/handoff history, and audit_log for that epic. Output structured
   lessons (what happened, root cause, general rule) persisted to a new
   `lessons` table.
2. **Lesson application** — lessons become one of: a generated/updated skill
   (via the existing skill generation + judge path), a policy suggestion, or
   persona guidance injected into future workers (extend the existing
   guidance/context-notes mechanism). At least one applied lesson must
   demonstrably reach a later worker's context today.
3. **Self-proposal** — combine lessons + open opportunities (Epic C) to draft
   loom's own next-epic proposal, scoped through the planner, queued at the
   approval gate with a "proposed by loom" marker in the decision inbox.
4. **Flywheel view** — minimal mission-control section: lessons learned
   today, where each was applied, current self-proposals.

## Done means

- One real cycle today: completed epic → auto-retro → persisted lesson →
  lesson injected into a subsequent worker → loom-authored proposal at the
  approval gate.
- Tests for lesson extraction trigger + injection path; suite green.
- `docs/capabilities.md` updated.

## Non-goals

- Auto-applying policy changes (suggestions only — humans change policy).
- Fine-tuning/model-level learning — this is file/db/skill-level learning.
- Perfect lesson quality; the loop existing end-to-end beats lesson polish.

## Scope guardrail

This is the stretch epic with a hard 4:15 PM freeze. If time is short, cut
item 4 first, then item 3; items 1–2 alone still demo "loom learns."
