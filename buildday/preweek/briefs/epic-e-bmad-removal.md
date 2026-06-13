# Epic E — Remove BMAD scaffolding (loom prunes itself)

## Problem

Loom vendors ~44 `bmad-*` skills in `.agents/skills/` and `.claude/skills/`.
Epic A (Review Forge) ported the 5 high-value review/verify skills into
loom-native headless skills under `skills/` (`adversarial-review`,
`edge-case-hunter`, `failure-investigator`, `lesson-extractor`,
`doc-distiller`), and epic-002 ("Activate Review Forge") wired the reviewers
into the worker review loop. With loom now building itself off its own
personas and skills, the vendored BMAD corpus is dead weight — confusing for
contributors and at odds with the "loom builds loom" thesis.

## Who it's for

Loom contributors/operators: a leaner repo where the skill story is "loom's
own skills," not a vendored third-party method.

## Verified before writing this (on main @ Review Forge merge)

- Loom CODE has no functional dependency on the bmad dirs (only a stray
  comment in `contextAssembler.ts`).
- No TEST references bmad — removal won't break the suite.
- The skill system (`SkillStore`) scans `skills/`, `<repo>/.loom/skills/`,
  `~/.loom/skills/...` — it does NOT scan `.agents/skills/` or
  `.claude/skills/`. Those are IDE slash commands, not loom-worker inputs.
- Planner personas (`packages/loom-core/personas/`) and schemas: no bmad
  references.

## Precondition — SATISFIED

Epic A's reviewers must be wired and used, not just present. Met by epic-002
("Activate Review Forge: make the ported reviewers actually run", PR #4).
Re-confirm `adversarial-review` + `edge-case-hunter` show audit_log /
skill_usage rows before deleting the originals.

## What to do

1. **Delete** `.agents/skills/bmad-*` and `.claude/skills/bmad-*` (~44 each).
2. **KEEP** the `loom-*` slash commands in both dirs (`loom-approve`,
   `loom-epic`, `loom-status`, `loom-ux-designer`) — those are loom's.
3. **Update docs** that reference bmad (capabilities-stay-current invariant):
   `docs/architecture/index.md`, `docs/reviews/epic-2-review.md`,
   `docs/testing/runbook.md`, `docs/operations/bootstrap.md`,
   `docs/research/live-agent-guidance.md`. Update `docs/capabilities.md` if it
   mentions the vendored BMAD skills.
4. Note in the PR that only 5 of ~44 were ported; the other ~39 (PRD,
   architecture, epics/stories, research trio, UX, brainstorming, sprint
   planning…) were operator-facing slash commands never used by loom's
   autonomous pipeline, so their removal drops manual commands, not
   autonomous capability.

## Done means

- `.agents/skills/` and `.claude/skills/` contain only `loom-*` entries.
- `npm run build` + `npm run test` green on main.
- No doc references a removed bmad skill.
- One clean PR (loom runs this as its own epic — dogfooding the prune).

## Non-goals

- Removing or altering loom's own personas or the ported `skills/`.
- Porting any further bmad skills (decided: the 5 are enough).
- Touching `loom-*` slash commands.

## Operator decision to confirm

Operator is fine losing the unported BMAD slash commands (relying on loom
now). If any are still hand-invoked (e.g. `bmad-brainstorming`,
`bmad-create-prd`), name them and keep just those.
