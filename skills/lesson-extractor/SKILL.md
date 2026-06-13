---
name: lesson-extractor
description: Extract reusable lessons from a completed epic's telemetry — decision traces, agent summaries, and audit events — each with the context that makes it actionable on future stories.
---

> **PROVISIONAL SCHEMA — ratified by epic-005 (Loom Flywheel).** The `lessons`
> output shape below is the FR-6 column set finalised in this epic. The
> `kind`/`summary`/`context` shape from the earlier PROVISIONAL marker (Epic D)
> is removed; `category`/`observation`/`general_rule` are the stable axes going
> forward.

# Lesson Extractor

Read a completed epic's telemetry and distill durable lessons: what patterns
worked, what failed, and what was surprising. Each lesson carries the context
that makes it reusable on a future story.

This is a **callable, non-interactive** skill. You are handed an `EpicTelemetry`
payload and you return structured JSON. You never pause for input, never
facilitate a discussion, and never read anything outside the payload you are
given.

## Input

You receive a JSON object representing the epic's execution telemetry:

| Field | Type | Meaning |
|-------|------|---------|
| `epic_id` | string | The completed epic's id (provenance only). |
| `final_status` | `"done"` \| `"failed"` | How the epic ended. |
| `decision_traces` | array | Agent reasoning events captured during the epic. |
| `agents` | array | Per-story agent records (story_id, review_summary, log_tail). |
| `audit_tail` | array | Recent audit log rows for the epic's agents. |

The payload is your **only** source. Do not read story files, configuration,
or any repository path — operate solely on the data you were handed.

## Output schema (FR-6 — ratified by epic-005)

Return a single JSON object with one key, `lessons`: an array of zero or more
lesson objects. Do NOT include `epic_id`, `created_at`, `applied_as`, or
`applied_ref` — those are stamped by the handler before schema validation.

```json
{
  "lessons": [
    {
      "category":     "required — area tag, lowercase-hyphen (e.g. 'schema-migration', 'test-coverage')",
      "observation":  "required — what was observed in the data",
      "general_rule": "required — the reusable rule, stated so a future worker can apply it without this epic's context",
      "root_cause":   "optional — the underlying cause, when clear from the data",
      "evidence":     "optional — a direct quote or pointer into the telemetry that grounds the lesson"
    }
  ]
}
```

Field rules (mirror the `LessonContent` contract in
`packages/loom-core/src/findings/lesson.ts`):

- `category` — required, non-empty, lowercase-hyphen tag (e.g. `schema-migration`,
  `test-coverage`, `auth`, `api-contract`). Used for retrieval matching; prefer
  specificity over generality.
- `observation` — required, non-empty. What was actually observed in the
  telemetry — concrete, specific, past-tense.
- `general_rule` — required, non-empty. A forward-looking rule that a future
  worker can apply without reading this epic. Make the area keyword explicit
  (e.g. "When migrating a schema…", "In auth flows…"). This is the load-bearing
  field for retrieval.
- `root_cause` — optional. The underlying reason, when the telemetry makes it
  clear. Skip if speculative.
- `evidence` — optional. A short direct quote or pointer (e.g. "audit row
  `lesson_extractor_called` at …") that grounds the lesson. Skip if the
  observation is self-evident from the data.
- Emit `{ "lessons": [] }` when the telemetry carries no durable lesson. An
  empty array is a valid, expected result — do not invent lessons to fill it.

## How to extract lessons

Scan the payload for signal in these areas and convert each durable finding
into one lesson:

- **Struggles and rework** → observation about what failed and why.
- **Review feedback themes** → recurring issues or quality patterns.
- **Agent decisions that pivoted** → reasoning shifts visible in decision traces.
- **Audit patterns** → repeated actions, unexpected denials, infra retries.
- **Testing and quality signals** → patterns in review_summary or log_tail.
- **Surprises** → anything that violated an expectation: a tool behaving
  differently than documented, an assumption proven wrong.

Each lesson must be **durable and reusable** — true beyond this one epic. Drop
anything purely incidental that carries no forward-looking value.

Write `general_rule` so a future worker who never saw this epic can tell whether
the lesson applies to their situation. Prefer specifics over generalities.

## Operating constraints

- **Non-interactive.** Never ask a question, never pause, never block on input.
- **Self-contained.** The payload is the whole input; read nothing else.
- **JSON only.** Your entire output is the JSON object described above, with no
  surrounding prose.
- **No blame.** Lessons are about systems and decisions, not individuals.

## Example

For an epic where a shared schema rejected valid input until a default was set,
and where scoping tests to one package sped up iteration:

```json
{
  "lessons": [
    {
      "category": "schema-migration",
      "observation": "The shared findings schema rejected an empty lessons array until an explicit default was added.",
      "general_rule": "When a schema field can legitimately hold an empty collection, give it an explicit default or confirm the zod definition accepts an empty array before wiring consumers.",
      "root_cause": "Zod's z.array() has no default; the field was required and the empty case was not tested.",
      "evidence": "audit row lesson_extractor_called followed immediately by a ZodError on lessons: []"
    },
    {
      "category": "test-coverage",
      "observation": "Running only the changed package's test script kept the iteration loop fast.",
      "general_rule": "While iterating on a single package, scope the test command to that package; run the full suite once before declaring done.",
      "evidence": "log_tail: 'node --test dist-test/test/findings/*.test.js — 1.3s vs full suite 28s'"
    }
  ]
}
```
