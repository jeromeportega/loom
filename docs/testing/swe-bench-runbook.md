# Loom benchmarks

External codegen benchmarks loom runs against. These are the *quality*
counterpart to `node scripts/eval.mjs` (which grades planning structure).

## SWE-bench Lite (issue #12)

300 real GitHub issues from popular Python repos. Each task includes a
base commit and a set of tests that should pass after the fix is applied.
Loom runs end-to-end per task; the official harness scores the patches.

### One-time setup

1. Download the dataset from HuggingFace as JSON. The dataset-server
   `rows` shape and a bare JSON array of rows are both accepted:

   ```bash
   curl -sL "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test&offset=0&length=300" \
     > swe-bench-lite.json
   ```

2. Install the official harness for scoring (optional — only needed when
   you want to convert patches into a resolution rate):

   ```bash
   pip install swebench
   ```

### Run

```bash
# Smoke test on 1 task — verify the loop works end-to-end before going wide.
loom-bench swe-bench-lite --tasks swe-bench-lite.json --limit 1

# 10-task batch — typical iteration size during persona / prompt tuning.
loom-bench swe-bench-lite --tasks swe-bench-lite.json --limit 10 --output runs/$(date +%Y%m%d)-predictions.json

# Full benchmark — opt-in, eats ~1–2 days of session capacity.
loom-bench swe-bench-lite --tasks swe-bench-lite.json --limit 300
```

The runner clones each repo to a temp dir, checks out the base commit,
then chains `loom init` + `loom epic` + `loom approve` + `loom run` per
task and captures the resulting diff. Predictions land in
`predictions.json` in the format the official harness consumes.

### Score

```bash
# Recommended: ephemeral env, no install. Requires `uv` (brew install uv).
uv run --with swebench python -m swebench.harness.run_evaluation \
  --predictions_path predictions.json \
  --max_workers 4 \
  --run_id loom-$(date +%Y%m%d-%H%M%S)
```

The `--run_id` is required by the harness and labels the results directory
it creates (`logs/run_evaluation/<run_id>/`). Use a timestamp so successive
runs don't collide.

The harness sets up the per-repo Python environment in Docker, applies
the patch, runs the FAIL_TO_PASS and PASS_TO_PASS tests, and reports a
resolution rate.

### What "good" looks like

For reference (numbers shift with model versions; check the SWE-bench
leaderboard):

- Random baseline: ~0%
- Vanilla Claude Sonnet 4.x with a single planning step: ~30–40%
- Specialized agent frameworks at the top of the leaderboard: ~60–70%

Loom's hypothesis: per-epic planning + worktree-isolated workers +
review pass should beat the vanilla single-step number by a margin. We
don't know by how much yet — that's what the harness is for.

### Use as a regression gate

Persona / prompt / model changes that shift `node scripts/eval.mjs` planning score
also shift this benchmark. A typical iteration:

1. Capture baseline: `loom-bench swe-bench-lite --limit 30 --output baselines/main-$(date +%Y%m%d).json`
2. Make the change (persona edit, model swap, skill toggle).
3. Re-run: `loom-bench swe-bench-lite --limit 30 --output runs/<change>.json`
4. Diff resolution rates from the two harness runs.

### Cost reality

Each task = one full loom run (planner + worker(s)) ≈ 5–15 minutes on
session-based auth. 300 tasks ≈ 1–2 days of session capacity. Default
`--limit 10` keeps smoke runs cheap.

### Limitations

- The runner clones from `github.com/<repo>.git`. Tasks that reference
  repos behind auth need a custom `cloneUrl` (today: only via test seam).
- The harness deliberately does NOT score patches inside loom. The
  official SWE-bench evaluator already handles per-repo Docker setup +
  test execution; replicating that in TS would be wasted effort.
- Loom runs unchanged: same skills, same review pass, same per-epic PR
  strategy. The benchmark measures loom AS IT WOULD BE USED, not a
  benchmark-tuned variant.

### Out of scope (filed elsewhere)

- Comparison-to-baseline diffing inside loom (operator handles via
  the harness output today).
- Continuous benchmark runs on CI (cost prohibitive at session-auth
  rates).
