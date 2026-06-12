# Review Forge — Headless BMAD Skill Harvest for Loom

## Overview

Loom workers run autonomously, but only `CodeReviewAgent` plus an integration gate stand between worker output and merge. The repo ships ~44 `bmad-*` skills with strong review, edge-case, and forensic logic, but all assume an interactive operator and a `_bmad/` overlay loom does not ship. This PRD covers porting five high-value skills into headless, loom-native verifiers under `skills/`, wiring three of them into the worker review loop, one into context assembly, and exposing the fifth as a callable for a future Epic D. The result: three independent reviewers per story, deterministic failure routing, and structured lesson capture — with zero new operator knobs.

## Goals

- **G1 — Triple the review signal per story.** Every story revision pass collects findings from `CodeReviewAgent`, `adversarial-review`, and `edge-case-hunter`, deduped against a shared schema. *Metric:* seed-story run produces ≥3 distinct reviewer sources in `skill_usage`, with dedupe collapsing identical `(file, line)` findings.
- **G2 — Route failures deterministically by evidence grade.** `failure-investigator` classifies each test/gate failure and the router dispatches without LLM input. *Metric:* unit test covers all three grades (`strong` → `retry-with-hint`, `weak` → `surface-to-operator`, `contradictory` → `stop-epic`); seed-story injected failure produces the expected route row in `audit_log`.
- **G3 — Compress planning context ~50% without losing testable requirements.** `doc-distiller` runs at worker-context assembly. *Metric:* on the seed story, distilled artifact is ≤55% of the input token count AND every acceptance criterion from the source appears verbatim in the output (string-match assertion).
- **G4 — Zero `_bmad/` runtime dependency.** *Metric:* test fixture hides `_bmad/scripts/` and `_bmad/bmm/config.yaml`; all five skills load and run green.

## User Stories

- **US-1 (Must)** — As a loom worker, I want `adversarial-review` and `edge-case-hunter` to run alongside `CodeReviewAgent` so my output is checked from three independent angles before I revise.
- **US-2 (Must)** — As a loom worker, I want failures classified and routed deterministically so retries carry forensic context and dead-ends stop the epic instead of looping.
- **US-3 (Must)** — As a loom worker, I want my planning context distilled so I spend tokens on code, not boilerplate, without losing any acceptance criterion.
- **US-4 (Must)** — As a loom operator, I want `skill_usage` and `audit_log` rows for every ported-skill invocation so I can see which reviewer caught what.
- **US-5 (Should)** — As a future Epic D consumer, I want `lesson-extractor` to emit structured lessons JSON I can consume later, even though no runtime wires it in yet.

## Functional Requirements

