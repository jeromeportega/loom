# Eval Package Barrel Decentralization — Architecture

> Target: `packages/loom-core/src/eval/`. A pure structural refactor — promote the flat intake modules into a self-contained `eval/intake/` consumer with its own sub-barrel, demote `eval/index.ts` to a thin public-surface aggregator, and freeze the package-root export surface byte-for-byte. No symbol renamed, relocated from where callers reach it, or changed in behavior.

## Architecture Philosophy

Four constraints drive every decision below.

1. **The package-root surface is frozen and load-bearing.** `packages/loom-core/src/index.ts:12` does `export * from './eval/index.js'`. Whatever the eval top barrel re-exports *is* the package root surface, consumed by runner scripts, tests, and cross-package code. The refactor must preserve that surface symbol-for-symbol; correctness is measured against a captured baseline, not against intuition.

2. **Wildcards are unsafe at the top barrel; the seam must stay explicit.** The package root already exports an orchestrator `GateOutcome` (from `src/brief/gate.ts` via `brief/index.ts`). The eval framework defines a *distinct* generic `GateOutcome<T>`/`JudgeOutcome<T>` in `framework/types.ts`. A wildcard re-export of framework into the top barrel would pull those into the package root and collide. The top barrel therefore re-exports framework by **explicit named list**, deliberately omitting the colliding types. This is the invariant the current `eval/index.ts` already encodes (lines 50–68) and the refactor must keep.

3. **The architecture exists to let parallel agents not collide.** The entire motivation is structural: today an intake module reaches the package root only by appending an export line to the shared `eval/index.ts`. That edit is *incidental* — not a declared owned path — so the decomposer can't see it and parallel agents collide on it. The fix gives intake a directory it owns end-to-end, exactly as `framework/` and `brief-quality/` already have. After the change, "add an internal module" touches one consumer's files only.

4. **Boring symmetry over cleverness.** Three of the four consumers already demonstrate the target pattern (`wire internally via relative imports, expose one entry via index.ts`). We are not inventing a structure — we are extending a proven local convention to the one consumer that lacks it, and completing the one (`skill-judge/`) that has a directory but no barrel. No build tooling, no codemods, no new dependencies.

## Component Diagram

```mermaid
flowchart TB
  root["src/index.ts<br/>(package root)<br/>export * from eval/index.js"]
  briefIdx["src/brief/index.ts<br/>orchestrator GateOutcome<br/>(distinct, also at root)"]

  subgraph eval["eval/index.ts — thin aggregator (top barrel)"]
    direction TB
    note["• shared framework: EvalRunner, evaluateChecks,<br/>  loadEvalSuite, types.ts schemas<br/>• per-consumer surfaces (explicit, named)<br/>• NO flat intake re-exports<br/>• NO wildcard from framework (collision guard)"]
  end

  subgraph consumers["consumer sub-barrels (each: wire internally, expose one entry)"]
    direction LR
    fw["framework/index.ts<br/>(exists)"]
    bq["brief-quality/index.ts<br/>(exists)"]
    sj["skill-judge/index.ts<br/>(NEW — dir exists, barrel missing)"]
    intake["intake/index.ts<br/>(NEW — promoted from flat files)"]
  end

  subgraph intakeDir["eval/intake/ (NEW dir, owned by story-040-002)"]
    direction TB
    im["loadIntakeEvalSet · IntakeJudge · runIntakeEval<br/>scoreIntakeEval · refineEvalCases · runRefinedIntakeEval<br/>renderIntakeReport · recoverBriefText · intakeConsumer<br/>intakeEvalTypes  — wired by DIRECT relative imports"]
    tests["intake/__tests__/ (relocated)"]
  end

  scripts["scripts/eval-brief-quality.mjs<br/>scripts/eval-skill-judge.mjs"]

  root --> eval
  root -.distinct GateOutcome.-> briefIdx
  eval --> fw
  eval --> bq
  eval --> sj
  eval --> intake
  intake --> im
  fw --> intake
  scripts -.deep import dist/eval/{bq,sj}/run.js.-> bq
  scripts -.deep import.-> sj
```

