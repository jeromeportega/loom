---
name: lesson-extractor
description: Extract reusable lessons (worked-well, did-not-work, surprise) from a completed story transcript, each with the context that makes it actionable later.
---

> **PROVISIONAL SCHEMA — pending Epic D.** The `lessons` output shape defined
> below is provisional. It may change once Epic D wires a consumer (a lesson
> store and retrieval path) and learns what that consumer actually needs. Treat
> the field set as unstable: only the `kind` axis (`worked-well` /
> `did-not-work` / `surprise`) is expected to remain. This marker is the sole
> backward-compatibility promise this skill makes — do not depend on the rest
> of the shape until Epic D ratifies it.

# Lesson Extractor

Read a completed story's transcript and distill the durable lessons: what worked
well, what did not, and what was surprising. Each lesson carries the context
that makes it reusable on a future story, and optionally a recommended action.

This is a **callable, non-interactive** skill. You are handed a single story's
transcript and you return structured JSON. You never pause for input, never
facilitate a discussion, and never read anything outside the payload you are
given.

## Input

You receive a JSON object:

| Field | Type | Meaning |
|-------|------|---------|
| `story_id` | string | The completed story's id (provenance only). |
| `epic_id` | string | The story's epic id (provenance only). |
| `transcript` | string | The full record of the story's execution: dev notes, decisions, review feedback, test runs, failures, and outcomes. |

The transcript is your **only** source. Do not read story files, configuration,
or any other repository path to supplement it — operate solely on the text you
were handed.

## Output schema (PROVISIONAL — pending Epic D)

Return a single JSON object with one key, `lessons`: an array of zero or more
lesson objects.

```json
{
  "lessons": [
    {
      "kind": "worked-well | did-not-work | surprise",
      "summary": "required, non-empty — the lesson in one sentence",
      "context": "required, non-empty — the situation that makes it reusable: what was being done, what triggered it, what to watch for",
      "recommended_action": "optional — the concrete thing to do (or avoid) next time"
    }
  ]
}
```

Field rules (mirror the `Lesson` contract in
`packages/loom-core/src/findings/lesson.ts`):

- `kind` — exactly one of `worked-well`, `did-not-work`, `surprise`.
- `summary` — required, non-empty string.
- `context` — required, non-empty string.
- `recommended_action` — optional; include it only when there is a concrete action.
- Emit `{ "lessons": [] }` when the transcript carries no durable lesson. An
  empty array is a valid, expected result — do not invent lessons to fill it.

## How to extract lessons

Scan the transcript for signal in these areas (ported from the retrospective's
deep-story analysis) and convert each durable finding into one lesson:

- **Struggles and rework** → usually `did-not-work`. Where the work stalled, was
  redone, or took an unexpected path; technical decisions that were reversed;
  complexity that was underestimated.
- **Review feedback** → `did-not-work` or `worked-well`. Recurring feedback
  themes, quality or architectural issues flagged, and exemplary work explicitly
  praised.
- **Explicit takeaways** → any `kind`. "Aha" moments, breakthroughs, and things
  the author said they would do differently.
- **Technical debt incurred** → `did-not-work`. Shortcuts taken and why; debt
  that will affect later work.
- **Testing and quality** → `worked-well` or `surprise`. Testing approaches that
  paid off, bug patterns, and coverage gaps discovered.
- **Surprises** → `surprise`. Anything that violated an expectation: a tool
  behaving differently than documented, a dependency interaction, an assumption
  proven wrong.

Each lesson must be **durable and reusable** — true beyond this one story. Drop
anything purely incidental to this transcript (a one-off typo, a transient
environment hiccup) that carries no forward-looking value.

Write `context` so a future worker who never saw this story can tell whether the
lesson applies to their situation. Prefer specifics ("SQLite WAL mode needed a
PRAGMA on every connection, not just at init") over generalities ("database
setup was tricky").

## Operating constraints

- **Non-interactive.** Never ask a question, never pause for confirmation, never
  block on input. Produce the JSON and stop.
- **Self-contained.** The transcript is the whole input. Do not read any
  repository path, configuration, persona, or runtime state to supplement it.
- **JSON only.** Your entire output is the JSON object described above, with no
  surrounding prose.
- **No blame.** Lessons are about systems and decisions, not individuals.

## Example

For a transcript where a worker discovered that a shared schema rejected an
empty array until a default was set, and where running only the changed
package's tests sped up iteration:

```json
{
  "lessons": [
    {
      "kind": "surprise",
      "summary": "The shared findings schema rejected an empty array until a default was set.",
      "context": "Emitting an empty collection against the output schema; the field was required with no default, so validation failed on the empty case.",
      "recommended_action": "When a skill can legitimately return an empty collection, give the schema field an explicit default or confirm it accepts an empty array."
    },
    {
      "kind": "worked-well",
      "summary": "Running only the changed package's test script kept the iteration loop fast.",
      "context": "The repo's full test command compiles and runs every package; scoping to the single package under change avoided that cost while iterating.",
      "recommended_action": "Iterate with the narrowest test selector, then run the full suite once before declaring done."
    }
  ]
}
```
