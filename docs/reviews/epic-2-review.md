---
title: "Epic 2 — Staff Engineer Review"
reviewer: Claude (Sonnet 4.6)
date: 2026-05-22
status: reviewed
---

# Epic 2 Review: BMAD Planning Pipeline

Reviewing the planner (personas, LLM client, Analyst/PM/Architect agents, Planner
orchestration) and the human-gate CLI, with an eye on downstream impact on Epics 3–6.

## Findings

### High — fixed in this pass

**1. Dangling story dependencies would deadlock the Epic 3 supervisor.**
- The epic schema accepts any string in `story.dependencies`. Nothing checked that a
  dependency references a story that actually exists.
- **Impact**: Epic 3's supervisor orders work by dependency. A story depending on
  `story-001-099` (typo / hallucination) would wait forever — a silent deadlock.
- **Fix**: `validateEpicSet()` now verifies every dependency references a real story in
  the plan, and rejects self-dependencies. A failure feeds the PM retry loop.

**2. Epic numbering mismatch between run directory, YAML, and DB.**
- The Planner assigns a run directory (`epic-005/`) before the PM runs, then tells the
  PM to number from `epic-005`. If the PM ignored that and emitted `epic-001`, the
  zod schema still passed (valid format) — producing a run dir / epic-id mismatch, or
  a primary-key collision if `epic-001` already existed in the DB.
- **Fix**: `validateEpicSet()` enforces sequential numbering from the assigned start;
  a mismatch triggers the retry with explicit feedback.

### Medium — documented, not blocking

**3. Prompt caching is wired correctly but currently inert.**
- Every planning call marks the persona system block `cache: true`, and
  `AnthropicClient` translates that to `cache_control: ephemeral`.
- BUT the persona prompts are ~500–800 tokens — below Anthropic's ~1024-token minimum
  cacheable prompt size. The cache never engages for planning.
- This is not a bug — the mechanism is correct and verified by tests. The caching ROI
  the architecture anticipated lives in **Epic 3** (the same project context broadcast
  to many worker agents) and **Epic 5** (skill manifests). Planning is only 5 calls/run.
- **Action**: documented in known-limitations; revisit caching strategy in Epic 3 where
  the shared context is large and reused.

**4. `loom_start_epic` blocks the calling MCP client for minutes.**
- The MCP tool runs the planner to completion before returning. The loom MCP *server*
  stays responsive (Node's event loop is not blocked), but the *client* (Cursor, Claude
  Code) waits for the whole planning run and may hit a tool-call timeout.
- **Action**: documented; Epic 4 should consider an async variant — return immediately
  with a run id, let the client poll `loom_get_status`.

**5. Concurrent planning runs can race on epic numbering.**
- `Planner.nextEpicId()` reads the max epic number, then later writes new epics. Two
  planning runs started close together (two `loom epic` processes, or two
  `loom_start_epic` calls) could both read the same max and collide on insert.
- Low likelihood (a developer rarely fires two plans at once) and it fails loudly on
  the PK constraint rather than corrupting data.
- **Action**: documented; a transaction or advisory lock is the Epic 3/4 fix.

**6. Epic YAML `status` field will drift from the DB.**
- The epic YAML carries `status: planned`; the DB `epics` table also tracks status.
  Once approved/executing, the YAML's `status` is stale.
- **Action**: documented. **Epic 3's supervisor MUST read epic/agent status from the
  DB, never from the YAML.** The YAML status is plan-time only.

### Low — minor, deferred

**7. `trimToFirstHeading` only recognizes `#` ATX headings.**
- A response that opened with `##` or a Setext (`===`) heading wouldn't be trimmed.
  The personas explicitly ask for a leading `#`, so this is a thin safety net working
  as intended. Documented.

**8. Partial artifacts remain after a failed planning run.**
- If the PM fails after both retries, `project-brief.md` and `prd.md` are already on
  disk with no DB epics. Re-running `loom epic` reuses the same run id (DB still
  empty) and overwrites cleanly, so it self-heals. Documented.

**9. `budget_tokens_per_story` in policy.yaml is still unused.**
- It is an Epic 3 (worker) concern. `maxTokens` (16k/call) bounds planning cost.

## Downstream impact matrix

| Finding | Epic 3 (Dispatch) | Epic 4 (MCP) | Epic 5 (Skills) | Epic 6 (IDE) |
|---|---|---|---|---|
| #1 dangling deps | **was BLOCKING** — fixed | — | — | — |
| #2 epic numbering | **was BLOCKING** — fixed | — | — | — |
| #3 caching inert | revisit (big ctx) | — | revisit | — |
| #4 MCP blocking | — | address (async) | — | timeout risk |
| #5 planning race | minor | minor | — | — |
| #6 YAML status drift | **read DB, not YAML** | — | — | — |
| #7 heading trim | — | — | — | — |
| #8 partial artifacts | — | — | — | — |

## What's solid

- **`LLMClient` seam**: the planner never imports the Anthropic SDK. The entire
  Analyst→PM→Architect pipeline is unit-tested with `MockLLMClient` — no key, no network.
- **Schema-validated structured output**: PM epic JSON is parsed, zod-validated, and
  cross-reference-checked, with a feedback retry. Structured LLM output done properly.
- **Run isolation**: each `loom epic` invocation is scoped to `.loom/planning/<run-id>/`
  with globally-sequential epic IDs — repeated runs never collide or overwrite.
- **Bundled personas**: loom ships its own Analyst/PM/Architect persona files; the tool
  works standalone without requiring a BMAD install in every target repo.
- **Graceful degradation**: a tech_notes parse failure does not abort planning — the
  architecture doc still lands and stories simply carry no notes.
- **Honest failure**: PM epic generation fails loudly with the accumulated validation
  errors after two attempts rather than producing a malformed plan.
