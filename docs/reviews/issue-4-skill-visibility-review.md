---
title: "Issue #4 — Staff Engineer Review (self-learning visibility)"
reviewer: Claude (Opus 4.7)
date: 2026-05-23
status: reviewed
scope: "SkillEvent stream wired through Supervisor; policy.agents.skill_generation on|off|sampled; audit-log rows for skill_generated / skill_lifecycle_change; loom skills history <name> CLI."
---

# Issue #4 Review — Self-learning visibility

The self-learning loop was running silently. This change makes its four
events (injection, generation, promotion, demotion) observable in three
ways: live CLI lines via a callback, persistent audit rows, and an
operator-facing `loom skills history` command.

## What shipped

- **`SkillEvent` type** (`skills/SkillEvent.ts`) with the four variants.
  Mirrors `WorkerEvent`'s shape so the printer in `run.ts` looks structurally
  the same as `makeEventPrinter`.
- **Supervisor wiring** — `onSkillEvent` callback emits on every injection,
  every lifecycle change, and every successful generation. The lifecycle
  call now also writes a `skill_lifecycle_change` audit row per change, and
  the generator hook writes a `skill_generated` audit row on a successful
  extraction. Both use `command = skill_name` so they're queryable.
- **`policy.agents.skill_generation`** with values `'on' | 'off' | 'sampled'`
  + companion `skill_generation_sample_n` (defaults: `'on'` and `4`). The
  Supervisor honors it on both the CLI run path and the MCP `loom_approve_plan`
  path. `'off'` also short-circuits SkillGenerator construction in `run.ts`,
  so a cost-conscious team doesn't pay for the Haiku call even by mistake.
- **`SkillUsageStore.history(name)`** returns every injection
  chronologically with its outcome — the substrate the new CLI renders.
- **`AuditLog.getByCommand(command, actions?)`** typed query for fetching
  the lifecycle/generation rows by skill name (in chronological order).
- **`loom skills history <name>`** CLI subcommand. Merges audit rows and
  injections into one timeline, marked with `★` (generated), `↻` (lifecycle
  change), `·` (injection with outcome). Tail line shows the aggregate
  track record.

## Findings

### Medium

**1. The injection event surfaces every selected skill, including
hand-authored/bundled ones — but the CLI printer suppresses non-candidate
injection lines.** Audit + history still capture candidate injections only
(the `skill_usage` table tracks all of them, so trackRecord stays accurate);
the printer's job is to keep output manageable. Trade-off is acceptable —
operators who want all injections can `loom skills history <name>` or read
the audit log. If the noise becomes a real complaint, gate behind `--verbose`.

**2. `'sampled'` is a deterministic modulo, not a random sample.** Run state
lives in `Supervisor.successCount`, reset per `run()`. Trade-off: predictable
and testable, but if a team runs many tiny epics, they may not hit the Nth
boundary before each `run()` returns. Acceptable: the same team can pick
`'off'` if they want no extraction; `'sampled'` is for "a few per run"
behavior, which a long-lived run delivers correctly.

**3. The audit-log query relies on `command = skill_name`.** That field
isn't unique to skills — `bash_command` rows use it for shell commands too.
Mitigated by also filtering on `action IN (...)` in `getByCommand`. Safe in
practice; a future schema with a typed `subject` column would be cleaner,
but the migration cost isn't worth it for one query path.

### Low

**4. `loom skills history` doesn't render epic/run grouping.** It's a flat
timeline — fine for the v1 use case (debugging "why is this stuck in
candidate"). If a skill accumulates 50+ injections, a paginator or grouping
helps; defer until the data shape forces it.

**5. The MCP `loom_approve_plan` path doesn't print skill events.** It
runs in the background and there's no streaming consumer wired to
`onSkillEvent` there yet. Audit rows still get written, and pi can consume
them via `loom_get_audit_log`. Surfacing pi dashboard cards for skill
events is the pi-side companion work to this issue; out of scope.

### Out of scope (separate issues)

- ROI measurement (tokens saved per injection) — needs worker token tracking
  (Issue #5 / Epic 16).
- Cross-machine skill sharing — Epic 9 (cloud skills), explicitly deferred.
- Skill marketplace / hub UX — not on the roadmap.

## Tests

Five new test cases. All 310 tests across the four packages pass.

- `Supervisor — skill visibility events`:
  - emits `injected` for each selector pick
  - emits `promoted` + writes the audit row when SkillLifecycle promotes
  - `skill_generation = 'off'` short-circuits the generator (zero calls)
  - `'sampled'` calls the generator on every Nth success
- `SkillUsageStore`: `history()` returns rows chronologically with outcome
- `AuditLog`: `getByCommand` filters by command + optional action list

## Files changed

- `packages/loom-core/src/skills/SkillEvent.ts` (new)
- `packages/loom-core/src/skills/index.ts` (export)
- `packages/loom-core/src/types.ts` (policy fields)
- `packages/loom-core/src/orchestrator/Supervisor.ts` (events + audit + toggle)
- `packages/loom-core/src/state/AuditLog.ts` (getByCommand)
- `packages/loom-core/src/state/SkillUsageStore.ts` (history)
- `packages/loom-cli/src/commands/skills.ts` (runSkillsHistory)
- `packages/loom-cli/src/commands/run.ts` (printer wiring + off short-circuit)
- `packages/loom-cli/src/commands/init.ts` (yaml template)
- `packages/loom-cli/src/index.ts` (subcommand registration)
- `packages/loom-mcp/src/tools/handlers.ts` (toggle on MCP path)
- Tests: `Supervisor.test.ts`, `Skills.test.ts`, `State.test.ts`
