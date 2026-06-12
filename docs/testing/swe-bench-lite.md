# SWE-bench Lite bench

The outermost pipeline. Runs loom end-to-end on real GitHub issues from
popular Python repos and emits patches; the official SWE-bench harness
scores them. **Measures whether loom's full pipeline produces working
code on real problems.**

This page is the *value + decision guide*. The full operator runbook
(curl commands, output paths, troubleshooting) is **[here](swe-bench-runbook.md)**.

## What it tests

The whole stack at once: planner persona prompts, worker prompt, skill
injection, review pass, per-epic PR merge, all of it. Against problems
loom has never seen and didn't help create.

```text
SWE-bench Lite task → loom epic → approve → run → workers in worktree → git diff
       ↓                                                            ↓
problem_statement                                          predictions.json
       ↓                                                            ↓
(brief)                                              official Python scorer
                                                                    ↓
                                                       resolution rate %
```

Each task is a real GitHub issue with hidden tests that should pass after
the fix. Loom doesn't see the tests; the scorer applies loom's patch
and runs them.

## When it's worth running

| Trigger | Sample size | Why |
|---|---|---|
| Before a model swap (Sonnet 4 → 5) | 10 | Catch capability shifts in worker output |
| Before a loom release | 10–30 | End-to-end regression check |
| After a planner persona change | 10 | Does the new persona produce executable plans? |
| Quarterly absolute benchmark | 100–300 | Track loom's own trajectory |

Each task takes 5–15 min of real session capacity. Defaults to `--limit 10`
to keep smoke runs cheap.

## When NOT to run it

- Per-PR CI. Cost prohibitive.
- After a unit-test-only change. The bench tests behavior the unit tests
  cover deterministically.
- To "verify Claude works." That's not what we're measuring. The bench
  measures whether **loom** correctly orchestrates Claude to produce
  working code.

## What "good" looks like

The published SWE-bench leaderboard (numbers shift with model versions):

- Random baseline: ~0%
- Vanilla Claude Sonnet 4.x with a single planning step: ~30–40%
- Specialized agent frameworks at the top: ~60–70%

Loom's hypothesis: per-epic planning + worktree-isolated workers + review
pass beats the vanilla single-step baseline. The exact margin is what we
measure when we actually run the bench.

**Important**: we use the bench to *compare runs*, not to gate at an
absolute number. A 5% resolution-rate drop run-over-run is a signal;
"only 35% absolute" is not a verdict — that's just where the model is.

## Run

The simplest path uses the bundled scripts:

```bash
./scripts/bench/run.sh --limit 10
```

That handles fetching the dataset, running loom, and scoring via `uv`.
For all the knobs (skip score, choose tasks file, output path), see the
**[SWE-bench runbook](swe-bench-runbook.md)**.

## What loom intentionally doesn't do here

- **Score patches itself.** We delegate to the official Python harness
  via `uv run --with swebench`. The harness handles Docker per repo,
  env setup, `FAIL_TO_PASS` / `PASS_TO_PASS` test execution. Loom's
  job is to produce patches in the right format; not to re-implement
  the scorer.
- **Tune for the benchmark.** Loom runs on a SWE-bench task with the
  same policy, skills, and persona prompts as on your real work. No
  bench-specific code paths.
- **Hide failures.** Tasks where loom errored before producing a
  patch are emitted with an empty `model_patch` rather than dropped —
  so the harness sees them as unresolved, not missing.

## Interpreting predictions before scoring

The Python scorer needs Docker and ~1–4 hr for 300 tasks. You don't
have to wait for it to see if loom produced anything useful:

```bash
./scripts/bench/inspect.sh ~/loom-bench/predictions-<TIMESTAMP>.json
```

Output:

```
  total predictions: 10
  non-empty patches: 7
  empty patches:     3

  per-task summary:
    ✓ astropy__astropy-6938   (1245 bytes)
    ✓ astropy__astropy-7746   (892 bytes)
    – astropy__astropy-12907  (empty)
    ...
```

A 7/10 non-empty rate means loom orchestration completed for 7 tasks —
the worker dispatched, made commits, the diff was captured. Whether
those 7 patches *resolve the tests* is what the harness measures next.

A high empty-rate is a loom bug signal: workers timed out, the clone
failed, the planner crashed — all loom concerns, not LLM concerns.

## When the bench result moves but the unit tests don't

Both pipelines should track each other on most changes. When they
diverge:

- **Unit tests green, bench drops** → a loom change affected real-world
  behavior in a way the mocks don't simulate. Worker prompt template
  changes are a common cause; review-pass interaction loops too.
- **Unit tests broken, bench stable** → narrow bug in a code path the
  bench doesn't exercise (CLI tooling, status printer, MCP handler).
  Fix the unit tests; the bench is fine.

The pipelines complement each other; neither replaces the other.

## See also

- **[Testing philosophy](index.md)** — why each pipeline exists.
- **[SWE-bench operator runbook](swe-bench-runbook.md)** — dataset
  download, exact commands, troubleshooting.
