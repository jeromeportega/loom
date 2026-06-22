I'll ground this architecture in the actual gate-eval framework. Let me explore the existing consumers and the production lesson extractor before writing.Let me verify the top-barrel wiring and exact shared-type shapes directly — these are load-bearing for the architecture and the explorers disagreed slightly on the top barrel.Let me pin down the consumer entrypoint contract and the reference thresholds for calibration.# Architecture — Lesson-Extractor Rubric Eval Consumer (epic-041)

## Architecture Philosophy

This is an additive consumer on a framework that already exists. The whole job is to plug a sixth consumer into the gate-eval harness at `packages/loom-core/src/eval/` and to change nothing else. Four constraints drive every decision below.

1. **Reuse the framework verbatim; reimplement nothing.** The case loader → gate runner → LLM-as-judge → scorer → fail-closed `decide()` pipeline is built and tested (`packages/loom-core/src/eval/framework/`). We supply the six `GateEvalConsumer` plug points and nothing more. The trade-off we accept: the new consumer is constrained to the framework's exact seams (`GateOutcome`, `JudgeOutcome`, `RunRecord`, `CoreMetrics`, `Decision`) even where a bespoke shape would read more naturally.

2. **Observe-only against the *production* extractor.** The gate under eval is the real `LessonExtractor` class (`packages/loom-core/src/findings/LessonExtractor.ts`), imported and called — never copied, never modified. The eval reads production behavior; it does not steer it. Trade-off: the eval is coupled to the production constructor and `EpicTelemetry`/`Lesson` shapes, so a production change can break the eval build — which is the point of an eval, not a defect.

3. **Rubric scoring, not label-matching.** Unlike the classifier/brief-quality/skill-judge consumers, there is no single correct lesson set. The judge scores extracted lessons against *rubric expectations* — expected themes plus over-extraction traps — and the scorer reduces those to faithfulness/usefulness/coverage plus a hallucination rate. Trade-off: the judge is itself a non-deterministic LLM; we buy determinism in CI with mocked-LLM unit tests and defer real-model stability validation to the operator (explicitly out of scope for v1).

4. **Fail-closed, and stay inside the convention.** A metric below bar, or a missing one, defaults to a non-`proceed` verdict. The consumer lives in its own `lesson-extractor/` directory with one sub-barrel and a single public entry, wired by direct imports — matching brief-quality/skill-judge exactly. Trade-off: we hold the top barrel (`src/eval/index.ts`) at **zero** new lines rather than spend the one line the PRD permits (see ADR-001).

## Component Diagram

