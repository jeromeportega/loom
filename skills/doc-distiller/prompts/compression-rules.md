# Compression Rules

These rules govern how source planning artifacts are compressed into the
distilled worker context. Apply them as a final pass over all output. This is
lossless compression for an LLM consumer — strip overhead, never signal.

## Strip — remove entirely

- Prose transitions: "As mentioned earlier", "It's worth noting", "In addition"
- Rhetoric and persuasion: "This is a game-changer", "The exciting thing is"
- Hedging: "We believe", "It's likely that", "Perhaps", "It seems"
- Self-reference: "This document describes", "As outlined above"
- Common-knowledge explanations: "JSON is a data interchange format"
- Repeated introductions of the same concept
- Section-transition paragraphs and decorative formatting (emphasis bold/italic,
  horizontal rules, heading markers that carry no extra meaning)
- Filler phrases: "In order to", "It should be noted that", "The fact that"

## Preserve — keep always

- Every acceptance criterion, character-for-character (see below)
- Specific numbers, dates, versions, percentages
- Named entities (products, companies, people, technologies, file paths)
- Decisions and their rationale (compressed: "Decision: X. Reason: Y")
- Rejected alternatives and why (compressed: "Rejected: X. Reason: Y")
- Explicit constraints and non-negotiables
- Dependencies and ordering relationships
- Open questions and unresolved items
- Scope boundaries (in / out / deferred)
- Success criteria and how they are validated
- Risks with their severity signals
- Conflicts between artifacts — note them explicitly, never silently resolve

## Transform — change form for efficiency

- Long prose paragraph → single dense bullet capturing the same information
- "We decided to use X because Y and Z" → "X (rationale: Y, Z)"
- "Risk: … Severity: high" → "HIGH RISK: …"
- Conditional statements → "If X → Y" form
- Lists of related short items → single bullet with semicolons
- Verbose enumerations → parenthetical lists

## Deduplicate

- Same fact in multiple artifacts → keep the most detailed version once
- Same concept at different detail levels → keep the detailed version
- Overlapping lists → merge into one, no duplicates
- Artifacts disagree → note the conflict: "PRD says X; architecture says Y —
  unresolved"

## Acceptance criteria are sacred

Acceptance criteria are the one class of content that must NOT be transformed,
reworded, re-cased, or re-punctuated. Copy each criterion string verbatim into a
dedicated `## Acceptance criteria (verbatim)` section and list it in
`acceptance_criteria_preserved`. The context assembler exact-string-matches every
criterion against the distilled output and aborts the run if any is missing — a
paraphrase, even a harmless one, fails the check.
