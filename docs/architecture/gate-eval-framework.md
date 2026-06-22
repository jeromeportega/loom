# Gate-Eval Framework

The gate-eval framework (`packages/loom-core/src/eval/framework/`) is a
plug-point core that decouples the eval loop mechanics from any particular AI
gate under test. A consumer wires up five plug points and the framework handles
case sequencing, the gate→judge handoff, the fail-closed structural checks, and
the final verdict.

## Why it exists

Loom evaluates multiple AI-backed gates — the brief-quality gate, the intake
classifier, and any gates added in future. Without a shared core, each eval
reimplements the same control flow: load cases, call the gate, call the judge (or
skip it on gate failure), tally metrics, decide. The duplication makes evals
diverge over time and makes the fail-closed semantics easy to get subtly wrong in
one consumer but not another. The framework centralises that control flow and
guarantees **≤1 gate call and ≤1 judge call per case**.

## The five plug points

A consumer implements `GateEvalConsumer<TCase, TOut, TJudg, TMetrics>` with five
methods and one property:

| # | Plug | Signature | Responsibility |
|---|---|---|---|
| 1 | **Load** | `loadCases(fixturePath?)` | Return the labeled case set. Should Zod-validate and return typed cases. |
| 2 | **Gate** | `runGate(c, deps)` | Call the system under test once. Map any throw to `{ status: 'failed', detail }`. |
| 3 | **Judge** | `judge(c, output, deps)` | Call the Opus judge once. Map any failure to `{ status: 'inconclusive', detail }`. Only called when the gate returned `'ok'`. |
| 4 | **Score** | `score(records)` | Call `coreMetrics(records)` and extend with consumer-specific axes. |
| 5 | **Thresholds** | `thresholds: EvalThresholds` | Structural health thresholds: `minScoredCases`, `maxGateFailureRate`, `maxJudgeInconclusiveRate`. |
| — | **Verdict** | `verdict(metrics)` | Consumer quality bar: `'proceed'` or `'do-not-proceed'`. Called only after all structural thresholds pass. |

## Control flow

```
loadCases()                          ← Plug 1
  for each case c:
    runGate(c, deps)                 ← Plug 2 — exactly 1 gate call
      if status='failed':
        judge = { status: 'skipped' }  (Plug 3 NOT called)
      if status='ok':
        judge(c, output, deps)         ← Plug 3 — exactly 1 judge call
          if throw → { status: 'inconclusive' }

score(records)                       ← Plug 4
decide(metrics, thresholds, verdict) ← Structural checks + Plug 5 (thresholds) + Plug 6 (verdict)
```

## Fail-closed decision (`decide.ts`)

The framework short-circuits to `'inconclusive'` before calling `verdict()` if any
structural threshold is breached:

1. `scoredCases < minScoredCases` — too few cases were both gated and judged
   successfully; the sample is too small to draw a conclusion.
2. `gateFailureRate > maxGateFailureRate` — the gate under test is unreliable;
   its scored subset would be a biased sample.
3. `judgeInconclusiveRate > maxJudgeInconclusiveRate` — the judge failed on too
   many cases; quality-bar measurement is compromised.

Only when all three pass does `decide()` delegate to `consumer.verdict(metrics)`.
This is the **fail-closed invariant**: a run where the infrastructure is
misbehaving never resolves to `'proceed'` — it resolves to `'inconclusive'`
and the operator re-runs or investigates.

## Model resolution

Two env vars override model selection for out-of-band runs:

| Env var | In-band default | Out-of-band default |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `modelFor(policy, 'planning')` | `claude-opus-4-8` |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | `claude-opus-4-8` |

In-band resolution goes through `framework/models.ts:resolveEvalModels(policy)`.
Out-of-band runner scripts read the env vars directly and fall back to Opus when
they are unset.

## Running the brief-quality eval (out-of-band)

The brief-quality eval measures how well `BriefRefiner` scores briefs against a
human-labeled case set. It is **not a `loom` subcommand** (ADR-006) — invoke it
directly after building `loom-core`:

```bash
npm run build -w @loom-ai/core
node scripts/eval-brief-quality.mjs
```

or via the workspace shortcut:

```bash
npm run eval:brief-quality
```

**Optional env-var overrides (defaults shown):**

```bash
LOOM_EVAL_GATE_MODEL=claude-opus-4-8   # model for BriefRefiner (the gate)
LOOM_EVAL_JUDGE_MODEL=claude-opus-4-8  # model for the Opus judge
```