```mermaid
flowchart TD
  OP([Eval operator]) -->|npm run eval:lesson-extractor| SCRIPT[scripts/eval-lesson-extractor.mjs]
  SCRIPT -->|imports dist/eval/lesson-extractor/run.js| MAIN["main(opts): Promise&lt;EvalReport&gt;"]

  subgraph CONSUMER["src/eval/lesson-extractor/ (new — this epic)"]
    MAIN --> LOAD["loadLessonExtractorCases()"]
    MAIN --> CFAC["createLessonExtractorConsumer()"]
    LOAD -->|reads| FIX[("eval-cases/\nlesson-extractor.yaml")]
    CFAC --> RUNG["runLessonExtractorGate()"]
    CFAC --> JUDGE["judgeLessonExtraction()"]
    CFAC --> SCORE["scoreLessonExtractor()\n+ verdict + thresholds"]
  end

  subgraph FW["src/eval/framework/ (reused, unchanged)"]
    RGE["runGateEval()"]
    DEC["decide()"]
    CM["coreMetrics()"]
    MOD["resolveEvalModels()"]
  end

  MAIN --> RGE
  RGE -->|1 call/case, gateModel| RUNG
  RGE -->|gate ok → 1 call/case, judgeModel| JUDGE
  RUNG -->|new LessonExtractor().extract| EXT[["LessonExtractor\n(src/findings — PRODUCTION, read-only)"]]
  EXT -->|reads| SKILL[("lesson-extractor\nSKILL.md (production prompt)")]
  RGE --> RECS["RunRecord[]"]
  RECS --> SCORE
  SCORE --> CM
  SCORE --> DEC
  DEC --> REPORT["EvalReport\n{ metrics, decision, perCase, markdown }"]
  REPORT -->|writes| OUT[(".loom/eval/\nlesson-extractor-report.{md,json}")]

  MAIN -.->|gateModel / judgeModel envs| MOD
  classDef prod fill:#fde,stroke:#c39
  classDef reuse fill:#def,stroke:#39c
  class EXT,SKILL prod
  class RGE,DEC,CM,MOD reuse
```

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language / runtime | TypeScript on Node 20+ (ESM, `.js` import specifiers) | Matches the package; the framework already compiles this way. |
| Eval framework | `src/eval/framework` (`runGateEval`, `decide`, `coreMetrics`, `resolveEvalModels`) | NFR-2: reuse, don't reimplement. These are the load-bearing seams. |
| Gate under eval | Production `LessonExtractor` (`src/findings/LessonExtractor.ts`) | FR-4 / NFR-1: drive the real extractor, observe-only. |
| Fixture format | YAML at `packages/loom-core/eval-cases/lesson-extractor.yaml` | Mirrors `eval-cases/brief-quality.yaml` and `skill-judge.yaml`; one loader pattern across consumers. |
| Schema validation | `zod` | Every consumer validates its case set with zod at load; reuse the pattern, get fail-fast fixtures. |
| LLM access | `LLMClient` interface; `MockLLMClient` in tests | Production extractor and judge both take an injected client; tests script responses, never call a real model (NFR-3). |
| Test runner | The package's existing test setup | NFR-4: full suite must pass; no new test infra. |
| Operator entry | `scripts/eval-lesson-extractor.mjs` + root `package.json` script `eval:lesson-extractor` | FR-8: consistent with `eval-brief-quality.mjs` / `eval-skill-judge.mjs`. |
| Model selection | `LOOM_EVAL_GATE_MODEL`, `LOOM_EVAL_JUDGE_MODEL` env vars | FR-7: same knobs as every other consumer, via `resolveEvalModels` / per-script defaults. |
| Docs | `docs/runbooks/lesson-extractor-eval.md` + update `docs/architecture/gate-eval-framework.md` and `docs/capabilities.md` | FR-8 + repo invariant: a new user-visible surface updates the capabilities page. |

## Data Models

All new types live under `src/eval/lesson-extractor/`. They are typed against the framework's `GateEvalCase`/`CoreMetrics` and the production `EpicTelemetry`/`Lesson` shapes — the eval does not invent its own copies of those.

### Case set (fixture → loaded case) — `caseSchema.ts`

The case carries the *input* (`telemetry`, hand-authored synthetic) and the *rubric* (themes + traps). It does **not** carry an expected lesson set — that is the deliberate departure (ADR-004).