## Tech Stack

No new technology is introduced. The table records the existing choices the refactor operates within, because each one constrains the design.

| Layer | Choice | Rationale |
|---|---|---|
| Language / modules | TypeScript, **NodeNext ESM** (`.js`-suffixed relative specifiers) | Existing. Every moved import keeps its `./IntakeJudge.js`-style specifier; relocation rewrites the path prefix, not the extension. |
| Public surface | **Barrel files** (`index.ts` re-exports) | Existing convention in 3 of 4 consumers; the refactor extends it, it does not replace it. |
| Collision control | **Explicit named re-exports** at the top barrel | The package root multiplexes orchestrator + eval symbols; `export *` from framework would collide `GateOutcome`. Boring, mechanical, reviewable. |
| Consumer internals | **Direct relative imports** between sibling modules | Intake modules already cross-import directly (`intakeConsumer.ts` → `./IntakeJudge.js`), never through the top barrel. Relocation preserves this; no module learns about the barrel. |
| Build | `tsc` → `dist/`, npm workspaces | Runner scripts deep-import compiled `dist/eval/<consumer>/run.js`. The `dist/` tree mirrors `src/`, so source moves are the only change. |
| Test runner | Existing eval test suites (`__tests__/`) | Tests move alongside their modules; suite stays green throughout — relocation + barrel-thinning land in one story so the build never breaks mid-flight. |
| Docs | MkDocs (`docs/architecture/gate-eval-framework.md`), capabilities drift check | The convention is documented; `docs/capabilities.md` is a no-op (no user-visible surface changes). |

## Data Models

The meaningful "data" here is the **module/barrel topology** and the **frozen export surface**. Both are contracts.

### Target directory layout (after refactor)

```
packages/loom-core/src/eval/
  index.ts                 # THIN: framework + per-consumer surfaces (explicit, named)
  EvalRunner.ts            # shared framework (unchanged)
  cases.ts                 # shared framework (unchanged)
  types.ts                 # shared framework schemas (unchanged)
  framework/
    index.ts               # export * (exists, unchanged)
    types.ts coreMetrics.ts decide.ts models.ts runGateEval.ts
  brief-quality/
    index.ts               # exists, unchanged
    run.ts ...             # deep-imported by scripts/eval-brief-quality.mjs
  skill-judge/
    index.ts               # NEW — add to satisfy "all four expose one entry"
    run.ts ...             # deep-imported by scripts/eval-skill-judge.mjs
  intake/                  # NEW directory
    index.ts               # NEW sub-barrel — intake's single public entry
    intakeEvalTypes.ts loadIntakeEvalSet.ts IntakeJudge.ts
    runIntakeEval.ts scoreIntakeEval.ts refineEvalCases.ts
    runRefinedIntakeEval.ts renderIntakeReport.ts recoverBriefText.ts
    intakeConsumer.ts
    __tests__/             # 11 relocated intake test files
```

### Frozen package-root surface (the baseline contract)

Every name below is importable from `@loom/loom-core` (via `eval/index.ts`) today and MUST remain so. This is the checklist story-040-001 captures and story-040-002 must satisfy.

