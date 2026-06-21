# Brief-Quality Eval — Operator Runbook

The brief-quality eval measures how accurately `BriefRefiner` scores a labeled
case set of rough briefs. It is a **developer/R&D tool** — not a `loom` subcommand
and not run during normal loom execution (ADR-006). A human operator runs it after
merging changes that touch `BriefRefiner`, the brief-quality judge persona, or the
case set itself.

The go/no-go verdict is intentionally out-of-band: the eval is "honest gate" — a
worker cannot grade its own homework.

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
npm run eval:brief-quality
```

Equivalently:

```bash
node scripts/eval-brief-quality.mjs
```

The script processes all cases in
`packages/loom-core/eval-cases/brief-quality.yaml` and writes the report to:

- `.loom/eval/brief-quality-report.md` (human-readable)
- `.loom/eval/brief-quality-report.json` (machine-readable)

Both files are gitignored (`.loom/eval/` is in `.gitignore`).

---

## Optional env-var overrides

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `claude-opus-4-8` | Model for `BriefRefiner` (the gate call) |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | Model for the quality judge |

To run the gate on Sonnet while keeping the Opus judge (reduces cost when
iterating on BriefRefiner):

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:brief-quality
```

---

## Expected cost and runtime (NFR-3)

The default fixture has **9 labeled cases**. The framework guarantees:

- **≤1 gate call per case** (BriefRefiner — the system under test)
- **≤1 Opus judge call per scored case** (only called when the gate returned `ok`)

With both models defaulting to `claude-opus-4-8` and the `claude-cli`
session-based backend (no metered tokens): **no API cost**.

With an API key backend (`LOOM_EVAL_BACKEND=sdk`):

| Budget item | Max count | Note |
|---|---|---|
| Gate calls (Opus 4.8) | 9 | One per case |
| Judge calls (Opus 4.8) | 9 | One per case where gate succeeded |
| **Total Opus calls** | **≤ 18** | Judge skipped on gate failure |

Judge output is capped at 512 tokens. Typical wall-clock time: **3–6 minutes**
for 9 cases processed sequentially.

To minimize API spend, run the gate on Sonnet:
```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:brief-quality
# → 9 Sonnet gate calls + ≤9 Opus judge calls
```

---

## Quality-band cuts (review before each run)

The band boundaries live in `src/eval/brief-quality/bands.ts` — the single source
of truth. Verify they still reflect the team's quality bar before running.

| Band | `quality_score` range | Meaning |
|---|---|---|
| `low` | 0–3 | Vague, missing scope elements, not plan-ready |
| `mid` | 4–6 | Borderline — has structure but gaps remain |
| `high` | 7–10 | Well-scoped, testable criteria, plan-ready |

**Band tolerance τ = 1.** A `quality_score` of `s` agrees with expected band
`[lo, hi]` when `s ∈ [lo−1, hi+1]`. This absorbs natural scoring jitter at band
edges (e.g., a score of 4 is accepted for an expected `low` band of `[0,3]` and
for an expected `mid` band of `[4,6]`).

If you change these constants, re-run the eval to see the impact before merging.

---

## Pass/fail thresholds

The run resolves to `proceed` only when **all** of the following hold after the
structural checks pass:

**Structural (fail-closed — `inconclusive` if breached):**
- Scored cases ≥ 5 (both gate ok and judge ok)
- Gate failure rate ≤ 25%
- Judge inconclusive rate ≤ 25%

**Quality bar (consumer verdict):**
- Readiness accuracy ≥ 80% (`BriefRefiner.ready` matches the human label) — under the sharpened criteria, `ready=true` requires the brief to be in the high quality band (7–10) AND have no critical planning-blocking gap; minor clarification questions alone do not force `ready=false`
- Quality-band agreement ≥ 70% (`quality_score` in expected band ± τ)
- Critique quality ≥ 60% (`faithful` + 0.5 × `partial` / scored cases)

If any structural threshold is breached, the run resolves to `inconclusive` —
not `do-not-proceed`. Investigate gate or judge reliability first, then re-run.

---

## Recording the verdict

Do **not** adjust the verdict based on whether the outcome is favorable. Record
the numbers as-is. Commit the filled-in table below to
`.loom/planning/epic-<N>/eval-run-YYYY-MM-DD.md` after the run.

```
Date: YYYY-MM-DD
Gate model:  <value>
Judge model: <value>
Fixture:     packages/loom-core/eval-cases/brief-quality.yaml (9 cases)

Decision: proceed | do-not-proceed | inconclusive

Metrics:
  Total cases:              9
  Scored cases:             ?
  Gate failures:            ? (? %)
  Judge inconclusive:       ? (? %)
  Readiness accuracy:       ? %
  Quality-band agreement:   ? %
  Critique quality:         ? %
```

If `decision = inconclusive`:
- Gate failure rate > 25% → investigate BriefRefiner reliability or switch
  to a more capable gate model.
- Judge inconclusive rate > 25% → investigate the judge persona or model.
- Scored cases < 5 → both of the above apply; the run produced too little data.

If `decision = do-not-proceed`:
- Readiness accuracy < 80% → BriefRefiner is misclassifying `ready` on too many
  cases. Check whether cases with only minor/optional questions are incorrectly
  getting `ready=false` (over-conservative) or whether cases with critical blocking
  gaps are incorrectly getting `ready=true` (under-conservative).
- Band agreement < 70% → `quality_score` is consistently off-band; check the
  band constants against what the team's quality bar actually means.
- Critique quality < 60% → too many `fabricated` critiques; review the judge
  persona and the BriefRefiner prompt.

---

## Per-case output columns

The markdown report table includes:

| Column | What it shows |
|---|---|
| `Gate` | `ok` (BriefRefiner returned a result) or `failed` |
| `Judge` | `ok`, `inconclusive`, or `skipped` (gate failed) |
| `Correct` | `true`/`false` — did `BriefRefiner.ready` match the human label? |
| `In-Band` | `true`/`false` — is `quality_score` within the expected band ± τ? |
| `Fidelity` | `faithful` / `partial` / `fabricated` — does the critique surface the expected themes? |

---

## Architecture reference

For a description of the framework that powers this eval (plug points, fail-closed
logic, model resolution), see
[`docs/architecture/gate-eval-framework.md`](../architecture/gate-eval-framework.md).