```ts
import { z } from 'zod';

// Mirrors production EpicTelemetry (src/findings/LessonExtractor.ts) so
// LessonExtractor.extract() accepts the fixture unchanged. (ADR-003)
const DecisionTraceFixture = z.object({
  id: z.number(), agent_id: z.string().nullable(), epic_id: z.string().nullable(),
  story_id: z.string().nullable(), kind: z.string(), subject: z.string().nullable(),
  rationale: z.string(), metadata: z.string().nullable(), timestamp: z.string(),
});
const AgentFixture = z.object({
  story_id: z.string(), review_summary: z.string().nullable(), log_tail: z.string().nullable(),
});
const AuditRowFixture = z.object({
  id: z.number(), agent_id: z.string().nullable(), action: z.string(),
  command: z.string().nullable(), allowed: z.boolean().nullable(),
  policy_rule: z.string().nullable(), detail: z.string().nullable(), timestamp: z.string(),
});
const EpicTelemetryFixture = z.object({
  epic_id: z.string(),
  final_status: z.enum(['done', 'failed']),
  decision_traces: z.array(DecisionTraceFixture),
  agents: z.array(AgentFixture),
  audit_tail: z.array(AuditRowFixture),
});

const RubricExpectation = z.object({
  expected_themes: z.array(z.string().min(1)),          // FR-2: themes, not exact lessons
  over_extraction_traps: z.array(z.string().min(1)).min(1), // ≥1 trap per case
});

export const LessonExtractorCaseSchema = z.object({
  id: z.string(),                                        // GateEvalCase.id
  source: z.enum(['rich', 'thin']),                     // GateEvalCase.source — epic profile
  telemetry: EpicTelemetryFixture,
  rubric: RubricExpectation,
  rationale: z.string().min(1),
});
export type LessonExtractorCase = z.infer<typeof LessonExtractorCaseSchema>;
```

### Judge output (per case) — `judgeTypes.ts`

```ts
export interface LessonExtractorJudgment {
  total_lessons: number;        // count the extractor produced for this case
  faithfulness: number;         // 0..1 — fraction of lessons grounded in the telemetry
  usefulness: number;           // 0..1 — fraction that are actionable general rules, not restatements
  coverage: 'full' | 'partial' | 'missing'; // were the expected_themes surfaced without padding
  hallucinated_lessons: number; // count not grounded in telemetry (≤ total_lessons)
  over_extraction: boolean;     // manufactured lessons on a trap / thin epic
  reason: string;               // judge's justification (audit trail)
}
```

### Aggregate metrics — `judgeTypes.ts`

```ts
import type { CoreMetrics } from '../framework/types.js';

export interface LessonExtractorMetrics extends CoreMetrics {
  faithfulness: number;        // mean of per-case faithfulness over scored cases
  usefulness: number;          // mean of per-case usefulness over scored cases
  coverage: number;            // mean of coverage mapped full=1 / partial=0.5 / missing=0
  hallucinationRate: number;   // Σ hallucinated_lessons / Σ total_lessons across scored cases
  overExtractionRate: number;  // fraction of scored cases with over_extraction === true
}
```

### Reference shapes (owned by production — quoted, not redefined)

Gate input consumed by `LessonExtractor.extract()` and gate output returned (`TOut = Lesson[]`):

```ts
// src/findings/LessonExtractor.ts (production)
interface EpicTelemetry {
  epic_id: string;
  final_status: 'done' | 'failed';
  decision_traces: DecisionTrace[];
  agents: { story_id: string; review_summary: string | null; log_tail: string | null }[];
  audit_tail: AuditRow[];
}

// src/findings/lesson.ts (production) — gate output element
const LessonContent = z.object({
  category: z.string().min(1), observation: z.string().min(1),
  root_cause: z.string().optional(), general_rule: z.string().min(1),
  evidence: z.string().optional(),
});
// .extract() returns the handler-stamped Lesson[] (epic_id/created_at/applied_* added before parse).
```

> Fixture-design note for story-041-001: a *thin* case must carry a little real telemetry, not empty telemetry. `LessonExtractor.extract()` short-circuits to `[]` when all three sources are empty, which would never exercise over-extraction. The thin case should give the extractor just enough to be *tempted* to manufacture lessons.

## API / Interface Contracts

These are the seams epic-041's stories must agree on. Each mirrors the brief-quality/skill-judge signatures so the framework's `runGateEval(cases, consumer, deps)` drives them unchanged.

