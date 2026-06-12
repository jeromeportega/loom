---
title: "Issue #12 — Staff Engineer Review (SWE-bench Lite harness)"
reviewer: Claude (Opus 4.7)
date: 2026-05-23
status: reviewed
scope: "Bench harness scaffold: loader, per-task runner, predictions.json writer, `loom bench swe-bench-lite` CLI. Scoring is intentionally left to the official SWE-bench harness."
---

# Issue #12 Review — SWE-bench Lite Harness

The first external codegen benchmark wired into loom. The companion to
the planning eval (`loom eval`, grades YAML structure) and the cost
dashboard (`loom cost`, measures spend) — this measures whether loom's
end-to-end output actually resolves real GitHub issues.

## What shipped

- **`packages/loom-core/src/bench/`** — new module, separate from
  `eval/` because the shapes and intent differ.
- **`SweBenchTask`** schema matching the HuggingFace dataset row format.
  Only the four fields loom needs are required; everything else (FAIL_TO_PASS,
  PASS_TO_PASS, environment_setup_commit, version) is accepted but
  ignored — the official scorer uses them.
- **`SweBenchLoader.load(filePath, limit?)`** — accepts both a bare
  array of rows and the HF dataset-server `{rows: [{row: {...}}]}`
  wrapper. Validates every row through zod; a malformed row is a fatal
  error rather than a silent skip.
- **`SweBenchRunner.runOne(task)`** —
  1. `git clone` the repo into a temp dir.
  2. `git checkout <base_commit>`.
  3. Hand off to a `runLoom` callback (the CLI passes one that shells
     out to `loom init` + `loom epic --auto`).
  4. Capture `git diff base..HEAD`. When the per-epic PR strategy ran,
     resolve HEAD to the most recent `refs/heads/epic/*` branch instead.
- **`writePredictions(outputPath, results, modelName)`** — emits the
  official `[{instance_id, model_patch, model_name_or_path}]` shape.
  Errored tasks emit empty patches (NOT missing entries) so the harness
  sees them as unresolved rather than silently dropped.
- **`loom bench swe-bench-lite`** CLI with `--tasks`, `--limit`,
  `--output`, `--dry-run`, `--model-name`. Default limit is 10 to keep
  smoke runs cheap.
- **`docs/bench.md`** — operator runbook covering dataset download,
  run command, official scorer invocation, cost reality.

## Findings

### Medium

**1. The runner clones from `github.com/<repo>.git` with no auth.** Most
SWE-bench Lite repos are public Python projects (django, sympy,
scikit-learn) — public clone works. Repos behind auth, or repos that
have moved, require either a `~/.netrc` or a custom `cloneUrl`. Today
the override is a test seam, not a CLI option. Acceptable for v0:
SWE-bench Lite's task list is curated and all repos are public.

**2. Scoring is delegated to the official Python harness.** We do not
re-implement FAIL_TO_PASS / PASS_TO_PASS test execution. Trade-off: the
loom harness can't tell you a resolution rate without running the
external harness afterward. Upside: no Docker-per-repo orchestration
inside loom, no version drift against the SWE-bench evaluator. The
operator workflow is two-step (loom produces patches → harness scores
them), which is exactly the workflow the SWE-bench ecosystem expects.

**3. Per-task cost is honest but high.** Each task is one full
`loom epic --auto` run — planner + workers + review pass — typically
5–15 minutes on session-based auth. 300 tasks = ~1–2 days of session
capacity, OR proportional dollars on the anthropic-api backend. The
`--limit 10` default surfaces this; users who run `--limit 300`
without reading the docs deserve what they get. Documented in
`docs/bench.md` under "Cost reality."

**4. Patches captured via `git diff` may not match the official format
exactly.** SWE-bench predictions tolerate variants — the harness applies
the patch via `git apply` — but some unusual diff features (binary file
diffs, file mode changes, rename detection thresholds) may be rendered
differently than the gold patches. Acceptable for first ship: any patch
that applies and passes tests is a valid resolution.

### Low

**5. Loom bin resolution.** The CLI shells out to a `loom` binary
per task. Resolution prefers the workspace-local `loom-cli/bin/loom.js`
when running from the monorepo; falls back to `loom` on `PATH`. This
"just works" when loom is installed globally, less obvious when running
from a fresh clone. Documented in the CLI source.

**6. Predictions JSON is not streamed.** All task results accumulate in
memory and write at the end. A run that crashes 280 tasks in loses
everything. Trade-off: simpler code, matches the official harness's
expectation that predictions.json arrives atomically. If long runs
become routine, switch to per-task append-then-rewrite.

### Out of scope (filed or deferred)

- Continuous benchmark runs on CI — cost prohibitive at session-auth
  rates; matter for the project owner's CI budget, not the harness.
- Multi-IDE benchmark (running the same tasks through Cursor vs.
  Claude Code worker backends and diffing the results) — interesting
  but speculative; defer until the single-backend numbers exist.
- A `loom bench compare baseline.json current.json` helper — operators
  can diff the harness's resolution rates externally for now.

## Tests

10 new test cases; 340 total passing.

- `SweBenchLoader`: bare-array shape, HF wrapper shape, `--limit`
  honored, missing file produces a guidance error, malformed row
  throws.
- `writePredictions`: emits official shape; errored tasks still
  written with empty patches.
- `SweBenchRunner.runOne`: clones (via file:// local bare repo + a
  test fixture, no network), hands off to `runLoom`, captures diff;
  empty patch when `runLoom` errors; clone failures surface; resolves
  the most recent `epic/*` branch as HEAD when per-epic PR mode ran.

## Files changed

- `packages/loom-core/src/bench/types.ts` (new)
- `packages/loom-core/src/bench/SweBenchLoader.ts` (new)
- `packages/loom-core/src/bench/SweBenchRunner.ts` (new)
- `packages/loom-core/src/bench/index.ts` (new)
- `packages/loom-core/src/index.ts` (re-export)
- `packages/loom-core/src/__tests__/SweBench.test.ts` (new)
- `packages/loom-cli/src/commands/bench.ts` (new)
- `packages/loom-cli/src/index.ts` (registration)
- `docs/bench.md` (new — operator runbook)