To reduce cost while keeping the judge on Opus:

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:brief-quality
```

**Expected cost and runtime (9-case default fixture, NFR-3):**

Each of the 9 cases incurs **exactly one gate call** (BriefRefiner) and, when the
gate returns `ok`, **exactly one Opus judge call**. With both models defaulting to
`claude-opus-4-8` and the `claude-cli` session-based backend (the default), the run
has **no metered API cost** — it uses the operator's existing Claude session. With
an API key backend, budget for ≤18 Opus 4.8 calls (≤9 gate + ≤9 judge); wall-clock
time is typically **3–6 minutes** for 9 cases processed sequentially.

**Quality-band cuts (from `src/eval/brief-quality/bands.ts`, FR-11):**

Review these thresholds before each run — they define what the judge considers
"correct":

| Band | Score range | Meaning |
|---|---|---|
| `low` | 0–3 | Vague, missing key scope elements, not plan-ready |
| `mid` | 4–6 | Borderline — has structure but gaps need clarification |
| `high` | 7–10 | Well-scoped, testable criteria, ready to plan |

Band tolerance τ = 1: a `quality_score` of `s` agrees with expected band `[lo, hi]`
when `s ∈ [lo−1, hi+1]`. This absorbs natural scoring jitter at band edges without
masking systematic off-by-one errors.

**Pass/fail thresholds:**

The run resolves to `'proceed'` only when all of the following hold:

- ≥ 5 scored cases (both gate ok and judge ok)
- Gate failure rate ≤ 25%
- Judge inconclusive rate ≤ 25%
- Readiness accuracy ≥ 80%
- Quality-band agreement ≥ 70%
- Critique quality ≥ 60%

Output is written to `.loom/eval/brief-quality-report.{md,json}` (gitignored).

For a full operator runbook including what to record and how to interpret the verdict,
see [`docs/runbooks/brief-quality-eval.md`](../runbooks/brief-quality-eval.md).

## Per-consumer sub-barrel topology

Every eval consumer lives in its own directory under `src/eval/`, each
exposing exactly one public entry — an `index.ts` that the top barrel
(`eval/index.ts`) and external callers import from. Today there are four
directories:

| Directory | Role |
|---|---|
| `framework/` | Shared plug-point core — types, `runGateEval`, `coreMetrics`, `decide`, model resolution. Uses `export *` across its own modules internally; registered at the top barrel via explicit named list (see collision guard below). |
| `brief-quality/` | Brief-quality gate consumer. `index.ts` uses `export *` from safe modules and re-exports `EvalReport` and `MainOptions` from `run.ts` by explicit name to avoid collision with `eval/types.ts`'s `EvalReport`. Not re-exported at the package root (ADR-004). |
| `skill-judge/` | Skill-quality judge consumer. Same pattern as `brief-quality/`. Not re-exported at the package root (ADR-004). |
| `intake/` | Intake classifier consumer. Promoted from the flat `eval/` surface (epic-040). `index.ts` uses explicit named re-exports throughout; `JudgeOutcome` is intentionally omitted to avoid collision with `framework/types.ts`'s generic `JudgeOutcome<T>`. Re-exported at the package root via `export * from './intake/index.js'` (baseline diff confirmed no name collision). |

### Convention: wire internally, expose one entry

Inside any consumer directory, modules import each other by direct relative
path (`import { X } from './sibling.js'`), never through any barrel. The
`index.ts` is the only public door:

```
eval/
  intake/
    intakeConsumer.ts    ← imports { IntakeJudge } from './IntakeJudge.js'
    IntakeJudge.ts       ← imports { ... } from './intakeEvalTypes.js'
    intakeEvalTypes.ts
    index.ts             ← re-exports the consumer's public surface only
```

Callers outside `intake/` (including the top barrel and test files) import
only from `intake/index.ts`. This keeps internal helpers invisible to the
outside and makes the public surface explicit and auditable.

### Collision guard at the top barrel

Two pairs of names exist with structurally different shapes in eval vs. the
broader orchestrator surface:

- **`GateOutcome<T>` and `JudgeOutcome<T>`** — defined in `framework/types.ts`
  (generic, eval-internal). The orchestrator (`src/brief/gate.ts`) also exports
  a `GateOutcome` with a different shape. Both are **never re-exported** by
  `eval/index.ts`.
- **`EvalReport` in `brief-quality/run.ts` and `skill-judge/run.ts`** — each is
  structurally distinct from `EvalReport` in `eval/types.ts`. The consumer
  sub-barrels re-export it by explicit name (`export type { EvalReport } from './run.js'`);
  the top barrel does not re-export `brief-quality` or `skill-judge` at all
  (ADR-004), so neither consumer-local `EvalReport` ever reaches the package root.

The rule: **`eval/index.ts` re-exports framework by explicit named list only** —
`export *` from `./framework/*` is forbidden at the top barrel. `export *`
is permitted only *inside* a consumer sub-barrel, and from `./intake/index.js`
only because the story-040-001 baseline diff confirmed no intake name collides
at the package root.

### Adding a new consumer costs at most one top-barrel line

Because every consumer funnels its entire public surface through its own
`index.ts`, registering it at the package root is a single statement:

```typescript
// eval/index.ts — add at most one line:
export * from './my-consumer/index.js';            // no name collision at root
// or:
export { X, Y, Z } from './my-consumer/index.js'; // explicit group if any name collides
```

The blast radius of a new consumer is bounded to that one line.

## Adding a new consumer

1. Create a directory `src/eval/<name>/` for the consumer's modules. Implement
   `GateEvalConsumer<TCase, TOut, TJudg, TMetrics>` in `src/eval/<name>/consumer.ts`.
2. Define your case schema (structurally extending `GateEvalCase` — must have
   `id: string` and `source: string`) and a YAML fixture file.
3. Wire the plug points: `loadCases` → fixture loader, `runGate` → your gate,
   `judge` → your Opus judge, `score` → `coreMetrics()` extended with your axes,
   `verdict` → your quality bar.
4. Call the framework loop:
   ```typescript
   const records  = await runGateEval(cases, consumer, deps);
   const metrics  = consumer.score(records);
   const decision = decide(metrics, consumer.thresholds, m => consumer.verdict(m));
   ```
5. Create `src/eval/<name>/index.ts` that re-exports the consumer's public
   surface. If any exported name collides with the frozen root surface (check
   against `.loom/planning/epic-040/surface-baseline.md`), re-export it by
   explicit name instead of `export *`. Wire internal cross-module imports by
   direct relative path only — never through any barrel.
6. Register the consumer at the top barrel with at most one line in
   `eval/index.ts` (see "Adding a new consumer costs at most one top-barrel line"
   above).
7. Add a `scripts/eval-<name>.mjs` runner and a `npm run eval:<name>` script.
8. Document the run steps and expected cost/runtime in `docs/runbooks/`.

The brief-quality consumer (`src/eval/brief-quality/`) and the intake consumer
(`src/eval/intake/`) are the two reference implementations.