```ts
// consumer.ts — the single composition point (story-041-006 wires; 002–005 supply parts)
export function createLessonExtractorConsumer(opts: {
  projectRoot: string;            // resolves the production SKILL.md, same as production wiring
}): GateEvalConsumer<
  LessonExtractorCase,            // TCase
  Lesson[],                       // TOut  — production extractor output
  LessonExtractorJudgment,        // TJudg
  LessonExtractorMetrics          // TMetrics
>;

// loadCases.ts (story-041-002)
export function loadLessonExtractorCases(fixturePath?: string): LessonExtractorCase[];

// runGate.ts (story-041-003) — drives the PRODUCTION extractor; throw → { status:'failed' }
export async function runLessonExtractorGate(
  c: LessonExtractorCase,
  deps: GateDeps,                 // { llm, gateModel }
  opts: { projectRoot: string },
): Promise<GateOutcome<Lesson[]>>;

// judge.ts (story-041-004) — rubric-based LLM-as-judge; throw → { status:'inconclusive' }
export async function judgeLessonExtraction(
  c: LessonExtractorCase,
  output: Lesson[],
  deps: JudgeDeps,                // { llm, judgeModel }
): Promise<JudgeOutcome<LessonExtractorJudgment>>;

// score.ts (story-041-005)
export function scoreLessonExtractor(
  records: RunRecord<Lesson[], LessonExtractorJudgment>[],
): LessonExtractorMetrics;
export function lessonExtractorVerdict(m: LessonExtractorMetrics): 'proceed' | 'do-not-proceed';
export const LESSON_EXTRACTOR_THRESHOLDS: EvalThresholds;

// run.ts (story-041-006) — operator entrypoint; NOT a loom subcommand, NOT a worker story
export interface MainOptions { llm?: LLMClient; projectRoot?: string; fixturePath?: string;
                               gateModel?: string; judgeModel?: string; }
export interface EvalReport { metrics: LessonExtractorMetrics; decision: Decision;
                              perCase: RunRecord<Lesson[], LessonExtractorJudgment>[]; markdown: string; }
export async function main(opts?: MainOptions): Promise<EvalReport>;
```

**Gate-driving contract (runGate).** Construct the production class — do not reimplement extraction:

```ts
const extractor = new LessonExtractor({
  llm: deps.llm,
  model: deps.gateModel,                                  // FR-7 gate-under-eval model
  skillMdPath: resolveLessonExtractorSkillMd(opts.projectRoot), // production prompt
});
try {
  return { status: 'ok', output: await extractor.extract(c.telemetry) };
} catch (e) {
  return { status: 'failed', detail: String(e) };        // extractor throws only after its own 1 repair retry
}
```

**Model resolution (FR-7).** Both knobs, with defaults that track what production actually ships:

```ts
const DEFAULT_GATE_MODEL = 'claude-haiku-4-5-20251001'; // = production skill_gen model (ADR-005)
const gateModel  = opts.gateModel  ?? process.env.LOOM_EVAL_GATE_MODEL  ?? DEFAULT_GATE_MODEL;
const judgeModel = opts.judgeModel ?? process.env.LOOM_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL; // 'claude-opus-4-8'
```

**Fail-closed decision (`score.ts` + framework `decide()`).** Structural thresholds short-circuit to `inconclusive`; the quality verdict is the per-metric bar:

```ts
const LESSON_EXTRACTOR_THRESHOLDS: EvalThresholds = {
  minScoredCases: 2,            // = authored case-set floor, NOT the reference 5 (ADR-006)
  maxGateFailureRate: 0.25,
  maxJudgeInconclusiveRate: 0.25,
};
function lessonExtractorVerdict(m: LessonExtractorMetrics): 'proceed' | 'do-not-proceed' {
  if (m.faithfulness      < 0.80) return 'do-not-proceed'; // ADR-007 (calibrated, not tuned)
  if (m.usefulness        < 0.70) return 'do-not-proceed';
  if (m.coverage          < 0.70) return 'do-not-proceed';
  if (m.hallucinationRate > 0.10) return 'do-not-proceed';
  return 'proceed';
}
```

**Sub-barrel (`index.ts`)** — single public entry, matching skill-judge's pattern exactly:

