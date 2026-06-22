# Epic-040 Baseline: Deep-Importer Inventory + Frozen Package-Root Surface

Produced by story-040-001. **Read-only artifact — captured BEFORE any source edit.**
Used by story-040-002 as the diff oracle after the intake relocation.

---

## Part 1 — Deep-Importer Inventory

### Search scope

Grep command used (run from repo root):

```sh
grep -rn --include="*.ts" --include="*.js" --include="*.mjs" --include="*.cjs" \
  -E "from ['\"].*eval/(runIntakeEval|IntakeJudge|loadIntakeEvalSet|scoreIntakeEval|refineEvalCases|runRefinedIntakeEval|renderIntakeReport|recoverBriefText|intakeConsumer|intakeEvalTypes)" \
  . | grep -v node_modules | sort
```

Modules searched: `runIntakeEval`, `IntakeJudge`, `loadIntakeEvalSet`, `scoreIntakeEval`,
`refineEvalCases`, `runRefinedIntakeEval`, `renderIntakeReport`, `recoverBriefText`,
`intakeConsumer`, `intakeEvalTypes` — in both `dist/eval/<module>.js` and `src/eval/<module>` forms.

---

### Hit list

#### Group A — Internal siblings (inside `src/eval/`): EXPECTED, NOT relocation breakers

These 11 unit-test files live inside `packages/loom-core/src/eval/__tests__/` and import
their subjects via `'../<module>.js'`. They will be relocated to `src/eval/intake/__tests__/`
by story-040-002 as part of the move. The relative paths remain stable after relocation.

| File | Imported module(s) |
|---|---|
| `packages/loom-core/src/eval/__tests__/intakeConsumer.test.ts` | `../intakeConsumer.js`, `../intakeEvalTypes.js` |
| `packages/loom-core/src/eval/__tests__/intakeFragmentRewrite.test.ts` | `../loadIntakeEvalSet.js` |
| `packages/loom-core/src/eval/__tests__/IntakeJudge.test.ts` | `../IntakeJudge.js` |
| `packages/loom-core/src/eval/__tests__/loadIntakeEvalSet.test.ts` | `../loadIntakeEvalSet.js` |
| `packages/loom-core/src/eval/__tests__/recoverBriefText.test.ts` | `../recoverBriefText.js`, `../intakeEvalTypes.js` |
| `packages/loom-core/src/eval/__tests__/refineEvalCases.test.ts` | `../refineEvalCases.js`, `../intakeEvalTypes.js` |
| `packages/loom-core/src/eval/__tests__/renderIntakeReport.test.ts` | `../renderIntakeReport.js`, `../scoreIntakeEval.js` |
| `packages/loom-core/src/eval/__tests__/renderIntakeReportDual.test.ts` | `../renderIntakeReport.js`, `../scoreIntakeEval.js` |
| `packages/loom-core/src/eval/__tests__/runIntakeEval.test.ts` | `../runIntakeEval.js` |
| `packages/loom-core/src/eval/__tests__/runRefinedIntakeEval.test.ts` | `../runRefinedIntakeEval.js`, `../scoreIntakeEval.js` |
| `packages/loom-core/src/eval/__tests__/scoreIntakeEval.test.ts` | `../scoreIntakeEval.js` |

Also: the flat intake modules import each other via `'./sibling.js'` relative paths within
`src/eval/`. These intra-group cross-imports are expected and are moved together by 040-002.

---

#### Group B — External test file: **LIVE DEEP IMPORTER — RELOCATION BREAKER**

```
packages/loom-core/test/eval/evalHarnessIsolation.test.ts
```

This file is **outside `src/eval/`** and is **not** one of the two known runner scripts.
It hard-codes flat `src/eval/` paths for three intake modules:

```ts
// Line 6
import { loadIntakeEvalSet } from '../../src/eval/loadIntakeEvalSet.js';
// Line 7
import { runIntakeEval } from '../../src/eval/runIntakeEval.js';
// Line 8
import { scoreIntakeEval } from '../../src/eval/scoreIntakeEval.js';
```

**Impact:** These imports will break when story-040-002 moves the intake modules to
`src/eval/intake/`. Story-040-002 must update these three lines to:

```ts
import { loadIntakeEvalSet } from '../../src/eval/intake/loadIntakeEvalSet.js';
import { runIntakeEval } from '../../src/eval/intake/runIntakeEval.js';
import { scoreIntakeEval } from '../../src/eval/intake/scoreIntakeEval.js';
```

---

#### Group C — Runner scripts with `run.js` deep-imports: NOT intake deep-importers

Both scripts deep-import a `run.js` entry point, NOT any flat intake module.

| Script | Actual deep import |
|---|---|
| `scripts/eval-brief-quality.mjs` | `../packages/loom-core/dist/eval/brief-quality/run.js` |
| `scripts/eval-skill-judge.mjs` | `../packages/loom-core/dist/eval/skill-judge/run.js` |

Neither references any of the 10 intake module names. These paths are frozen by
Contract 5 and are NOT affected by the intake relocation.

---

#### Group D — KEEP-IN-SYNC comment in `build-intake-fixture.mjs`: NOT a live import

```
scripts/build-intake-fixture.mjs  line 28:
  // KEEP IN SYNC WITH packages/loom-core/src/eval/recoverBriefText.ts —
```

This is a code comment, not an `import` or `require`. It describes an intentional
inline bootstrap copy of `recoverBriefText` logic maintained manually. It is **not a
relocation breaker** — the comment string has no runtime effect and requires only a
manual text update to the comment itself if the source path changes.

---

#### Group E — Package-root importer: NOT a deep importer

```
scripts/eval-intake.mjs
```

Imports all intake symbols via the package root:

```js
import { loadIntakeEvalSet, runIntakeEval, ... } from '../packages/loom-core/dist/index.js';
```

