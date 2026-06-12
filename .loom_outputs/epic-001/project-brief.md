# Review Forge — Headless BMAD Skill Harvest for Loom

## The Problem

Loom workers run unattended, but the only automated quality net standing between a worker's output and a merge is `CodeReviewAgent` plus an integration gate. The repo already ships ~44 `bmad-*` skills containing strong review, edge-case, and investigation logic — but every one of them was written for an operator at the keyboard (`WAIT-FOR-USER` halts, menu prompts) and assumes a `_bmad/scripts/` + `_bmad/bmm/config.yaml` overlay that loom does not ship. Result: that capability exists in the codebase but is invisible to the autonomous delivery loop. Stories ship with one reviewer's opinion instead of three, failures get retried without forensic analysis, and lessons evaporate.

## Target Users

- **Primary — Loom workers (autonomous story agents).** They are the consumers of the ported skills; the skills must run headless inside their execution loop with no human input boundaries.
- **Primary — Loom operators (Jerome and other dogfooders).** They inherit the resulting review/investigation signal via `audit_log`, `skill_usage`, and decision traces, and they read `docs/capabilities.md` to know what loom can do.
- **Secondary — Future Epic D consumers** of the `lesson-extractor` JSON output (lesson-consumption pipeline, not built here).
- **Anti-persona — Interactive BMAD users.** Anyone who wants party-mode, elicitation menus, or operator dialogue is explicitly not served by these ports; the vendored originals under `.agents/skills/` and `.claude/skills/` remain for them, untouched.

## Proposed Solution

Port five high-value BMAD skills into loom-native, fully headless verifiers under `skills/` in agentskills.io format, stripping all `WAIT-FOR-USER` boundaries and `_bmad/` overlay references. Where the BMAD original relied on customization overlays, embed loom-sensible defaults inline — extensibility is the dependency we are removing, not preserving. Three of the five (`adversarial-review`, `edge-case-hunter`, `failure-investigator`) wire into the worker execution loop this epic; `doc-distiller` runs at worker-context assembly; `lesson-extractor` is callable-only this epic and feeds Epic D later.

## Key Capabilities