```ts
export * from './caseSchema.js';
export * from './loadCases.js';
export * from './judgeTypes.js';
export * from './runGate.js';
export * from './judge.js';
export * from './score.js';
export * from './consumer.js';
export type { EvalReport, MainOptions } from './run.js';
```

## Security Model

This is an offline, operator-run eval. "Security" here means guardrail integrity and blast-radius containment, not network threat modeling.

| Threat | Control |
|--------|---------|
| Eval silently changes production extraction (violates NFR-1) | `runGate` imports `LessonExtractor` and calls `.extract()`; it never edits `src/findings/**`. The file-ownership map forbids any epic-041 story from modifying production files. Verified by the full suite + capabilities drift check passing unchanged. |
| A real model call leaks onto the worker/agentic path | The consumer has no CLI subcommand and no worker story; the only entry is `scripts/eval-lesson-extractor.mjs`, run by hand. All unit tests inject `MockLLMClient` (NFR-3) — no test makes a real call. |
| Fail-open: degraded extractor scored as `proceed` | `decide()` returns `inconclusive` when scored cases < `minScoredCases`, gate-failure rate, or judge-inconclusive rate breach thresholds; `lessonExtractorVerdict` returns `do-not-proceed` if any quality metric is below bar. Default is never `proceed` by omission. Story-041-005 proves a deliberately degraded output yields `fail`. |
| Barrel collision corrupts the package's public surface (cf. dogfooding S41) | Consumer reached by direct import; **zero** new lines in `src/eval/index.ts` (ADR-001). No wildcard re-export, so no name can collide at the root. |
| Guardrail weakened to make the eval pass | NFR-4 is a hard gate: policy engine, worktree isolation, and audit logging are untouched; capabilities drift check must pass. |
| Synthetic fixtures mistaken for real telemetry | Fixtures are hand-authored synthetic only (PRD out-of-scope), live under `eval-cases/`, and contain no anonymized real-epic data. |

## ADR Log

### ADR-001 — Add zero lines to the top barrel; reach the consumer by direct import
**Decision.** Mirror brief-quality/skill-judge: the new consumer is reached via `./lesson-extractor/run.js` and `./lesson-extractor/index.js`; `src/eval/index.ts` gains no re-export.
**Context.** FR-9 permits "at most one re-export line." Inspection of `src/eval/index.ts` shows brief-quality and skill-judge are **not** re-exported there at all — only `intake` is, and it carries explicit collision-guard comments. The runner scripts import `dist/eval/<consumer>/run.js` directly.
**Rationale.** "Matching the brief-quality/skill-judge structure" means the sub-barrel + single-public-entry pattern they use, which adds zero top-barrel lines. The eval is operator-run, not a library API, so it needs no package-root surface.
**Trade-off.** The consumer is not discoverable from the package root and must be deep-imported. We accept that to keep the one allowed line in reserve and to eliminate any wildcard-collision risk (the failure that bit S41).

### ADR-002 — Gate output is the production `Lesson[]`; drive the real class, never reimplement
**Decision.** `runGate` constructs `new LessonExtractor({ llm, model: gateModel, skillMdPath })` and returns `GateOutcome<Lesson[]>`.
**Context.** FR-4 / NFR-1 require observing the production extractor without reimplementation.
**Rationale.** Importing the class is the only way to measure what production actually does; any local copy would measure a fiction.
**Trade-off.** The eval is bound to the production constructor (`LessonExtractorOptions`) and `EpicTelemetry`/`Lesson` shapes — a production refactor can break the eval build. That coupling is intentional: an eval that can't see a breaking change isn't an eval.

