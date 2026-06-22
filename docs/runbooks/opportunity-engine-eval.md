# Opportunity-Engine Eval — Operator Runbook

The opportunity-engine eval measures how accurately `OpportunityEngine` clusters
open signals into improvement opportunities against a human-labeled rubric case
set. It is a **developer/R&D tool** — not a `loom` subcommand and not run during
normal loom execution (ADR-006). A human operator runs it after merging changes
that touch `OpportunityEngine`, the opportunity-engine judge persona, or the case
set itself.

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
npm run eval:opportunity-engine
```

Equivalently:

```bash
node scripts/eval-opportunity-engine.mjs
```

The script processes all cases in
`packages/loom-core/eval-cases/opportunity-engine.yaml` and writes the report to:

- `.loom/eval/opportunity-engine-report.md` (human-readable)
- `.loom/eval/opportunity-engine-report.json` (machine-readable)

Both files are gitignored (`.loom/eval/` is in `.gitignore`).

---

## Optional env-var overrides

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_GATE_MODEL` | `claude-haiku-4-5-20251001` | Model for `OpportunityEngine` (the gate call) |
| `LOOM_EVAL_JUDGE_MODEL` | `claude-opus-4-8` | Model for the independent rubric judge |

The two models are **intentionally different** to break circularity: the gate
model (Haiku) is the system under test — it clusters signals into opportunities;
the judge model (Opus) is an independent, stronger evaluator that grades whether
the clustering was coherent, well-grounded, and free of hallucination. Running
both on the same model would let the system grade its own homework. Using Haiku
for the gate also keeps per-run cost low; Opus is reserved for the oracle role only.

To run the gate on Sonnet while keeping the Opus judge (reduces cost when
iterating on the OpportunityEngine prompt):

```bash
LOOM_EVAL_GATE_MODEL=claude-sonnet-4-6 npm run eval:opportunity-engine
```

### Quality-bar overrides

The quality thresholds can also be adjusted via env vars without code changes:

| Variable | Default | Purpose |
|---|---|---|
| `LOOM_EVAL_OPP_MIN_COHERENCE` | `0.80` | Minimum mean coherence to proceed |
| `LOOM_EVAL_OPP_MIN_SCORE_REASONABLENESS` | `0.70` | Minimum mean score reasonableness |
| `LOOM_EVAL_OPP_MIN_GROUNDING` | `0.90` | Minimum mean grounding |
| `LOOM_EVAL_OPP_MAX_FORCED_CLUSTERING_RATE` | `0.20` | Maximum forced-clustering rate |
| `LOOM_EVAL_OPP_MAX_HALLUCINATION_RATE` | `0.10` | Maximum hallucination rate |

---

## Metrics

The report surfaces five eval-specific metrics plus the standard core metrics:

| Metric | Description |
|---|---|
| `coherence` | Average fraction of clusters grouping genuinely related signals (0–1). |
| `scoreReasonableness` | Average defensibility of impact/effort/confidence scores (0–1). |
| `grounding` | Average fraction of clusters justified by their member signals (0–1). |
| `forcedClusteringRate` | Σ forced_clusters / Σ cluster_count across scored cases. |
| `hallucinationRate` | Σ (invented_opportunities + nonexistent_signal_ids) / Σ cluster_count. |

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
| Scored cases | ≥ 3 |
| Gate failure rate | ≤ 25% |
| Judge inconclusive rate | ≤ 25% |
| Coherence | ≥ 80% |
| Score reasonableness | ≥ 70% |
| Grounding | ≥ 90% |
| Forced clustering rate | ≤ 20% |
| Hallucination rate | ≤ 10% |

If any structural threshold (scored-cases, gate, or judge rates) is breached, the
run resolves to `inconclusive`. If structural checks pass but a quality bar is
missed, the run resolves to `do-not-proceed`. Investigate gate or judge reliability
first for `inconclusive`; for `do-not-proceed`, review the metrics to identify
which quality bar failed.

The threshold constants live in `OPPORTUNITY_ENGINE_THRESHOLDS` and the quality
bar in `DEFAULT_QUALITY_BAR` within `src/eval/opportunity-engine/score.ts`.

---

## Expected cost and runtime

The default fixture has **8 labeled cases** (separable, noise, and mixed
categories). The framework guarantees:

- **≤1 gate call per case** (OpportunityEngine — the system under test)
- **≤1 judge call per scored case** (only called when the gate returned `ok`)

With `claude-cli` session-based backend (no metered tokens): **no API cost**.

With an API key backend (`LOOM_EVAL_BACKEND=sdk`):

| Budget item | Max count | Note |
|---|---|---|
| Gate calls (Haiku) | 8 | One per case |
| Judge calls (Opus 4.8) | 8 | One per case where gate succeeded |
| **Total calls** | **≤ 16** | Judge skipped on gate failure |

Typical wall-clock time: **5–15 minutes** for 8 cases processed sequentially.

To minimize API spend, leave the gate on the default Haiku model:
```bash
npm run eval:opportunity-engine
# → ≤8 Haiku gate calls + ≤8 Opus judge calls
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
Fixture:     packages/loom-core/eval-cases/opportunity-engine.yaml (8 cases)

Decision: proceed | do-not-proceed | inconclusive

Metrics:
  Total cases:              8
  Scored cases:             ?
  Gate failures:            ? (? %)
  Judge inconclusive:       ? (? %)
  Coherence:                ? %
  Score reasonableness:     ? %
  Grounding:                ? %
  Forced clustering rate:   ? %
  Hallucination rate:       ? %
```

If `decision = do-not-proceed`:
- `coherence < 80%` → Clusters are grouping unrelated signals; review the
  engine's clustering prompt or increase signal detail in the fixture.
- `scoreReasonableness < 70%` → Impact/effort/confidence scores are
  indefensible; review the scoring guidance in the persona or engine prompt.
- `grounding < 90%` → Clusters are not justified by their member signals;
  check whether `member_keys` are referenced correctly in the rationale.
- `forcedClusteringRate > 20%` → Engine is forcing unrelated signals together;
  review the engine's clustering behavior or check `force_clustering_traps` in
  the fixture cases.
- `hallucinationRate > 10%` → Engine is inventing opportunities or referencing
  non-existent signal ids; review the prompt or inspect `invented_opportunities`
  and `nonexistent_signal_ids` in the per-case JSON report.

If `decision = inconclusive`:
- Gate failure rate > 25% or judge inconclusive rate > 25% → investigate
  reliability; check LLM connectivity and try a more capable model.
- Scored cases < 3 → both of the above apply; add more cases to the fixture.

---

## Per-case output columns

The markdown report table includes:

| Column | What it shows |
|---|---|
| `Gate` | `ok` (OpportunityEngine returned clusters) or `failed` |
| `Judge` | `ok` or `inconclusive` |
| `Coherence` | Fraction of clusters grouping genuinely related signals |
| `Score Reasonableness` | Defensibility of impact/effort/confidence scores |
| `Grounding` | Fraction of clusters justified by their member signals |
| `Forced Clusters` | Count of clusters the judge identified as force-grouped |
| `Hallucinations` | `invented_opportunities + nonexistent_signal_ids` combined |

---

## Architecture reference

For a description of the framework that powers this eval (plug points,
fail-closed logic, model resolution), see
[`docs/architecture/gate-eval-framework.md`](../architecture/gate-eval-framework.md).
