# Lesson-Extractor Eval — Operator Runbook

The lesson-extractor eval measures how accurately `LessonExtractor` synthesizes
lessons from a labeled case set of epic telemetry. It is a **developer/R&D tool**
— not a `loom` subcommand and not run during normal loom execution (ADR-006). A
human operator runs it after merging changes that touch `LessonExtractor`, the
lesson-extractor judge persona, or the case set itself.

The go/no-go verdict is intentionally out-of-band: the eval is an "honest gate"
— a worker cannot grade its own homework. The harness is **offline-from-CI,
operator-run, and observe-only**: CI proves only that the mocked wiring compiles
and the unit tests pass; the live verdict appears solely when an operator runs
this script. This eval is also **never a worker story** — it is not dispatched
by loom and does not appear in `loom status` (NFR-2, ADR-006).

---

## Prerequisites

1. `loom-core` built locally:
   ```bash
   npm install
   npm run build -w @loom-ai/core
   ```
2. A working LLM backend. The default is `claude-cli` (session-based, no metered
   cost). Ensure `claude` is on PATH and you are logged in.

---

## Running the eval

```bash
npm run eval:lesson-extractor
```

Equivalently:

```bash
node scripts/eval-lesson-extractor.mjs
```

The script processes all cases in
`packages/loom-core/eval-cases/lesson-extractor.yaml` and writes the report to:

- `.loom/eval/lesson-extractor-report.md` (human-readable)
- `.loom/eval/lesson-extractor-report.json` (machine-readable)

Both files are gitignored (`.loom/eval/` is in `.gitignore`).

---

## Optional env-var overrides

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `claude-haiku-4-5-20251001` | Model for `LessonExtractor` (the gate call) |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | Model for the independent rubric judge |

The two models are **intentionally different** to break circularity: the gate
model (Haiku) is the system under test — it extracts lessons from epic telemetry;
the judge model (Opus) is an independent, stronger evaluator that grades whether
the extraction was faithful, useful, and free of hallucination. Running both on
the same model would let the system grade its own homework. Using Haiku for the
gate also keeps per-run cost low; Opus is reserved for the oracle role only.

To run the gate on Sonnet while keeping the Opus judge (reduces cost when
iterating on the LessonExtractor prompt):

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:lesson-extractor
```

---

## Metrics

The report surfaces five eval-specific metrics plus the standard core metrics:

| Metric | Description |
|---|---|
| `faithfulness` | Average fraction of extracted lessons grounded in the telemetry (0–1). |
| `usefulness` | Average fraction of extracted lessons that are actionable general rules (0–1). |
| `coverage` | Average coverage score across cases: `full=1`, `partial=0.5`, `missing=0`. |
| `hallucinationRate` | Σ hallucinated lessons / Σ total lessons across scored cases. |
| `overExtractionRate` | Fraction of scored cases where `over_extraction === true`. |

Standard core metrics are also present:

| Metric | Description |
|---|---|
| `totalCases` | Total cases in the fixture. |
| `scoredCases` | Cases where both the gate and independent judge returned `ok`. |
| `gateFailures` / `gateFailureRate` | Cases where the gate threw. |
| `judgeInconclusive` / `judgeInconclusiveRate` | Cases where the independent judge returned `inconclusive`. |

---

## Pass/fail thresholds (fail-closed)

The run resolves to `proceed` only when **all** of the following hold:

| Check | Threshold |
|---|---|
| Scored cases | ≥ 2 |
| Gate failure rate | ≤ 25% |
| Judge inconclusive rate | ≤ 25% |
| Faithfulness | ≥ 80% |
| Usefulness | ≥ 70% |
| Coverage | ≥ 70% |
| Hallucination rate | ≤ 10% |
| Over-extraction rate | ≤ 20% |

If any structural threshold (scored-cases, gate, or judge rates) is breached, the
run resolves to `inconclusive`. If structural checks pass but a quality bar is
missed, the run resolves to `do-not-proceed`. Investigate gate or judge reliability
first for `inconclusive`; for `do-not-proceed`, review the metrics to identify
which quality bar failed.

The threshold constants live in `LESSON_EXTRACTOR_THRESHOLDS` and the verdict
function in `src/eval/lesson-extractor/score.ts`.

---

## Expected cost and runtime

The default fixture has **2 labeled cases** (1 rich, 1 thin). The framework
guarantees:

- **≤1 gate call per case** (LessonExtractor — the system under test)
- **≤1 judge call per scored case** (only called when the gate returned `ok`)

With `claude-cli` session-based backend (no metered tokens): **no API cost**.

With an API key backend (`LOOM_EVAL_BACKEND=sdk`):

| Budget item | Max count | Note |
|---|---|---|
| Gate calls (Haiku) | 2 | One per case |
| Judge calls (Opus 4.8) | 2 | One per case where gate succeeded |
| **Total calls** | **≤ 4** | Judge skipped on gate failure |

Typical wall-clock time: **1–3 minutes** for 2 cases processed sequentially.

To minimize API spend, leave the gate on the default Haiku model:
```bash
npm run eval:lesson-extractor
# → 2 Haiku gate calls + ≤2 Opus judge calls
```

---

## Recording the verdict

Do **not** adjust the verdict based on whether the outcome is favorable. Record
the numbers as-is. Commit the filled-in table below to
`.loom/planning/epic-<N>/eval-run-YYYY-MM-DD.md` after the run.

```
Date: YYYY-MM-DD
Gate model:  <value>
Judge model: <value>
Fixture:     packages/loom-core/eval-cases/lesson-extractor.yaml (2 cases)

Decision: proceed | do-not-proceed | inconclusive

Metrics:
  Total cases:          2
  Scored cases:         ?
  Gate failures:        ? (? %)
  Judge inconclusive:   ? (? %)
  Faithfulness:         ? %
  Usefulness:           ? %
  Coverage:             ? %
  Hallucination rate:   ? %
  Over-extraction rate: ? %
```

If `decision = do-not-proceed`:
- `faithfulness < 80%` → LessonExtractor is extracting ungrounded lessons;
  review the `lesson-extractor-judge.md` persona or the SKILL.md.
- `usefulness < 70%` → Lessons are too specific to be general rules;
  adjust the rubric or the judge persona.
- `coverage < 70%` → The extractor is missing expected themes;
  check whether the fixture telemetry is rich enough.
- `hallucinationRate > 10%` → Hallucinations are present; investigate
  the extractor prompt or reduce `maxTokens`.
- `overExtractionRate > 20%` → Extractor manufactures lessons from thin
  telemetry; review the SKILL.md over-extraction guidance.

If `decision = inconclusive`:
- Gate failure rate > 25% or judge inconclusive rate > 25% → investigate
  reliability; check LLM connectivity and try a more capable model.
- Scored cases < 2 → both of the above apply; add more cases to the fixture.

---

## Per-case output columns

The markdown report table includes:

| Column | What it shows |
|---|---|
| `Gate` | `ok` (LessonExtractor returned a result) or `failed` |
| `Judge` | `ok` or `inconclusive` |
| `Faithfulness` | Fraction of extracted lessons grounded in telemetry |
| `Usefulness` | Fraction of extracted lessons that are actionable general rules |
| `Coverage` | `full`, `partial`, or `missing` |
| `Hallucinated` | Count of hallucinated lessons |
| `Over-extracted` | `true`/`false` — did the extractor over-extract? |

---

## Architecture reference

For a description of the framework that powers this eval (plug points,
fail-closed logic, model resolution), see
[`docs/architecture/gate-eval-framework.md`](../architecture/gate-eval-framework.md).