```ts
// Shared framework (top-level eval files)
EvalRunner, evaluateChecks, loadEvalSuite
type EvalRunnerOptions
EvalCaseSchema, EvalSuiteSchema, PlanningExpectationSchema
type EvalCase, PlanningExpectation, EvalCheck, EvalCaseResult, EvalReport   // EvalReport from types.ts

// Intake surface (today flat files; after = re-exported through intake/index.ts)
type ClassifyResult, IntakeVerdict
IntakeEvalCaseSchema, IntakeEvalSetSchema, IntakeJudgeResultSchema
type IntakeEvalCase, IntakeEvalSet, IntakeJudgeResult, IntakeJudgeLike,
     IntakeRunRecord, ConfusionMatrix, AxisReport, IntakeEvalReport,
     RefinedCaseResult, DualIntakeReport
loadIntakeEvalSet
runIntakeEval, computeAxisAccuracy
type RunIntakeEvalDeps
refineEvalCases, runRefinedIntakeEval
IntakeJudge, computeJudgeVsHumanAgreement
scoreIntakeEval
type ScoreIntakeEvalMeta
renderIntakeReport, writeIntakeReportFiles, renderIntakeReportDual, writeIntakeReportDualFiles
createIntakeConsumer
type IntakeMetrics, IntakeConsumer

// Framework re-exports — EXPLICIT, named (collision guard)
type GateEvalCase, RunRecord, CoreMetrics, EvalThresholds, Decision,
     GateDeps, JudgeDeps, GateEvalConsumer
runGateEval, coreMetrics, decide
DEFAULT_JUDGE_MODEL, resolveEvalModels
//  GateOutcome<T> / JudgeOutcome<T> are deliberately NOT re-exported here.
```

### Colliding type shapes (why named exports are mandatory)

```ts
// framework/types.ts — generic, eval-internal
export type GateOutcome<TOut>  = { status:'ok'; output:TOut }   | { status:'failed'; detail:string };
export type JudgeOutcome<TJudg>= { status:'ok'; judgment:TJudg } | { status:'inconclusive'; detail:string } | { status:'skipped' };

// src/brief/gate.ts (reaches package root via brief/index.ts) — orchestrator's DISTINCT GateOutcome.
//   => eval/index.ts must NOT `export *` from framework, or the root has two GateOutcomes.

// types.ts            -> export interface EvalReport { ... }   // frozen at the root
// brief-quality/run.ts-> export interface EvalReport { ... }   // DIFFERENT shape, intentionally NOT at root
//   => brief-quality/index.ts re-exports its EvalReport by NAME, and the top barrel does not
//      re-export brief-quality at all (reached only via the runner's deep import into run.js).
```

## API / Interface Contracts

These are the seams parallel agents must agree on. They are signatures, not prose.

### Consumer sub-barrel convention (`<consumer>/index.ts`)

```ts
// framework/index.ts — exists, unchanged (safe: no name collides at the consumer level)
export * from './types.js';
export * from './runGateEval.js';
export * from './coreMetrics.js';
export * from './decide.js';
export * from './models.js';

// brief-quality/index.ts — exists, unchanged (named re-export dodges EvalReport collision)
export * from './caseSchema.js'; /* ...bands, loadCases, judgeTypes, runGate, judge, score, consumer */
export type { EvalReport, MainOptions } from './run.js';

// skill-judge/index.ts — NEW. Mirror brief-quality: `export *` the safe modules; if any name
//   collides with an existing root symbol, re-export it by name instead of widening.

// intake/index.ts — NEW. Re-exports exactly the frozen intake surface listed in Data Models,
//   sourced from the relocated sibling modules via `export ... from './<module>.js'`.
```

### Thin top barrel (`eval/index.ts`) shape, after refactor

```ts
// 1) shared framework files (unchanged lines)
export { EvalRunner, evaluateChecks } from './EvalRunner.js';
export type { EvalRunnerOptions } from './EvalRunner.js';
export { loadEvalSuite } from './cases.js';
export { EvalCaseSchema, EvalSuiteSchema, PlanningExpectationSchema } from './types.js';
export type { EvalCase, PlanningExpectation, EvalCheck, EvalCaseResult, EvalReport } from './types.js';

// 2) intake consumer surface — now ONE line group, sourced from the sub-barrel
export * from './intake/index.js';   // safe: intake names do not collide at the root (verified vs baseline)

// 3) framework re-exports — EXPLICIT named list, GateOutcome/JudgeOutcome omitted (unchanged policy)
export type { GateEvalCase, RunRecord, CoreMetrics, EvalThresholds, Decision,
              GateDeps, JudgeDeps, GateEvalConsumer } from './framework/types.js';
export { runGateEval } from './framework/runGateEval.js';
export { coreMetrics } from './framework/coreMetrics.js';
export { decide } from './framework/decide.js';
export { DEFAULT_JUDGE_MODEL, resolveEvalModels } from './framework/models.js';
```

