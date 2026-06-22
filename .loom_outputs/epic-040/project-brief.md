I'll quickly ground myself in the actual eval package structure so the brief is evidence-based rather than speculative, then produce the document.I'll use the dedicated tools instead.# Eval Package Barrel Decentralization — Per-Consumer Sub-Barrels

## The Problem

Adding any eval module to `packages/loom-core/src/eval/` forces an edit to one shared file. The top-level barrel `packages/loom-core/src/eval/index.ts` (69 lines today) re-exports every intake module by name — `loadIntakeEvalSet`, `runIntakeEval`, `IntakeJudge`, `scoreIntakeEval`, `renderIntakeReport`, `intakeConsumer`, and the `intakeEvalTypes` symbols — because those modules live flat at the eval root with no home directory of their own. Every new intake module must append its export here.

That single chokepoint serializes parallel work **by construction**. Three gate-eval epics hit the identical integration merge conflict: two stories each appended their module's export to this barrel, and the conflict-aware decomposition never flagged the collision because the barrel edit is *incidental* — it is not a declared owned path of either story. The root cause is a central-registry pattern, not a one-off mistake: as long as one file is mandatory editing for new modules, conflict-free parallel decomposition is impossible regardless of how carefully stories are scoped.

The asymmetry that makes this fixable: three of the four consumers — `framework/`, `brief-quality/`, `skill-judge/` — already have their own directories and sub-barrels (`<consumer>/index.ts`). Only the **intake** consumer lacks one, so only intake's modules sprawl into the top barrel. The pattern to generalize already exists in-repo.

## Target Users

- **Primary — parallel story agents building evals.** Today two agents writing independent intake modules collide on `eval/index.ts`. After this change, each works inside its consumer's own directory and never touches a shared file.
- **Secondary — the conflict-aware decomposer.** It can only reason about *declared owned paths*. Confining cross-consumer wiring to a single, predictable line lets it schedule a new consumer as one isolated wiring step instead of an invisible shared-file hazard.
- **Downstream importers (must remain unaffected).** `packages/loom-core/src/index.ts:12` does `export * from './eval/index.js'`, so the eval barrel feeds the entire package root; runner scripts (`scripts/eval-brief-quality.mjs`, `scripts/eval-skill-judge.mjs`) deep-import `dist/eval/<consumer>/run.js`; tests and cross-package code import from the package root. None of these may change.
- **Anti-persona:** anyone seeking a behavior change, new eval logic, or API cleanup. This is a structural refactor only — no symbol renamed, removed, or relocated from where callers reach it today.

## Proposed Solution

Give every eval consumer the structure three of them already have, and demote the top barrel to a thin public-surface aggregator.

1. **Self-contained consumer directories.** Each consumer's case loader, judge, scorer, and runner wire each other via **direct relative imports** — never through the top barrel. (`framework/`, `brief-quality/`, `skill-judge/` already do this.)
2. **Promote intake into its own consumer directory** with its own sub-barrel, matching the established pattern, so its modules stop living flat at the eval root.
3. **Each consumer exposes one public entry** via its own `<consumer>/index.ts`. Sub-barrels may use `export *` internally; the convention is *wire internally, expose one entry*.
4. **Thin top barrel.** `eval/index.ts` re-exports only the shared framework plus each consumer's public surface — with **explicit, named** re-exports where collision avoidance requires it (see Constraints), never a wildcard that re-pulls colliding orchestrator types.

The target property: (a) adding an internal module to a consumer edits only that consumer's own files; (b) adding a *new* consumer adds at most one small re-export line to the top barrel — a single confinable wiring step, not work spread across parallel stories.

## Key Capabilities