1. **`adversarial-review`** (from `bmad-review-adversarial-general`) — joins `CodeReviewAgent` in the execution-phase review loop, emits findings in the shared schema.
2. **`edge-case-hunter`** (from `bmad-review-edge-case-hunter`) — joins the review loop alongside the above; output normalized to the same shared schema so findings union and dedupe cleanly.
3. **`failure-investigator`** (from `bmad-investigate`) — invoked on test/gate failures in retry handling, routes deterministically by evidence grade: `strong` → `retry-with-hint`, `weak` → `surface-to-operator`, `contradictory` → `stop-epic`.
4. **`doc-distiller`** (from `bmad-distillator`) — runs once per story at worker-context assembly, targets ~50% token reduction of combined planning artifacts while preserving acceptance criteria and constraints verbatim.
5. **`lesson-extractor`** (from `bmad-retrospective`, automated synthesis only) — emits structured lessons JSON for Epic D; not wired into the runtime, no new DB table this epic.
6. **Shared findings schema + review loop integration** — `zod`-validated schema with `severity`, `category`, `location`, `description`, `suggested_fix?`, `source`; review loop unions findings from both new reviewers + `CodeReviewAgent`, dedupes by `(file, line, normalized-description)`, triggers another worker revision while any `blocker` or `high` remains, capped by existing `maxReviewRevisions`.
7. **Skill registration + audit logging** — all five register with `SkillSelector` and write `skill_usage` + `audit_log` rows per invocation (CLAUDE.md invariant #5).

## Constraints

- **agentskills.io format**: lowercase-hyphen names, `SKILL.md` with required frontmatter.
- **Zero `_bmad/` runtime dependency**: verified by a test fixture that runs each skill in a tree with `_bmad/scripts/` and `_bmad/bmm/config.yaml` absent.
- **Prompt caching preserved**: ported skills reuse loom's existing persona/system-prompt caching pattern; static prefixes must remain cacheable (CLAUDE.md invariant #3).
- **Audit logging required**: every skill invocation writes to `skill_usage` and `audit_log` before returning (CLAUDE.md invariant #5).
- **`docs/capabilities.md` updated in the same PR**: five new skill rows (CLAUDE.md capabilities rule).
- **Vendored originals untouched**: no modifications under `.agents/skills/` or `.claude/skills/`.
- **`CodeReviewAgent` not replaced**: new skills run alongside it; it is the backstop when a ported reviewer self-fails.
- **No new operator-facing knobs**: reuse existing `maxReviewRevisions` default; do not introduce a new ceiling.
- **Ship-order cut line**: if a time/cost ceiling is hit, ship `adversarial-review` → `edge-case-hunter` → `failure-investigator` → `doc-distiller` → `lesson-extractor` and stop. The first three are the must-ship core.

## Risks and Open Questions

- **Reviewer self-failure cascade.** Spec says a ported skill that errors gets one repair attempt then `warn-and-continue`, with `CodeReviewAgent` as backstop. **[ASSUMPTION]** the existing review loop has a clean seam to skip a single reviewer's findings without aborting the revision pass; if not, the loop needs a small refactor to support per-reviewer isolation.
- **Dedupe correctness on cross-reviewer findings.** Normalizing description text for `(file, line, normalized-description)` dedupe is fuzzy by nature — two reviewers describing the same bug in different words may both survive. **[ASSUMPTION]** simple normalization (lowercase, whitespace collapse, punctuation strip) is acceptable for v1; semantic dedupe is out of scope.
- **`failure-investigator` evidence grading is LLM-judged.** The skill picks `strong` / `weak` / `contradictory`; the routing switch is deterministic but the input is not. Risk: a flaky test classified `strong` triggers `retry-with-hint` loops. Mitigation depends on the existing retry cap; **[ASSUMPTION]** loom already has a per-story retry ceiling that bounds this.
- **`doc-distiller` ~50% token target vs. "preserve acceptance criteria verbatim".** These can conflict on artifact-heavy stories. The spec says never drop testable requirements; in practice the distiller may miss the 50% target on some stories. **[ASSUMPTION]** missing the compression target is acceptable; dropping an acceptance criterion is not.
- **`lesson-extractor` output schema lock-in.** Epic D will consume it but does not exist yet. **Open question:** is the lesson JSON schema this epic emits frozen, or should Epic D be free to renegotiate? Recommend treating it as provisional and documenting it as such in the skill's `SKILL.md`.
- **Seed story for end-to-end success criterion.** The success criteria reference "a designated seed story" but the brief does not name one. **Open question:** which story file is the canonical seed for the end-to-end run? Needs designation before the success criterion is checkable.
- **Prompt-cache hit rate on five new skills.** Adding five cacheable system prefixes increases cache footprint. **[ASSUMPTION]** Anthropic's cache budget accommodates this without eviction churn on existing personas; worth measuring on the first real run.

## Success Criteria

- Each of the five skills runs end-to-end in a tree where `_bmad/scripts/` and `_bmad/bmm/config.yaml` are absent (test fixture hides those paths).
- A shared `zod` findings schema exists; both `adversarial-review` and `edge-case-hunter` emit against it; malformed output is rejected, triggers exactly one repair attempt, then `warn-and-continue` is logged.
- Running the designated seed story end-to-end produces `audit_log` + `skill_usage` rows for `adversarial-review`, `edge-case-hunter`, and (on an injected failure) `failure-investigator`.
- Unit tests cover: skill loading for all five; schema validation (valid input passes, malformed input rejected); the revision-trigger rule (blocker/high triggers revise; medium/low/info do not; loop honors `maxReviewRevisions` cap); the `failure-investigator` evidence-grade → route table for all three grades.
- `docs/capabilities.md` contains five new rows, one per ported skill, noting CLI/MCP surfaces where applicable.
- `npm run build` and `npm run test` are green across all workspace packages.
- No file under `.agents/skills/` or `.claude/skills/` is modified by this PR.
