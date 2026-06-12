---
name: doc-distiller
description: Distill planning artifacts (PRD, epic, architecture, story) into a compact worker context while preserving every acceptance criterion verbatim.
---

# Doc Distiller

Compress the planning artifacts handed to a worker into the smallest context
that still carries the story. Every acceptance criterion must survive verbatim
in the distilled output — the context assembler verifies this and throws if any
is missing. Report the source and distilled token counts.

This is lossless compression for an LLM consumer, not human summarization. Strip
the overhead a human reader needs and a worker agent does not; keep every fact,
decision, constraint, dependency, and acceptance criterion.

## Headless operation

This skill runs unattended at worker-context assembly. It runs start to finish
without pausing: it never asks a question, never waits for a human, and never
stops for confirmation. There is no operator in the loop.

- The four artifacts below are the complete input. Do not read any vendored
  planning runtime, config file, or other path outside them.
- Missing the compression target is a logged warning, never a stop. Dropping an
  acceptance criterion is the only hard failure — and the assembler enforces it.

## Input

A single object with four planning artifacts (any may be an empty string):

- `prd` — the product requirements document
- `epic` — the epic definition
- `architecture` — the architecture / technical guidance
- `story` — the story being implemented, including its acceptance criteria

## Output

The `Distillation` shape:

- `distilled` — the compact context, dense thematically-grouped bullets
- `source_token_count` — token count of the concatenated input artifacts
- `distilled_token_count` — token count of `distilled`
- `acceptance_criteria_preserved` — every acceptance-criterion string carried
  through verbatim

Target: `distilled_token_count <= 0.55 * source_token_count`. Missing it is
logged, not fatal.

## Procedure

1. **Extract** every discrete unit of information across all four artifacts:
   facts and data points (numbers, dates, versions); decisions and their
   rationale; rejected alternatives and why; explicit constraints and
   non-negotiables; dependencies and ordering; named entities; scope boundaries
   (in/out/deferred); open questions; risks; and — first-class — every
   acceptance criterion.

2. **Preserve acceptance criteria verbatim.** Copy each acceptance-criterion
   string character-for-character into the distillate. Never paraphrase,
   re-word, re-case, or re-punctuate one — the assembler does an exact
   string-match and aborts the run if any is missing. Collect every preserved
   criterion into `acceptance_criteria_preserved`. Put them under a dedicated
   `## Acceptance criteria (verbatim)` heading so they survive any later edit.

3. **Deduplicate across artifacts.** The PRD, epic, architecture, and story
   restate each other heavily; that overlap is the largest compression win.
   Keep the most detailed version of each fact once; drop the repeats. When two
   artifacts disagree, keep both and mark the conflict explicitly.

4. **Compress language** per `prompts/compression-rules.md`: strip prose
   transitions, hedging, rhetoric, and common-knowledge explanations; transform
   paragraphs into dense self-contained bullets; make relationships explicit
   (`X because Y`, `X blocks Y`, `X replaces Y`).

5. **Group thematically** with `##` headings derived from the content (problem,
   approach, constraints, scope, dependencies, success criteria, open
   questions). Bullets only — no prose paragraphs, no decorative formatting.

6. **Report token counts.** Count `source_token_count` over the concatenated
   input and `distilled_token_count` over the output with the same tokenizer the
   runtime uses for cache telemetry. If the ratio exceeds 0.55, note it; do not
   stop.

See `prompts/compression-rules.md` for the strip / preserve / transform rules.
