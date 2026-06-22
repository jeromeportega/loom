# Skill-Judge Eval — Operator Runbook

The skill-judge eval measures how accurately `SkillJudge` scores a labeled case
set of candidate skills. It is a **developer/R&D tool** — not a `loom`
subcommand and not run during normal loom execution (ADR-006). A human operator
runs it after merging changes that touch `SkillJudge`, the skill-admissibility
judge persona, or the case set itself.

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
npm run eval:skill-judge
```

Equivalently:

```bash
node scripts/eval-skill-judge.mjs
```

The script processes all cases in
`packages/loom-core/eval-cases/skill-judge.yaml` and writes the report to:

- `.loom/eval/skill-judge-report.md` (human-readable)
- `.loom/eval/skill-judge-report.json` (machine-readable)

Both files are gitignored (`.loom/eval/` is in `.gitignore`).

---

## Optional env-var overrides

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `claude-haiku-4-5-20251001` | Model for `SkillJudge` (the gate call) |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | Model for the independent admissibility judge |

The two models are **intentionally different** to break circularity: the gate
model (Haiku) is the system under test — it makes the accept/reject verdict
being measured; the judge model (Opus) is an independent, stronger evaluator
that grades whether each gate decision and score were correct. Running both on
the same model would let the system grade its own homework. Using Haiku for the
gate also keeps per-run cost low; Opus is reserved for the oracle role only.

To run the gate on Sonnet while keeping the Opus judge (reduces cost when
iterating on the SkillJudge prompt):

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:skill-judge
```

---

## Metrics

The report surfaces four eval-specific metrics plus the standard core metrics:

| Metric | Description |
|---|---|
| `decisionAccuracy` | Fraction of cases where `SkillJudge.verdict` matched the human-labeled `expected_decision` (accept/reject). |
| `bandAgreement` | Fraction of cases where `SkillJudge.score` fell within the expected quality band ± tolerance τ. |
| `independentAgreement` | Fraction of cases where the independent Opus judge reached the same verdict as the gate. |
| `failOpenObserved` | Count of cases where the gate returned the fail-open sentinel (score === 999), indicating the judge was unavailable. |

Standard core metrics are also present:

| Metric | Description |
|---|---|
| `totalCases` | Total cases in the fixture. |
| `scoredCases` | Cases where both the gate and independent judge returned `ok`. |
| `gateFailures` / `gateFailureRate` | Cases where the gate threw or returned the fail-open sentinel. |
| `judgeInconclusive` / `judgeInconclusiveRate` | Cases where the independent judge returned `inconclusive`. |

---

## Quality-band cuts

The band boundaries live in `src/eval/skill-judge/bands.ts` — the single source
of truth. Anchored to `policy.agents.skill_judge_min_score` (default 6):

| Band | Score range | Meaning |
|---|---|---|
| `bad` | 0–4 | Vague, unsafe, not reusable, or duplicative — clearly reject |
| `borderline` | 5–6 | Marginal — might accept with revision |
| `good` | 7–10 | Crisp, bounded, reusable, safe — clearly accept |

**Band tolerance τ = 1.** A `score` of `s` agrees with expected band `[lo, hi]`
when `s ∈ [lo−1, hi+1]`. This absorbs natural scoring jitter at band edges.

---

## Pass/fail thresholds (fail-closed)

The run resolves to `proceed` only when **all** of the following hold:

| Check | Threshold |
|---|---|
| Scored cases | ≥ 5 |
| Gate failure rate | ≤ 25% |
| Judge inconclusive rate | ≤ 25% |

If any structural threshold is breached, the run resolves to `do-not-proceed`.
Investigate gate or judge reliability first, then re-run.

The threshold constants live in `SKILL_JUDGE_THRESHOLDS` in
`src/eval/skill-judge/score.ts`.

---

## Expected cost and runtime

The default fixture has **10 labeled cases**. The framework guarantees:

- **≤1 gate call per case** (SkillJudge — the system under test)
- **≤1 judge call per scored case** (only called when the gate returned `ok`)

With `claude-cli` session-based backend (no metered tokens): **no API cost**.

With an API key backend (`LOOM_EVAL_BACKEND=sdk`):

| Budget item | Max count | Note |
|---|---|---|
| Gate calls (Haiku) | 10 | One per case |
| Judge calls (Opus 4.8) | 10 | One per case where gate succeeded |
| **Total calls** | **≤ 20** | Judge skipped on gate failure |

Typical wall-clock time: **3–6 minutes** for 10 cases processed sequentially.

To minimize API spend, leave the gate on the default Haiku model:
```bash
npm run eval:skill-judge
# → 10 Haiku gate calls + ≤10 Opus judge calls
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
Fixture:     packages/loom-core/eval-cases/skill-judge.yaml (10 cases)

Decision: proceed | do-not-proceed

Metrics:
  Total cases:              10
  Scored cases:             ?
  Gate failures:            ? (? %)
  Fail-open observed:       ?
  Judge inconclusive:       ? (? %)
  Decision accuracy:        ? %
  Band agreement:           ? %
  Independent agreement:    ? %
```

If `decision = do-not-proceed`:
- Gate failure rate > 25% or fail-open observed > 0 → investigate SkillJudge
  reliability or switch to a more capable gate model.
- Judge inconclusive rate > 25% → investigate the judge persona or model.
- Scored cases < 5 → both of the above apply; the run produced too little data.

---

## Per-case output columns

The markdown report table includes:

| Column | What it shows |
|---|---|
| `Gate` | `ok` (SkillJudge returned a result) or `failed` |
| `Judge` | `ok` or `inconclusive` |
| `Correct` | `true`/`false` — did gate verdict match the human label? |
| `In-Band` | `true`/`false` — is the score within the expected band ± τ? |
| `Ind. Verdict` | The independent judge's accept/reject verdict |
| `Defensible` | `true`/`false` — did the independent judge find the band defensible? |

---

## Architecture reference

For a description of the framework that powers this eval (plug points,
fail-closed logic, model resolution), see
[`docs/architecture/gate-eval-framework.md`](../architecture/gate-eval-framework.md).
