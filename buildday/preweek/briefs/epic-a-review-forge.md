# Epic A — Review Forge: harvest BMAD skills into headless loom verifiers

## Problem

Loom vendors ~44 `bmad-*` skills in `.agents/skills/` and `.claude/skills/`,
but they are operator-facing: interactive menus, WAIT-FOR-USER steps, and a
hard dependency on `_bmad/scripts/resolve_customization.py` +
`_bmad/bmm/config.yaml`. None of that review/verification capability is
available to loom's autonomous workers, whose only quality net today is
CodeReviewAgent + the integration gate.

## Who it's for

Loom's own worker and review agents — and transitively every loom operator,
who gets higher-quality unattended delivery.

## What to build

Port the highest-value BMAD skills into loom-native, headless skills under
`skills/` (agentskills.io format: lowercase-hyphen name, SKILL.md
frontmatter), with zero `_bmad/` dependencies, registered with the skill
system (SkillSelector/skill_usage):

1. `adversarial-review` (from bmad-review-adversarial-general) — near-headless
   already; normalize output to a structured findings list.
2. `edge-case-hunter` (from bmad-review-edge-case-hunter) — already emits
   JSON; normalize schema.
3. `failure-investigator` (from bmad-investigate) — strip user-wait at outcome
   boundaries; auto-route on evidence grade; invoked on test/gate failures.
4. `lesson-extractor` (from bmad-retrospective) — extract ONLY the automated
   lesson-synthesis steps; drop party-mode dialogue. (Feeds Epic D later.)
5. `doc-distiller` (from bmad-distillator) — compress planning artifacts
   before injection into worker context.

Wire 1+2 into the execution-phase review loop (alongside CodeReviewAgent,
honoring `maxReviewRevisions`), and 3 into retry/infra-failure handling.

## Done means

- Each ported skill runs end-to-end with no `_bmad/` files present.
- Adversarial review + edge-case hunter demonstrably execute during a real
  story review today (audit_log + skill_usage rows).
- Unit tests for skill loading + output schemas; suite green.
- `docs/capabilities.md` updated.

## Non-goals

- Porting interactive skills (party-mode retros, elicitation menus,
  research trio) — they stay operator-facing.
- Modifying the vendored `.agents/skills/` originals.
