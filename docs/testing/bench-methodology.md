# Bench iteration methodology

How we use SWE-bench Lite without letting it become the target.

The goal is to improve the **system** (retrieval, planning, patch
strategy, validation) — not to optimize for the benchmark cases. If
loom's pass rate goes up because we tuned a persona to the specific
shape of HF Lite tasks, we've taught the agent to game the eval. The
gates below exist to keep the loop honest.

## The five gates

Every bench iteration moves through these in order. A run that skips a
gate is not a valid iteration — it's a data point at best.

### Gate 1 — Diagnose every failure before proposing a fix

For every task that did NOT resolve, classify it into exactly one
category:

| Category | Symptom |
|---|---|
| **context retrieval** | Worker had wrong / polluted / missing files in its context |
| **bad task decomposition** | PM produced stories that don't add up to the bug fix |
| **wrong file selection** | Worker edited adjacent files instead of the bug site |
| **compile / runtime error** | Patch applies but Python errors out before tests run |
| **test misunderstanding** | Patch fixes the user's described problem but misses the FAIL_TO_PASS test's specific assertion (the "near-miss" pattern) |
| **over-editing** | Worker touched files / behaviors beyond the bug's scope |
| **under-editing** | Worker stopped short — touched some of the bug but not all |
| **dependency / tooling** | Worker failed because of skill injection, prompt confusion, infra |
| **flaky / environment** | Same task succeeds on a re-run with identical config — true noise |

A run's failures distribute across these categories. Tracking the
distribution over iterations tells you whether you're fixing the
*system* or just whichever failure happened to be loudest.

### Gate 2 — Hypothesis-driven fixes

Before making any code change in response to a bench result, write
the hypothesis explicitly:

> "This change is expected to reduce the **X failure class** because **Y**.
> If it works, I expect the distribution of failures to shift from
> X → other categories, OR for X to drop while other categories hold."

Examples from this project:

- "`--skill-generation off` reduces **context retrieval** failures
  because candidate skills generated mid-bench were polluting later
  tasks' context."
- "`block-and-revise` reduces **test misunderstanding** failures
  because the second pass re-reads the issue against the patch."
- "Diff filter reduces **flaky / environment** false-positives because
  the scorer was applying loom-meta files; without filtering, gold
  tests could fail on apply-side noise."

A change without a hypothesis is **not** a system improvement — it
might just be eval lubricant.

### Gate 3 — Tuning set vs. holdout set

Split the 300-task suite into:

- **Tuning set** (50 tasks, fixed list) — what bench iterations run
  against. Failures here drive Gate 1 / Gate 2 hypotheses.
- **Holdout set** (50 tasks, fixed list) — *never* used to inform
  fixes. Run periodically (every 3-4 iterations or before any
  declaration of "baseline") to verify the system improved
  generally — not just on the cases we've stared at.

If the tuning rate climbs but the holdout rate doesn't move, we're
overfitting and need to back out.

The remaining 200 tasks stay reserved for a "final" measurement at
external-comparison time.

The specific task ids in each set are committed to the repo and never
edited. See `packages/loom-core/eval-cases/swe-bench-tuning.json`
and `swe-bench-holdout.json`.

### Gate 4 — Cost / runtime budget

Every iteration records:

| Metric | Why it matters |
|---|---|
| Resolution rate (tuning set) | the headline |
| Resolution rate (holdout, when run) | the overfit detector |
| Total worker tokens | cost trend per iteration |
| Total wall-clock | feedback-loop velocity |
| Mean tool-calls per task | retrieval / planning efficiency |
| Mean diff size | over-editing signal |
| Regressions | tasks that resolved before but don't now |
| New resolutions | tasks that didn't resolve before but do now |

An iteration that doubles cost for a 5pp gain is a *cost* regression
and gets weighed against the gain.

### Gate 5 — Promotion rule

A change is promoted (i.e., the new loom config / prompt becomes the
baseline for the next iteration) only if **all three** hold:

1. **Tuning rate improves or holds** (≥ previous tuning rate).
2. **Holdout rate doesn't drop** (when run).
3. **At most one regression** (a task that resolved before but
   doesn't now). Multiple regressions means we're not improving the
   system — we're trading one strength for another.

Cost cap: if total worker tokens or wall-clock more than doubles for
a sub-10pp gain, that's a separate decision the operator makes
explicitly. Default: do not promote.

## What this loop is actually optimizing

Not the resolution rate.

It's optimizing **loom's system architecture** — retrieval, planning,
patch strategy, validation behavior — and the resolution rate is the
*observable* of that. When a change moves the rate, we credit the
change only if Gate 2's hypothesis was specific and the failure
distribution shifted in the predicted way.

The thing being built is the eval flywheel, not "an agent that passes
Lite." Resolution rate is a proof point for stakeholders. The flywheel
is the actual asset.

## What this means in practice

- **No "loop until 50%" target.** The number is an outcome, not a
  goal.
- **Each iteration commits a Gate 1 classification + Gate 2
  hypothesis** to the runbook entry. Both are review artifacts.
- **Every 3-4 iterations, run the holdout set** to verify general
  improvement.
- **Bench results carry an explicit promotion decision** (promote /
  don't promote / promote with caveats).

## Out of scope for this doc

- The mechanics of how the bench is invoked — that's in
  `swe-bench-lite.md` and `swe-bench-runbook.md`.
- Per-iteration results — those land in the testing
  [runbook](runbook.md) as Run N entries.
- The holdout-set composition rationale — once the sets are defined,
  they're frozen; no narrative needed.