> **Caveat on `export * from './intake/index.js'`:** this is only safe if no intake symbol collides with an existing root symbol. The current top barrel re-exports intake names individually precisely because some intake names (e.g. an intake `JudgeOutcome`) once collided. The implementer must diff the resolved root surface against the story-040-001 baseline; if any intake name collides, fall back to an explicit named re-export of the intake surface (still one confinable line group, still zero further edits for future intake modules because the *sub-barrel* absorbs them).

### Internal wiring contract (unchanged behavior)

```ts
// Intake modules cross-import each other DIRECTLY, never through any barrel. Example (post-move):
//   eval/intake/intakeConsumer.ts
import { IntakeJudge } from './IntakeJudge.js';
import { loadIntakeEvalSet } from './loadIntakeEvalSet.js';
import type { IntakeEvalCase, IntakeJudgeResult } from './intakeEvalTypes.js';
// Relocation keeps these specifiers identical (siblings move together); only the directory changes.
```

### External entry points (must not change)

```text
scripts/eval-brief-quality.mjs : import { main } from '../packages/loom-core/dist/eval/brief-quality/run.js'
scripts/eval-skill-judge.mjs   : import { main } from '../packages/loom-core/dist/eval/skill-judge/run.js'
```

These deep-import into `run.js`, *not* the package root. They are unaffected as long as `brief-quality/run.ts` and `skill-judge/run.ts` stay put — which they do.

## Security Model

This is a structural refactor; there is no runtime attack surface change. The relevant "threats" are regressions that silently degrade the system, plus the loom guardrail invariants the work must not touch.

| Threat | Control |
|---|---|
| **Surface drift** — a symbol silently dropped from the package root, breaking a downstream importer. | story-040-001 captures the byte-for-byte baseline (Data Models §2); story-040-002 diffs the post-refactor resolved root surface against it. `npm run build` across all workspaces fails closed on any missing export. |
| **Collision regression** — a wildcard re-introduces `GateOutcome`/`JudgeOutcome`/`EvalReport` into the package root. | Top barrel re-exports framework by explicit named list; `export *` is permitted only *inside* a consumer and only after diffing against the baseline (see caveat above). |
| **Silent deep-import breakage** — code importing a flat intake module by path (`dist/eval/runIntakeEval.js`) breaks on relocation. | Inventory (story-040-001) enumerates every deep importer. Confirmed scope: only `scripts/build-intake-fixture.mjs` references an intake module, and only via a "KEEP IN SYNC" comment, not an import. No live deep importer exists outside `src/eval/`. |
| **Coverage loss** — relocated tests silently stop running. | Intake tests move into `intake/__tests__/`; `npm run test` must stay green with coverage intact; the move is part of the same atomic story. |
| **Guardrail tampering** — NFR-2. | Policy engine and worktree isolation are out of scope and untouched; no file under the guardrail surface is owned by any story here. |

## ADR Log

### ADR-001 — Promote intake into `eval/intake/` rather than special-casing the top barrel
**Decision.** Give intake its own directory and `intake/index.ts` sub-barrel, identical in shape to `framework/` and `brief-quality/`.
**Context.** Intake is the only consumer with no home; each new intake module appends an export line to the shared `eval/index.ts`. That edit is incidental (undeclared by any story), invisible to the conflict-aware decomposer, and has caused the identical integration merge conflict in three gate-eval epics.
**Rationale.** A directory is a declared, ownable boundary. After the move, "add an internal intake module" edits only `intake/` files (FR-1, Goal 1: zero edits to `eval/index.ts`). The pattern is already proven by three siblings, so we extend convention rather than invent mechanism.
**Trade-off.** A one-time large diff (10 modules + 11 tests relocated) and a churn of import-path prefixes, accepted to remove a recurring structural collision permanently.

