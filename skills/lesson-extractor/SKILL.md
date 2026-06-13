---
name: lesson-extractor
description: Extract reusable lessons from a completed epic's telemetry, each with an area category and a general rule that makes it actionable on future stories.
---

> **PROVISIONAL SCHEMA — Epic D in progress.** The `lessons` output shape
> defined below reflects the v18 schema ratified in Epic D (story-005-001).
> The LLM-owned fields (`category`, `observation`, `root_cause`, `general_rule`,
> `evidence`) are the stable contract; handler-owned fields (`epic_id`,
> `applied_as`, `applied_ref`, `created_at`) are stamped by the caller before
> persisting and must NOT appear in the model's output.

# Lesson Extractor

Read a completed epic's telemetry and distill the durable, reusable lessons.
Each lesson captures an observation from the work and a general rule that applies
beyond this one epic. Use an area category (lowercase-hyphen tag) so lessons can
be retrieved by keyword later.

This is a **callable, non-interactive** skill. You are handed structured
telemetry and you return JSON. You never pause for input and never read anything
outside the payload you are given.

## Input

You receive a JSON object with epic telemetry:

| Field | Type | Meaning |
|-------|------|---------|
| `epic_id` | string | The completed epic's id (provenance only). |
| `final_status` | `"done"` \| `"failed"` | Terminal outcome. |
| `decision_traces` | array | Key decisions logged during the epic. |
| `agents` | array | Per-story summaries (`story_id`, `review_summary`, `log_tail`). |
| `audit_tail` | array | Last N audit rows covering the epic's agents. |

The telemetry is your **only** source. Operate solely on the text you were given.

## Output schema

Return a single JSON object with one key, `lessons`: an array of zero or more
lesson objects. The model must return **only** the LLM-owned fields; the caller
stamps the remaining fields before persisting.

```json
{
  "lessons": [
    {
      "category": "lowercase-hyphen area tag, e.g. schema-migration",
      "observation": "required — what actually happened, drawn from the telemetry",
      "root_cause": "optional — the underlying reason",
      "general_rule": "required — a reusable, keyword-bearing rule for future workers",
      "evidence": "optional — the specific signal in the telemetry that supports this"
    }
  ]
}
```

Field rules (mirror the `LessonContent` contract in
`packages/loom-core/src/findings/lesson.ts`):

- `category` — required, non-empty, lowercase-hyphen tag (e.g. `schema-migration`,
  `test-isolation`, `error-handling`). Used for keyword-based retrieval.
- `observation` — required, non-empty string. What specifically happened.
- `root_cause` — optional. The mechanism behind the observation.
- `general_rule` — required, non-empty string. The reusable takeaway, written
  so it applies beyond this epic. Must include at least one area keyword.
- `evidence` — optional. A quote or reference from the telemetry.
- Emit `{ "lessons": [] }` when the telemetry carries no durable lesson.

## How to extract lessons

Scan the telemetry for signal in these areas and convert each durable finding
into one lesson:

- **Struggles and rework** — where work stalled, was redone, or took an unexpected
  path; technical decisions that were reversed; complexity underestimated.
- **Review feedback** — recurring feedback themes, quality issues flagged,
  and exemplary work explicitly praised.
- **Explicit takeaways** — "aha" moments, breakthroughs, and things the agent
  logs suggest would be done differently.
- **Technical debt incurred** — shortcuts taken and why; debt that affects later work.
- **Testing and quality** — approaches that paid off, bug patterns, coverage gaps.
- **Surprises** — anything that violated an expectation: a tool behaving
  differently than documented, a dependency interaction, an assumption proven wrong.

Each lesson must be **durable and reusable** — true beyond this one epic. Drop
anything purely incidental (a one-off typo, a transient environment hiccup).

Write `general_rule` so a future worker can tell whether the lesson applies to
their situation. Prefer specifics over generalities.

## Operating constraints

- **Non-interactive.** Never ask a question, never pause, never block on input.
- **Self-contained.** The telemetry is the whole input. Do not read any repository
  path or runtime state.
- **JSON only.** Your entire output is the JSON object above, with no surrounding prose.
- **No blame.** Lessons are about systems and decisions, not individuals.
- **LLM-owned fields only.** Do not include `epic_id`, `applied_as`, `applied_ref`,
  or `created_at` in your output — these are stamped by the caller.

## Example

For an epic where a worker discovered the lessons DDL needed `IF NOT EXISTS` and
running targeted tests kept the loop fast:

```json
{
  "lessons": [
    {
      "category": "schema-migration",
      "observation": "The initial DDL lacked IF NOT EXISTS guards, causing re-init to throw on existing tables.",
      "root_cause": "Migration authored without idempotency in mind.",
      "general_rule": "Always use CREATE TABLE IF NOT EXISTS for additive schema-migration steps so re-initialization is safe.",
      "evidence": "Pre-v18 upgrade test failed on second init until the guard was added."
    },
    {
      "category": "test-isolation",
      "observation": "Running only the changed package's tests kept the iteration loop under 10 seconds.",
      "general_rule": "Scope test runs to the package under change while iterating; run the full suite once before declaring done."
    }
  ]
}
```