1. Intake eval becomes a self-contained consumer directory with its own sub-barrel, wired by direct internal imports.
2. All four consumers (framework, brief-quality, skill-judge, intake) expose their public surface through a per-consumer `index.ts`.
3. The top-level `eval/index.ts` re-exports only framework + consumer public surfaces, preserving every symbol currently importable from the package root, byte-for-byte at the call site.
4. Collision-avoidance for orchestrator types (e.g. `GateOutcome`, `JudgeOutcome<T>`) is preserved via explicit named exports; no wildcard re-introduces the collision.
5. Adding an internal module touches only its consumer; adding a new consumer is a single top-barrel line.
6. Eval architecture docs (`docs/architecture/gate-eval-framework.md`) describe the sub-barrel structure and the wire-internally-expose-one-entry convention.

## Constraints

- **No behavior change.** Pure structural refactor; no eval logic altered.
- **Package-root surface frozen.** Every symbol currently exported from the eval package root (via `eval/index.ts` → `src/index.ts`) must remain importable from the same place. Confirmed root surface today: `EvalRunner`/`evaluateChecks`/`loadEvalSuite`/the `types.ts` schemas, the full intake surface, the intake consumer, and the framework's selected types + `runGateEval`/`coreMetrics`/`decide`/`resolveEvalModels`.
- **Preserve collision avoidance.** Because `src/index.ts` wildcards the eval barrel into the package root alongside the orchestrator's `GateOutcome`, the barrel must keep its explicit, named exports and must NOT re-introduce a wildcard that re-exports `GateOutcome`/`JudgeOutcome<T>`.
- **No weakened guardrails.** Policy engine and worktree isolation untouched.
- **All existing eval test suites, the full build, and the full test suite stay green.**
- **Docs + drift.** Update the eval architecture doc; pass the `docs/capabilities.md` drift check (expected no-op — no user-visible surface changes).

## Risks and Open Questions

- **Top-barrel scope for brief-quality / skill-judge.** Today these are *not* re-exported from the top barrel at all — runner scripts deep-import `dist/eval/<consumer>/run.js`. The stated property "a new consumer adds one re-export line" implies all consumers surface at the top. **Open question for the PM/Architect:** does this refactor promote brief-quality and skill-judge public surfaces to the top barrel for uniformity, or only formalize the convention while leaving them deep-import-only? `[ASSUMPTION]` The frozen-surface constraint takes precedence — do not *remove* any current root export; promoting additional surfaces is optional and should be an explicit, separately-justified choice.
- **Duplicate type names across consumers.** `brief-quality/index.ts` already exports an `EvalReport` distinct from the root `types.ts` `EvalReport`. `[ASSUMPTION]` Routing any consumer through a top-barrel wildcard would collide these — reinforcing that the top barrel must stay explicit/named.
- **Intake relocation breaks deep imports.** Moving flat intake modules into an `intake/` directory changes their physical paths. Any code deep-importing `dist/eval/<intakeModule>.js` directly (rather than via the package root) would break. **Must inventory deep importers of intake modules before moving.**
- **Test-path churn.** Intake tests live in `eval/__tests__/`; relocating modules likely moves these into `intake/__tests__/`. Mechanical but must keep the suite green and coverage intact.
- `[ASSUMPTION]` No external (out-of-repo) consumer imports eval internals by deep path; only the package root and the two known runner scripts are external entry points.

## Success Criteria

- [ ] Each of framework, brief-quality, skill-judge, and **intake** is a self-contained directory wiring its own modules via direct internal imports and exposing its public surface through its own `index.ts`.
- [ ] `eval/index.ts` re-exports only the shared framework plus consumer public surfaces; **every symbol importable from the eval package root before the change is importable from the same place after**, with no call-site changes in runner scripts, tests, or cross-package imports.
- [ ] The orchestrator collision-avoidance exports are preserved; no wildcard re-introduces `GateOutcome`/`JudgeOutcome<T>` at the package root.
- [ ] Demonstrable: adding an internal module to a consumer requires editing only that consumer's files (no top-barrel edit); adding a new consumer requires at most one top-barrel re-export line.
- [ ] `npm run build` and `npm run test` pass; all existing eval suites green; no behavior change.
- [ ] `docs/architecture/gate-eval-framework.md` documents the sub-barrel structure and the wire-internally-expose-one-entry convention; capabilities drift check passes.
