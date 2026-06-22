# Skill-Generator Eval — Operator Runbook

The skill-generator eval measures how accurately `SkillGenerator` decides when to
generate a skill and how high-quality the generated skills are. It is a
**developer/R&D tool** — not a `loom` subcommand and not run during normal loom
execution (ADR-006). A human operator runs it after merging changes that touch
`SkillGenerator`, the skill-generator judge persona, or the case set itself.

The go/no-go verdict is intentionally out-of-band: the eval is an "honest gate"
— a worker cannot grade its own homework. The harness is **offline-from-CI,
operator-run, and observe-only**: CI proves only that the mocked wiring compiles
and the unit tests pass; the live verdict appears solely when an operator runs
this script. This eval is also **never a worker story** — it is not dispatched
by loom and does not appear in `loom status` (NFR-3, ADR-006).

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
npm run eval:skill-generator
```

Equivalently:

```bash
node scripts/eval-skill-generator.mjs
```

The script processes all cases in
`packages/loom-core/eval-cases/skill-generator.yaml` and writes the report to:

- `.loom/eval/skill-generator-report.md` (human-readable)
- `.loom/eval/skill-generator-report.json` (machine-readable)

Both files are gitignored (`.loom/eval/` is in `.gitignore`).

---

## Optional env-var overrides

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `claude-haiku-4-5-20251001` | Model for `SkillGenerator` (the gate call — same as `policy.agents.skill_gen_model`) |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | Model for the independent rubric judge |
| `LOOM_EVAL_SKILLGEN_MIN_DECISION_CORRECTNESS` | `0.80` | Minimum fraction of non-borderline cases decided correctly |
| `LOOM_EVAL_SKILLGEN_MIN_SKILL_QUALITY` | `0.70` | Minimum average skill-quality score |
| `LOOM_EVAL_SKILLGEN_MIN_FAITHFULNESS` | `0.80` | Minimum faithfulness score |
| `LOOM_EVAL_SKILLGEN_MAX_SPURIOUS_RATE` | `0.15` | Maximum fraction of trivial cases where a skill was generated |
| `LOOM_EVAL_SKILLGEN_MAX_LOW_QUALITY_RATE` | `0.20` | Maximum fraction of judged skills rated low-quality |

The two models are **intentionally different** to break circularity: the gate
model (Haiku) is the system under test — it decides whether to generate a skill
and produces the SKILL.md; the judge model (Opus) is an independent, stronger
evaluator that grades whether each skill was well-formed, reusable, and faithful
to the work context. Running both on the same model would let the system grade
its own homework.

To run the gate on Sonnet while keeping the Opus judge (reduces cost when
iterating on the SkillGenerator prompt):

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:skill-generator
```

---

## Metrics

The report surfaces five eval-specific metrics plus the standard core metrics:

### Deterministic metrics (no LLM required)

| Metric | Description |
|---|---|
| `decisionCorrectness` | Fraction of non-borderline cases (`source != 'borderline'`) where `SkillGenerator`'s decision (`generate`/`none`) matched the human-labeled `expected_decision`. Borderline cases are excluded — they are in the "either" band where both outcomes are acceptable. A value of 1.0 means perfect recall on worthy cases and perfect rejection on trivial cases. |
| `spuriousGenerationRate` | Fraction of cases labeled `expected_decision: none` (purely trivial) where `SkillGenerator` generated a skill anyway. Lower is better; 0.0 means no false positives. |

### LLM-derived quality metrics (judge-dependent)

These are computed only over cases where `SkillGenerator` decided `generate` AND
the independent judge returned `ok`. Gate-failed, judge-inconclusive, and
`decision='none'` records are excluded from these means.

| Metric | Description |
|---|---|
| `skillQuality` | Average composite quality score: `(well_formed + reusable + scope_appropriateness) / 3` for each judged skill. Measures structural quality and reusability breadth, independent of grounding. |
| `faithfulness` | Average faithfulness score across judged skills. Measures how grounded the generated skill is in the actual work context — does it capture what was actually done, or is it generic boilerplate? |
| `lowQualityRate` | Fraction of judged skills where the judge flagged `low_quality: true` (an advisory boolean distinct from the numeric scores). A non-zero rate warrants reviewing the flagged cases. |

### Standard core metrics

| Metric | Description |
|---|---|
| `totalCases` | Total cases in the fixture. |
| `scoredCases` | Cases where the gate returned `ok` — regardless of judge status. Decision correctness (`decisionCorrectness`, `spuriousGenerationRate`) is scored over every gate-ok case, including `decision='none'` cases, independent of skill-quality judging. Judge status affects the quality metrics (`skillQuality`, `faithfulness`, `lowQualityRate`) but not `scoredCases`. |
| `gateFailures` / `gateFailureRate` | Cases where the gate threw an error. |
| `judgeInconclusive` / `judgeInconclusiveRate` | Cases where the independent judge could not produce a valid score. |