### ADR-003 — Fixtures carry `EpicTelemetry` directly; bypass `gatherEpicTelemetry()` and SQLite
**Decision.** Each case embeds a synthetic `EpicTelemetry` payload validated by a zod schema that mirrors the production shape. The gate feeds it straight to `.extract()`.
**Context.** Production assembles telemetry from `decision_traces`, `agents`, and `audit_log` SQLite tables. Reproducing that for an offline eval would require a DB fixture harness.
**Rationale.** `.extract()` takes `EpicTelemetry` as a plain argument — the cheapest, most deterministic seam. The DB-gathering path is not under eval here.
**Trade-off.** We do not exercise `gatherEpicTelemetry()` or the stores. Accepted: that path has its own tests, and bypassing it keeps the eval offline and reproducible. The cost is a zod schema that must track the production telemetry shape if it changes.

### ADR-004 — Rubric-theme judging instead of label-matching
**Decision.** The judge scores extracted lessons against `expected_themes` + `over_extraction_traps`, emitting faithfulness/usefulness/coverage and hallucination/over-extraction flags — not a comparison to an exact expected lesson set.
**Context.** Lesson extraction is open-ended; there is no single correct output, so the prior consumers' label-matching cannot detect hallucination, over-extraction, or low-value restatement.
**Rationale.** Themes + traps are what a competent reviewer actually checks; they catch the failure modes label-matching misses (PRD Goal 3).
**Trade-off.** The judge is a non-deterministic LLM, so verdicts can vary run-to-run on real models. Mitigated by deterministic mocked-LLM unit tests in CI; real-model stability validation is explicitly deferred to the operator (out of scope for v1).

### ADR-005 — Default gate model = the production `skill_gen` model
**Decision.** `DEFAULT_GATE_MODEL = 'claude-haiku-4-5-20251001'` (the `skill_gen` default the production extractor uses); `DEFAULT_JUDGE_MODEL = 'claude-opus-4-8'` from the framework; both overridable via `LOOM_EVAL_GATE_MODEL` / `LOOM_EVAL_JUDGE_MODEL`.
**Context.** Production `LessonExtractor` is wired with `modelFor(policy, 'skill_gen')`. skill-judge already sets its gate default to the model production runs and judges with Opus.
**Rationale.** The eval should, by default, measure the model production actually ships, and judge with the strongest available grader.
**Trade-off.** The gate default tracks production, so changing the production `skill_gen` model silently changes the eval's default subject. We treat that as desirable — the eval follows production — and the operator can pin a model explicitly via env when comparing.

### ADR-006 — Structural `minScoredCases` set to the authored case-set size
**Decision.** `LESSON_EXTRACTOR_THRESHOLDS.minScoredCases = 2`, not the reference consumers' `5`.
**Context.** FR-1 requires at least one rich and one thin case for v1; the brief-quality/skill-judge sets are larger.
**Rationale.** If `minScoredCases` exceeds the authored case count, `decide()` returns `inconclusive` forever and the gate can never pass — a fail-closed deadlock, not a quality signal.
**Trade-off.** A 2-case floor means each case heavily sways the verdict and the statistical signal is weak. Accepted for v1; the operator grows the set and raises the floor as cases accrue. The floor is a named constant precisely so it moves with the fixture count.

### ADR-007 — Verdict thresholds calibrated from reference consumers, not empirically tuned
**Decision.** Ship `faithfulness ≥ 0.80`, `usefulness ≥ 0.70`, `coverage ≥ 0.70`, `hallucinationRate ≤ 0.10`, anchored to brief-quality's `0.8 / 0.7 / 0.6` bands.
**Context.** FR-6 calls for thresholds calibrated against the brief-quality / skill-judge reference consumers rather than set arbitrarily; empirical tuning is out of scope for v1.
**Rationale.** Borrowing proven bands gives defensible defaults on day one and a fail-closed posture that errs toward `do-not-proceed`.
**Trade-off.** The defaults may be mis-calibrated until validated on real runs — they could reject a good extractor or, less likely, pass a marginal one. The fail-closed bias makes the safe error (false `do-not-proceed`) the likely one, and the operator re-calibrates against real telemetry.