- **FR-1** — Ship five skills under `skills/` in agentskills.io format (lowercase-hyphen names, `SKILL.md` with required frontmatter): `adversarial-review`, `edge-case-hunter`, `failure-investigator`, `doc-distiller`, `lesson-extractor`.
- **FR-2** — Each ported skill strips all `WAIT-FOR-USER` boundaries and menu prompts from its BMAD source; embeds loom-sensible defaults inline where the original referenced `_bmad/scripts/` or `_bmad/bmm/config.yaml`.
- **FR-3** — Define a shared `zod` findings schema with fields `severity` (`blocker | high | medium | low | info`), `category`, `location` (`{file, line?}`), `description`, `suggested_fix?` (optional), `source` (skill name).
- **FR-4** — Extend the execution-phase review loop: invoke `adversarial-review` and `edge-case-hunter` alongside `CodeReviewAgent` per revision pass; union the findings; dedupe by `(file, line, normalized-description)` where normalization is lowercase + whitespace collapse + punctuation strip.
- **FR-5** — Trigger another worker revision while any `blocker` or `high` finding remains; `medium`, `low`, and `info` do not trigger revision. Honor the existing `maxReviewRevisions` cap; do not introduce a new ceiling.
- **FR-6** — On malformed reviewer output (schema validation fails), make exactly one repair attempt, then log `warn-and-continue` and skip that reviewer's findings for the pass without aborting the revision loop. `CodeReviewAgent` is the backstop.
- **FR-7** — Wire `failure-investigator` into retry handling: on test or gate failure, invoke the skill; it grades the evidence as `strong`, `weak`, or `contradictory`; a deterministic router maps `strong` → `retry-with-hint` (hint passed to next worker attempt), `weak` → `surface-to-operator`, `contradictory` → `stop-epic`.
- **FR-8** — Run `doc-distiller` once per story at worker-context assembly, targeting ~50% token reduction of combined planning artifacts. Acceptance criteria and explicit constraints from source artifacts MUST appear verbatim in the output; missing the compression target is acceptable, dropping a criterion is not.
- **FR-9** — Expose `lesson-extractor` as a registered, callable skill emitting lessons JSON. Do NOT wire it into the runtime this epic. Document the schema in its `SKILL.md` as **provisional** pending Epic D.
- **FR-10** — Register all five skills with `SkillSelector` and write a `skill_usage` row plus an `audit_log` row per invocation, before returning to the caller (CLAUDE.md invariant #5).
- **FR-11** — Preserve prompt caching: ported skills reuse loom's existing persona/system-prompt caching pattern; static prefixes remain cacheable (CLAUDE.md invariant #3).
- **FR-12** — Update `docs/capabilities.md` in the same PR with five new rows, one per ported skill, noting CLI/MCP surfaces where applicable.
- **FR-13** — Do not modify any file under `.agents/skills/` or `.claude/skills/`. The vendored interactive originals remain untouched.
- **FR-14** — Ship-order cut line: if a time/cost ceiling is hit, ship in this order and stop: `adversarial-review` → `edge-case-hunter` → `failure-investigator` → `doc-distiller` → `lesson-extractor`. The first three are the must-ship core.

## Non-Functional Requirements

- **NFR-1 — Headless purity.** Each of the five skills runs end-to-end in a test fixture where `_bmad/scripts/` and `_bmad/bmm/config.yaml` are absent. No path under `_bmad/` may be read at runtime.
- **NFR-2 — Prompt-cache hit rate.** Adding five new cacheable system prefixes must not evict existing persona prefixes on the first real seed-story run. Measure cache hit rate and log it; if eviction occurs, document and triage post-ship.

## Epics

- **Epic 1 — Review Forge: headless BMAD skill harvest.** Ports the five skills, defines the shared findings schema, wires three into the worker loop (review + retry + context assembly), registers all five for auditing, and updates capabilities docs. Single cohesive shipping unit.

## Out of Scope

- Epic D lesson-consumption pipeline (only `lesson-extractor` output schema is delivered here, marked provisional).
- New DB tables for lessons.
- Semantic / embedding-based finding dedupe (lexical normalization only for v1).
- New operator-facing knobs or a separate review-revision ceiling.
- Modifying vendored interactive skills under `.agents/skills/` or `.claude/skills/`.
- Porting any of the other ~39 `bmad-*` skills not named in FR-1.
- Wiring `lesson-extractor` into the runtime.

```json
{
  "epics": [
    {
      "epic_id": "epic-001",
      "title": "Review Forge: headless BMAD skill harvest",
      "priority": "must-have",
      "prd_ref": ".loom/planning/prd.md",
      "requirements": ["FR-1", "FR-2", "FR-3", "FR-4", "FR-5", "FR-6", "FR-7", "FR-8", "FR-9", "FR-10", "FR-11", "FR-12", "FR-13", "FR-14"],
      "stories": [
        {
          "id": "story-001-001",
          "title": "Shared findings schema + skill scaffolding",
          "description": "Define the zod findings schema (severity, category, location, description, suggested_fix?, source) in loom-core, and scaffold all five skill directories under skills/ with agentskills.io-compliant SKILL.md frontmatter. Register the five skills with SkillSelector with stub bodies that pass schema validation and write skill_usage + audit_log rows.",
          "acceptance_criteria": [
            "Shared zod findings schema exported from loom-core with all required fields",
            "Five skill directories exist under skills/ with valid SKILL.md frontmatter (lowercase-hyphen names)",
            "All five skills load via SkillSelector without _bmad/ paths present",
            "Each stub invocation writes one skill_usage and one audit_log row before returning",
            "Unit test asserts schema accepts a valid finding and rejects a malformed one"
          ],
          "estimated_complexity": "medium",
          "dependencies": []
        },
        {
          "id": "story-001-002",
          "title": "Port adversarial-review and edge-case-hunter as headless reviewers",
          "description": "Port the BMAD adversarial and edge-case-hunter skill bodies into the scaffolded skills, stripping WAIT-FOR-USER halts and inlining loom-sensible defaults where the originals referenced _bmad/ overlays. Both emit against the shared findings schema with source set to the skill name. Preserve prompt-cacheable static prefixes.",
          "acceptance_criteria": [
            "adversarial-review and edge-case-hunter SKILL.md bodies contain no WAIT-FOR-USER or interactive-menu directives",
            "No runtime read of any _bmad/ path (verified by fixture hiding those paths)",
            "Both skills emit findings matching the shared zod schema on a sample input",
            "Static system-prompt prefixes remain identical across invocations to preserve cache hits",
            "No file under .agents/skills/ or .claude/skills/ is modified"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-003",
          "title": "Wire three-reviewer review loop with dedupe and revision trigger",
          "description": "Extend the execution-phase review loop to invoke CodeReviewAgent, adversarial-review, and edge-case-hunter in parallel, union their findings, and dedupe by (file, line, normalized-description) using lowercase + whitespace-collapse + punctuation-strip normalization. Trigger a worker revision while any blocker/high finding remains; honor existing maxReviewRevisions cap. On per-reviewer schema-validation failure, attempt one repair then warn-and-continue without aborting the pass.",
          "acceptance_criteria": [
            "Review pass invokes all three reviewers and unions their findings",
            "Dedupe collapses two findings with same (file, line) and identical-after-normalization descriptions to one",
            "Unit test: blocker triggers revision; high triggers revision; medium/low/info do not",
            "Unit test: loop terminates at maxReviewRevisions and does not introduce a new ceiling",
            "Unit test: malformed reviewer output triggers exactly one repair attempt then warn-and-continue is logged, pass continues",
            "CodeReviewAgent remains the backstop when a ported reviewer self-fails"
          ],
          "estimated_complexity": "large",
          "dependencies": ["story-001-002"]
        },
        {
          "id": "story-001-004",
          "title": "Port failure-investigator and wire deterministic retry router",
          "description": "Port bmad-investigate as a headless skill that grades evidence as strong, weak, or contradictory. Wire it into retry handling on test/gate failures with a deterministic router: strong -> retry-with-hint (hint passed to next worker attempt), weak -> surface-to-operator, contradictory -> stop-epic.",
          "acceptance_criteria": [
            "failure-investigator SKILL.md contains no interactive halts and no _bmad/ path reads",
            "Skill outputs an evidence grade in {strong, weak, contradictory} for sample failures",
            "Router unit test covers all three grades and asserts the expected dispatch for each",
            "retry-with-hint passes the investigator's hint through to the next worker invocation",
            "surface-to-operator and stop-epic both write distinguishable audit_log entries",
            "Existing per-story retry ceiling bounds the strong -> retry loop (no new ceiling added)"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-005",
          "title": "Port doc-distiller and run it at worker-context assembly",
          "description": "Port bmad-distillator as a headless skill targeting ~50% token reduction of combined planning artifacts. Acceptance criteria and explicit constraints from source artifacts must appear verbatim in the output. Invoke once per story at worker-context assembly.",
          "acceptance_criteria": [
            "doc-distiller SKILL.md contains no interactive halts and no _bmad/ path reads",
            "Distilled output on a sample story is <=55% of input token count",
            "Every acceptance criterion string from input artifacts appears verbatim in distilled output (string-match assertion)",
            "Compression target miss is logged but does not fail the run; dropped acceptance criterion DOES fail the run",
            "Worker-context assembly invokes the skill once per story and writes the usual skill_usage + audit_log rows"
          ],
          "estimated_complexity": "medium",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-006",
          "title": "Port lesson-extractor as callable-only with provisional schema",
          "description": "Port the automated-synthesis portion of bmad-retrospective into a callable skill that emits structured lessons JSON. Do not wire into the runtime. Document the output schema in SKILL.md as provisional pending Epic D. No new DB table.",
          "acceptance_criteria": [
            "lesson-extractor SKILL.md contains no interactive halts and no _bmad/ path reads",
            "Skill emits lessons JSON conforming to a documented schema embedded in SKILL.md",
            "SKILL.md explicitly marks the schema as provisional pending Epic D",
            "Skill is registered with SkillSelector and callable; no runtime caller is added",
            "No new database table or migration is introduced"
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-001"]
        },
        {
          "id": "story-001-007",
          "title": "Update docs/capabilities.md and run end-to-end seed-story verification",
          "description": "Add five new rows to docs/capabilities.md, one per ported skill, noting CLI/MCP surfaces where applicable. Run the designated seed story end-to-end (with an injected failure to exercise failure-investigator) and verify audit_log + skill_usage rows for adversarial-review, edge-case-hunter, and failure-investigator. Run the full build + test suite across all workspace packages and fix any cross-cutting regressions.",
          "acceptance_criteria": [
            "docs/capabilities.md gains exactly five new rows, one per ported skill",
            "Seed-story end-to-end run produces audit_log + skill_usage rows for adversarial-review, edge-case-hunter, and failure-investigator (injected failure)",
            "Fixture confirms no runtime read of _bmad/scripts/ or _bmad/bmm/config.yaml across all five skills",
            "npm run build is green across all workspace packages",
            "npm run test is green across all workspace packages",
            "No file under .agents/skills/ or .claude/skills/ is modified by the PR"
          ],
          "estimated_complexity": "small",
          "dependencies": ["story-001-002", "story-001-003", "story-001-004", "story-001-005", "story-001-006"]
        }
      ]
    }
  ]
}
```