### ADR-002 — Thin top barrel re-exports framework by explicit named list, never by wildcard
**Decision.** `eval/index.ts` keeps enumerating framework symbols by name and continues to omit `GateOutcome<T>`/`JudgeOutcome<T>`.
**Context.** `src/index.ts` does `export * from './eval/index.js'`, and the package root also exports an orchestrator `GateOutcome` (from `brief/gate.ts`). The eval framework defines a distinct generic `GateOutcome<T>`.
**Rationale.** A wildcard from framework would surface two `GateOutcome` types at the package root — an ambiguous-export build error. Explicit naming is the existing, working policy (FR-5); we preserve it verbatim. Internal consumers that need the generics import them directly from `./framework/types.js`.
**Trade-off.** Adding a *new framework* symbol still requires one top-barrel edit. Accepted: framework is the shared core, not a parallel-story expansion point, so this is not the chokepoint we are eliminating.

### ADR-003 — Intake surface joins the top barrel via the sub-barrel, with a baseline-diff guard before using `export *`
**Decision.** Replace the ~25 individual intake re-export lines with the intake sub-barrel surface, preferring `export * from './intake/index.js'` but falling back to an explicit named re-export group if the baseline diff shows any intake name collides at the root.
**Context.** Some intake names have historically collided with orchestrator/framework names (the reason they were exported individually with a warning comment). The frozen-surface constraint (FR-4) is absolute.
**Rationale.** Routing through the sub-barrel means future intake modules are absorbed by `intake/index.ts` with zero top-barrel edits (Goal 1) regardless of which fallback is chosen. The baseline diff (ADR-005 / story-040-001) is the safety net that decides wildcard vs named.
**Trade-off.** If the named fallback is needed, the top barrel keeps a (one-time) explicit intake list — slightly less elegant, but still collision-free and still future-proof at the sub-barrel layer.

### ADR-004 — Add `skill-judge/index.ts`; do NOT promote brief-quality/skill-judge to the package root
**Decision.** Create the missing `skill-judge/index.ts` so all four consumers expose a single entry (FR-2). Resolve the PRD's open question in the negative: do **not** add the `brief-quality` or `skill-judge` public surfaces to the top barrel.
**Context.** `skill-judge/` has a directory but no barrel today. Neither `brief-quality` nor `skill-judge` is re-exported from `eval/index.ts`; both are reached only by their runner scripts deep-importing `run.js`. The PRD marks promotion as optional.
**Rationale.** The frozen-surface constraint forbids *removing* root surfaces but does not mandate *adding* new ones, and no consumer demands them. Promoting `brief-quality` via wildcard would surface its `EvalReport` (distinct from `types.ts` `EvalReport`) at the root — a fresh collision for no benefit. Keeping them off the root holds scope tight and risk near zero.
**Trade-off.** Mild asymmetry — four consumers have sub-barrels, but only `framework` + `intake` reach the package root. Accepted in favor of the frozen-surface guarantee; promotion remains a cheap, separately-justified follow-up if a real consumer ever needs it.

### ADR-005 — Land relocation, barrel-thinning, and test moves in one story; inventory first in a separate one
**Decision.** Split the work as the epic does: story-040-001 produces the deep-importer inventory and frozen-surface baseline (read-only); story-040-002 performs the move + thin + test relocation atomically; story-040-003 documents the convention.
**Context.** Relocating modules while the top barrel still re-exports their old paths would break the build mid-flight; capturing the surface baseline after edits would be circular.
**Rationale.** The baseline must exist *before* edits to be a valid oracle (FR-6, FR-4). The relocation and barrel-thinning are a single tightly-coupled region — they reference the same paths and must agree — so one owner edits them together; splitting them across agents would re-create the very collision this epic removes.
**Trade-off.** story-040-002 is a "large" single-owner story rather than several parallel ones. Accepted: file-boundary discipline says single-file-concentrated / tightly-coupled work belongs to one owner, and a transiently-broken build is a worse outcome than a larger diff.