This is the correct public API surface. Unaffected by the intake relocation so long as
the package root continues to re-export the intake surface (which the frozen surface
below guarantees).

---

### Summary

| Category | Files | Relocation breaker? |
|---|---|---|
| Flat `src/eval/__tests__/` siblings (11 files) | Group A | No — moved with modules |
| `test/eval/evalHarnessIsolation.test.ts` | Group B | **YES — 3 paths must be updated** |
| Runner scripts (`brief-quality`, `skill-judge`) | Group C | No — import `run.js`, not intake |
| `build-intake-fixture.mjs` KEEP-IN-SYNC comment | Group D | No — comment, not import |
| `scripts/eval-intake.mjs` | Group E | No — uses package root |

**Conclusion:** Exactly one file outside `src/eval/` contains live deep imports of intake
modules: `packages/loom-core/test/eval/evalHarnessIsolation.test.ts`. Story-040-002 must
update its three import paths as the sole relocation-repair obligation outside the move itself.

---

## Part 2 — Frozen Package-Root Surface (Intake + Framework via `eval/index.ts`)

Captured from `packages/loom-core/src/eval/index.ts` before any edit.
Every name below is re-exported via `src/index.ts → export * from './eval/index.js'`
and therefore importable from the package root (`@loom-ai/core`).

Value-export presence was verified at runtime against `dist/index.js` on 2026-06-21
(all 27 value exports confirmed present). Type-export presence was verified against
`dist/eval/index.d.ts` (all 22 type-only exports confirmed present via explicit
`export type { ... }` statements).

### Frozen surface — sorted by category

#### Framework top-level (eval/EvalRunner.ts, eval/cases.ts, eval/types.ts)

```ts
// Values
EvalRunner
evaluateChecks
loadEvalSuite
EvalCaseSchema
EvalSuiteSchema
PlanningExpectationSchema

// Types
EvalRunnerOptions
EvalCase
PlanningExpectation
EvalCheck
EvalCaseResult
EvalReport          // sourced from eval/types.ts
```

#### Intake surface (today flat eval/*.ts; after 040-002 = eval/intake/*.ts)

```ts
// Values
IntakeEvalCaseSchema
IntakeEvalSetSchema
IntakeJudgeResultSchema
loadIntakeEvalSet
runIntakeEval
computeAxisAccuracy
refineEvalCases
runRefinedIntakeEval
IntakeJudge
computeJudgeVsHumanAgreement
scoreIntakeEval
renderIntakeReport
writeIntakeReportFiles
renderIntakeReportDual
writeIntakeReportDualFiles
createIntakeConsumer

// Types
ClassifyResult
IntakeVerdict
IntakeEvalCase
IntakeEvalSet
IntakeJudgeResult
IntakeJudgeLike
IntakeRunRecord
ConfusionMatrix
AxisReport
IntakeEvalReport
RefinedCaseResult
DualIntakeReport
RunIntakeEvalDeps
ScoreIntakeEvalMeta
IntakeMetrics
IntakeConsumer
```

#### Framework re-exports (eval/framework/*.ts — explicit named list, no wildcard)

```ts
// Values
runGateEval
coreMetrics
decide
DEFAULT_JUDGE_MODEL
resolveEvalModels

// Types
GateEvalCase
RunRecord
CoreMetrics
EvalThresholds
Decision
GateDeps
JudgeDeps
GateEvalConsumer
```

#### Deliberately NOT at the package root

The following names exist in framework internal files but are **excluded** from `eval/index.ts`
to prevent collision with orchestrator types exported from `src/index.ts`:

```ts
// framework/types.ts — eval-internal generics, NEVER re-exported by eval/index.ts
GateOutcome<T>    // conflicts with brief/gate.ts GateOutcome at root
JudgeOutcome<T>   // conflicts at root

// brief-quality/run.ts — its own EvalReport, different shape from eval/types.ts EvalReport
EvalReport (brief-quality variant)
```

---

### Machine-checkable sorted name list

Alphabetically sorted union of all value exports + type-only exports through `eval/index.ts`.
This is the diff oracle for story-040-002 post-refactor surface check.

```
AxisReport
ClassifyResult
computeAxisAccuracy
computeJudgeVsHumanAgreement
ConfusionMatrix
coreMetrics
CoreMetrics
createIntakeConsumer
decide
Decision
DEFAULT_JUDGE_MODEL
DualIntakeReport
EvalCase
EvalCaseResult
EvalCaseSchema
EvalCheck
EvalReport
EvalRunner
EvalRunnerOptions
EvalSuiteSchema
EvalThresholds
evaluateChecks
GateDeps
GateEvalCase
GateEvalConsumer
IntakeConsumer
IntakeEvalCase
IntakeEvalCaseSchema
IntakeEvalReport
IntakeEvalSet
IntakeEvalSetSchema
IntakeJudge
IntakeJudgeLike
IntakeJudgeResult
IntakeJudgeResultSchema
IntakeMetrics
IntakeRunRecord
IntakeVerdict
JudgeDeps
loadEvalSuite
loadIntakeEvalSet
PlanningExpectation
PlanningExpectationSchema
refineEvalCases
RefinedCaseResult
renderIntakeReport
renderIntakeReportDual
resolveEvalModels
runGateEval
runIntakeEval
runRefinedIntakeEval
RunIntakeEvalDeps
RunRecord
scoreIntakeEval
ScoreIntakeEvalMeta
writeIntakeReportDualFiles
writeIntakeReportFiles
```

Total: 57 names (27 values + 30 type-only — types erased at runtime but present in .d.ts).

Story-040-002 must produce the identical sorted list from the post-refactor
`dist/eval/index.d.ts` re-exports. Any addition, deletion, or rename is a surface break.