---

## Pass/fail thresholds (fail-closed)

The run resolves to `proceed` only when **all** of the following hold:

| Check | Threshold |
|---|---|
| Scored cases | ≥ 2 |
| Gate failure rate | ≤ 25% |
| Judge inconclusive rate | ≤ 25% |
| Decision correctness | ≥ 80% |
| Skill quality | ≥ 70% |
| Faithfulness | ≥ 80% |
| Spurious generation rate | ≤ 15% |
| Low-quality rate | ≤ 20% |

If any structural threshold (scored-cases, gate, or judge rates) is breached, the
run resolves to `inconclusive`. If structural checks pass but a quality bar is
missed, the run resolves to `do-not-proceed`. Investigate gate or judge reliability
first for `inconclusive`; for `do-not-proceed`, review the metric that failed.

The threshold constants live in `SKILL_GENERATOR_THRESHOLDS` and
`resolveSkillGeneratorBar()` in `src/eval/skill-generator/score.ts`. All bar
thresholds are overridable via environment variables.

---

## Expected cost and runtime

The default fixture has **8 labeled cases** (2 worthy, 4 trivial, 2 borderline).
The framework guarantees:

- **≤1 gate call per case** (SkillGenerator — the system under test)
- **≤1 judge call per case where gate returned `ok` AND `decision='generate'`**
  (judge is skipped when `decision='none'`)

With `claude-cli` session-based backend (no metered tokens): **no API cost**.

With an API key backend (`LOOM_EVAL_BACKEND=sdk`):

| Budget item | Max count | Note |
|---|---|---|
| Gate calls (Haiku) | 8 | One per case |
| Judge calls (Opus 4.8) | ≤ 8 | Only for `decision='generate'` cases where gate succeeded |
| **Total calls** | **≤ 16** | Judge skipped on gate failure or `decision='none'` |

Typical wall-clock time: **3–6 minutes** for 8 cases processed sequentially.

To minimize API spend, leave the gate on the default Haiku model:
```bash
npm run eval:skill-generator
# → 8 Haiku gate calls + ≤8 Opus judge calls
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
Fixture:     packages/loom-core/eval-cases/skill-generator.yaml (8 cases)

Decision: proceed | do-not-proceed | inconclusive

Metrics:
  Total cases:              8
  Scored cases:             ?
  Gate failures:            ? (? %)
  Judge inconclusive:       ? (? %)
  Decision correctness:     ? %
  Spurious generation rate: ? %
  Skill quality:            ? %
  Faithfulness:             ? %
  Low-quality rate:         ? %
```

If `decision = do-not-proceed`:
- `decisionCorrectness < 80%` → SkillGenerator is miscategorizing worthy or trivial
  work; review the generator prompt or the case set's `expected_decision` labels.
- `spuriousGenerationRate > 15%` → Too many false positives on trivial cases;
  tighten the generator prompt's trigger criteria.
- `skillQuality < 70%` → Generated skills are structurally weak or poorly scoped;
  review the `skill-generator-judge.md` persona or the generator prompt.
- `faithfulness < 80%` → Skills are generic boilerplate, not grounded in the actual
  work; adjust the generator prompt to emphasize diff-grounding.
- `lowQualityRate > 20%` → Too many skills flagged by the judge; review the
  flagged cases and adjust accordingly.

If `decision = inconclusive`:
- Gate failure rate > 25% or judge inconclusive rate > 25% → investigate
  reliability; check LLM connectivity and try a more capable model.
- Scored cases < 2 → both of the above apply; add more cases to the fixture.

---

## Per-case output columns

The markdown report table includes:

| Column | What it shows |
|---|---|
| `Gate` | `ok` (SkillGenerator returned a result) or `failed` |
| `Judge` | `ok`, `skipped` (decision was `none`), or `inconclusive` |
| `Decision` | `generate` or `none` — the gate's output decision |
| `Quality` | Composite quality score `(well_formed + reusable + scope_appropriateness) / 3` — `—` when judge skipped |
| `Faithfulness` | Judge's faithfulness score — `—` when judge skipped |
| `Spurious` | Judge's advisory `spurious` boolean — `—` when judge skipped |
| `Low-Quality` | Judge's advisory `low_quality` boolean — `—` when judge skipped |

---

## Architecture reference

For a description of the framework that powers this eval (plug points,
fail-closed logic, model resolution), see
[`docs/architecture/gate-eval-framework.md`](../architecture/gate-eval-framework.md).
