---
title: "Epic 7 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 7 Review: Eval & Safety

Reviewing skill provenance, the skill lifecycle (canary + auto promote/demote), the
eval runner, and the skill-quality judge — the answers to "how do we measure quality"
and "how do we stop the system degrading itself."

No code fixes were needed this pass — Epic 7 is coherent. The findings below are all
honest limitations to document, several of which are load-bearing for Epic 9.

## Findings — documented

### Important — the honest caveats

**1. A green `npm test` does not mean loom's planning quality is good.**
- The eval suite runs in CI with `MockLLMClient` — that verifies the *harness* works
  (cases load, the planner runs, checks evaluate), NOT that loom produces good plans.
- Real quality measurement requires `loom eval` against a real backend. This
  distinction must stay loud: the test count measures *correctness of loom's code*;
  `loom eval` measures *quality of loom's output*. They are different things.

**2. The skill judge is loom judging loom — a closed loop.**
- `SkillJudge` is an LLM scoring another LLM's generated skill. It has no external
  ground truth. It is a cheap *first filter* for obvious junk.
- The real, independent signal is the **lifecycle track record** — actual story
  outcomes with the skill injected. That is the harder evidence, and it is what
  promotion/demotion is based on. The judge gates entry; the track record governs trust.

**3. Provenance and lifecycle are per-machine.**
- `skill_usage` is each engineer's local SQLite; lifecycle metadata is rewritten in
  each engineer's `~/.loom/skills/`. A skill promoted on one laptop is not promoted on
  another. This is correct for Epic 7 in isolation — and it is exactly the gap
  **Epic 9 (shared skill corpus)** closes. The cross-machine track-record aggregation
  is the open data-model question Epic 9 must answer.

### Medium — documented, deferred

**4. `loom eval` is expensive — 6 cases × a full planner each.**
- ~30 LLM calls per run. Session-based, so no dollar cost, but ~10–20 min and
  rate-limit-consuming. `loom eval` is a *periodic* check, not a per-commit gate.
  Epic 9's eval-gated merge will need a lighter per-skill eval mode.

**5. Skill generation is now two LLM calls (extract + judge).**
- Only when a skill is actually extracted (most stories yield `NONE`). Cheap on Haiku,
  but there is still no `policy.agents.skill_generation` on/off/sampled toggle. Low
  priority given the session-based cost model, but it remains the documented control.

### Low — minor

**6. A demoted skill cannot auto-recover.**
- A `disabled` skill is never injected again, so it never earns a new track record —
  recovery is manual (`loom skills promote`). Intentional: anti-degradation errs
  toward keeping a bad skill out.

**7. A candidate can starve.**
- A candidate is canary-injected only when it keyword-matches a story *and* there is a
  spare slot. A good-but-rarely-matching candidate may never reach `promoteAfter`
  successes. `loom skills promote` is the manual escape hatch.

**8. Regenerating a skill of the same name keeps the old track record.**
- `skill_usage` is keyed by name; an overwritten skill inherits a track record that
  described different content. Carried from the Epic 5 name-collision note.

## Downstream impact matrix

| Finding | Epic 8 (MCP) | Epic 9 (Shared skills) |
|---|---|---|
| #1 mock eval ≠ quality | — | eval-gated merge must use a *real* backend |
| #2 judge closed loop | — | track record is the real merge signal |
| #3 per-machine | — | **BLOCKING design input** — Epic 9 must aggregate |
| #4 eval cost | — | needs a per-skill-PR eval mode |
| #5 gen cost | — | — |

## What's solid

- **The anti-degradation loop is real and tested.** Generated skills earn trust through
  measured story outcomes (`SkillUsageStore`), not vibes. A skill that correlates with
  failures is automatically removed from circulation. That is a genuine answer to "how
  do we stop self-learning from degrading the system."
- **The canary bounds blast radius.** An unproven skill rides only in spare slots —
  it can never displace a trusted skill, so a bad candidate's reach is structurally
  limited while it accumulates evidence.
- **Eval isolation.** Each eval case runs the full planner in its own temp directory
  and database (`createDatabase`, non-singleton) — `loom eval` never touches the
  user's real state. Verified by an explicit test.
- **The judge is honestly best-effort.** It can reject obvious junk, but an LLM error
  or unparseable verdict defaults to `accept` — skill generation, and the run, are
  never blocked by the safety check itself.
- **Drift detection exists.** Eval scores are stored per run; `loom eval --compare`
  exits non-zero on a regression — a real, if coarse, quality tripwire.
- **Fully testable.** 207 tests; the entire eval/lifecycle/judge surface runs with
  mocks and temp databases — no API key, no network.
