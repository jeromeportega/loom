# Eval Package Barrel Decentralization — Per-Consumer Sub-Barrels

## Overview

The top-level eval barrel `packages/loom-core/src/eval/index.ts` is a central-registry chokepoint: every new intake module must append its export there, because the intake consumer alone — unlike `framework/`, `brief-quality/`, and `skill-judge/` — has no directory or sub-barrel of its own. This shared-file edit is *incidental* (not a declared owned path of any story), so the conflict-aware decomposer cannot see it, and parallel story agents collide on it by construction; three gate-eval epics have already hit the identical integration merge conflict. This is a pure structural refactor that gives intake the self-contained directory structure the other three consumers already have, demotes the top barrel to a thin public-surface aggregator, and preserves the package-root export surface byte-for-byte at every call site. No symbol is renamed, removed, relocated from where callers reach it, or changed in behavior.

## Goals

1. **Eliminate the shared-barrel chokepoint for module additions.** Success metric: adding an internal module to any consumer requires editing only that consumer's own files — **zero** edits to `eval/index.ts`.
2. **Reduce new-consumer wiring to one confinable step.** Success metric: adding a *new* consumer adds **at most one** re-export line to the top barrel.
3. **Freeze the package-root surface.** Success metric: every symbol importable from the eval package root before the change is importable from the same place after — **zero** call-site changes in runner scripts, tests, or cross-package imports.
4. **Ship with no behavior change.** Success metric: `npm run build` and `npm run test` pass, all existing eval suites green, no eval logic altered.

## User Stories

- **As a parallel story agent building an intake eval**, I want to work entirely inside my consumer's directory, so that I never touch a shared file and never collide with another agent on `eval/index.ts`. *(Must)*
- **As the conflict-aware decomposer**, I want cross-consumer wiring confined to a single predictable line, so that I can schedule a new consumer as one isolated, declared-owned wiring step instead of an invisible shared-file hazard. *(Must)*
- **As a downstream importer** (package root, runner scripts, tests, cross-package code), I want every symbol to remain importable from its current location, so that my code does not change. *(Must)*

## Functional Requirements

- **FR-1** — Promote the intake consumer into its own `eval/intake/` directory with its own sub-barrel `intake/index.ts`; its case loader, judge, scorer, runner, and types are wired to each other via **direct relative imports**, never through the top barrel.
- **FR-2** — All four consumers (`framework`, `brief-quality`, `skill-judge`, `intake`) expose their public surface through a single per-consumer `index.ts` (`export *` permitted internally — the convention is *wire internally, expose one entry*).
- **FR-3** — `eval/index.ts` re-exports only the shared framework plus each consumer's public surface; it contains no flat intake-module re-exports.
- **FR-4** — Every symbol currently importable from the eval package root remains importable from the same place — confirmed surface: `EvalRunner` / `evaluateChecks` / `loadEvalSuite` / the `types.ts` schemas, the full intake surface, the intake consumer, and the framework's selected types plus `runGateEval` / `coreMetrics` / `decide` / `resolveEvalModels`.
- **FR-5** — Orchestrator collision-avoidance is preserved via **explicit, named** re-exports (e.g. `GateOutcome`, `JudgeOutcome<T>`); no wildcard in the top barrel re-introduces those colliding types into the package root.
- **FR-6** — Inventory every deep importer of intake modules (`dist/eval/<intakeModule>.js`) before relocation; move the intake test files alongside their modules (e.g. into `intake/__tests__/`) while keeping the suite green and coverage intact.
- **FR-7** — Update `docs/architecture/gate-eval-framework.md` to document the sub-barrel structure and the wire-internally-expose-one-entry convention; the `docs/capabilities.md` drift check passes (expected no-op).

## Non-Functional Requirements

- **NFR-1** — No behavior change: pure structural refactor, no eval logic altered.
- **NFR-2** — Guardrails untouched: policy engine and worktree isolation are not modified.
- **NFR-3** — The full build and full test suite stay green, not only the eval suites.

## Epics

This PRD is a single cohesive structural refactor confined to one package — **one epic**:

- **Epic 1 — Decentralize the eval barrel into per-consumer sub-barrels.** Promote intake to its own directory, give all four consumers a single public entry, thin the top barrel to a framework + consumer-surface aggregator with explicit collision-avoidance exports, relocate intake tests, and update the architecture doc.

## Out of Scope

- Any behavior change, new eval logic, or eval API cleanup.
- Renaming, removing, or relocating any symbol from where callers reach it today.
- Removing any current package-root export. **[ASSUMPTION]** Promoting the `brief-quality` and `skill-judge` public surfaces to the top barrel for uniformity is *optional* and is **not** undertaken here unless separately justified — the frozen-surface constraint takes precedence and forbids *removing* surfaces, but does not mandate *adding* new ones. (Open question flagged for the Architect.)
- Routing any consumer through a top-barrel wildcard (would collide duplicate type names such as the distinct `EvalReport` in `brief-quality/index.ts` vs. `types.ts`).
- Changes to external (out-of-repo) consumers. **[ASSUMPTION]** Only the package root and the two known runner scripts (`scripts/eval-brief-quality.mjs`, `scripts/eval-skill-judge.mjs`) are external entry points.
