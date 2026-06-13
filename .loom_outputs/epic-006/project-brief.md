# Remove BMAD Scaffolding — Loom Prunes Its Own Vendored Skills

## The Problem

Loom's repository carries ~44 vendored `bmad-*` skills in each of two IDE-command directories (`.agents/skills/` and `.claude/skills/`). They are a holdover from when loom's planning method was a third-party (BMAD) workflow. Loom now plans and builds itself using its **own** personas (`packages/loom-core/personas/`) and five ported, loom-native review/verify skills under `skills/`. The vendored `bmad-*` directories are dead weight: they bloat the repo, muddy the project's "skill story," and force maintainers and docs to keep accounting for skills that loom's autonomous pipeline never invokes.

The cost is narrative and maintenance clutter, not broken functionality — but it actively misrepresents what loom is. A reader browsing the repo sees a vendored third-party method, not "loom's own skills."

## Target Users

- **Primary — Loom maintainers / operators (incl. the author dogfooding loom).** They benefit from a leaner repo whose skill surface is unambiguously loom-native, and from docs that no longer reference removed skills.
- **Secondary — New contributors and evaluators reading the repo.** A pruned skill story makes loom's actual architecture legible at a glance.
- **Anti-persona — Loom's autonomous worker pipeline.** It is deliberately *not* a user of these skills: `SkillStore` scans `skills/`, `<repo>/.loom/skills/`, and `~/.loom/skills/` only — never `.agents/skills/` or `.claude/skills/`. The prune must therefore not change anything the pipeline depends on.

## Proposed Solution

Run this prune as a loom epic — loom removing its own scaffolding (dogfooding the deletion). Delete every `bmad-*` directory from both IDE-command folders, preserve all `loom-*` slash commands and all loom-native skills/personas, and bring the `docs/` tree into consistency so no document references a removed skill. Ship as one clean PR. No source or behavior changes to loom-core/cli/mcp/web.

## Key Capabilities

1. **Delete vendored skills** — remove all `.agents/skills/bmad-*` and `.claude/skills/bmad-*` directories (~44 in each).
2. **Preserve loom-native surfaces** — keep every `loom-*` slash command (`loom-approve`, `loom-epic`, `loom-status`, `loom-ux-designer`, and any others) in both directories; touch nothing under `skills/` or `packages/loom-core/personas/`.
3. **Reconcile docs** — grep the `docs/` tree for `bmad` and update every hit so no doc references a removed skill. Known references: `docs/architecture/index.md`, `docs/reviews/epic-2-review.md`, `docs/testing/runbook.md`, `docs/operations/bootstrap.md`, `docs/research/live-agent-guidance.md`, and `docs/capabilities.md` if it lists vendored BMAD skills.
4. **Keep `capabilities.md` accurate** — per the standing invariant, remove rows for vendored BMAD skills; make no other edits to that page.
5. **Document the rationale in the PR** — note that only 5 of ~44 skills were ported (the review/verify skills); the other ~39 (PRD, architecture, epics/stories, research trio, UX, brainstorming, sprint planning, etc.) were operator-facing IDE slash commands never used by loom's autonomous pipeline, so their removal drops manual commands, not autonomous capability.

## Constraints

- **Deletion + docs only.** No source or behavior changes to loom-core, loom-cli, loom-mcp, or loom-web.
- **Preserve loom-* commands and loom-native skills.** Do not remove or alter `packages/loom-core/personas/` or the five ported `skills/` (adversarial-review, edge-case-hunter, failure-investigator, lesson-extractor, doc-distiller).
- **No further porting.** The decision stands: 5 ported skills are enough; do not port more bmad skills.
- **Green suite.** `npm run build` and `npm run test` must pass across all workspace packages after deletion.
- **Single PR.** Deliver as one clean, reviewable change.

## Risks and Open Questions

- **Precondition is satisfied, not assumed.** Epic A's reviewers (`adversarial-review`, `edge-case-hunter`) are confirmed *wired and used*: epic-005 / story-005-002 recorded 12 deduped findings through the live orchestrated review loop, with reviewer activity in `audit_log`/`skill_usage`. Removing the vendored originals does not remove live capability.
- **Hidden references beyond `docs/`.** Grep is scoped to `docs/`, but a `bmad-*` reference could live in code comments, READMEs, config, or CI outside that tree. *[ASSUMPTION]* the verified context ("loom CODE has no functional dependency on the bmad dirs") holds — but a repo-wide `git grep -i bmad` is the cheap insurance and should be run before merge, not just `docs/`.
- **Tests referencing removed skills.** Done-criteria require that no test references a removed bmad skill. *[ASSUMPTION]* none do, given the pipeline never loads these directories — confirm via grep across the test tree, not by relying on a green run alone (a test could pass while still naming a removed skill in a fixture or snapshot).
- **IDE-user disruption.** A human using these as IDE slash commands in Cursor/Claude Code loses ~39 manual commands. This is intended scope (manual commands, not autonomous capability) — flag it in the PR so the loss is a documented decision, not a surprise.
- **Open question:** Are there `loom-*` commands whose internals transitively reference a `bmad-*` skill (e.g., a prompt that names one)? If so, those references must be updated, not just the directories deleted.

## Success Criteria

- `.agents/skills/` and `.claude/skills/` each contain **only** `loom-*` entries; no `bmad-*` directories remain.
- `git grep -i bmad` over `docs/` returns nothing that references a removed skill — the prune and docs are consistent.
- No test references a removed bmad skill; the test suite is unaffected by the deletion.
- `npm run build` and `npm run test` are green across all workspace packages.
- Delivered as one clean PR whose body explains the 5-of-44 ported rationale and confirms removal drops manual IDE commands, not autonomous capability.
