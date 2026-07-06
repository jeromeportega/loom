# Loom Testing Runbook

This guide walks through how to verify each epic as it's delivered. It has two layers:

- **Automated tests** — run via `npm test`; these run on every change.
- **Manual verification** — terminal commands you run by hand to confirm features work end-to-end and to get a feel for how the system behaves.

---

## Quick start

```bash
# From the repo root, after a clean clone:
npm install
npm run build
npm test        # runs all package tests
```

Expected: every workspace test suite (`@loom-ai/core`, `@loom-ai/mcp`, `loom-ai`, `@loom-ai/web`) passes. The exact count drifts as suites grow; the contract is that the full suite is green on `main`.

## Latest `npm run eval` result

**Score: 2/6 (33%)** — Sonnet 4.6 via `claude-cli`, run after the Cost-aware /
Epic 17 / Epic 18 foundation work landed.

| Case | Result | Detail |
|---|---|---|
| `single-feature-cli` | FAIL | 4 epics (expected ≤1), 17 stories (expected ≤8) |
| `rest-api-endpoint` | PASS | — |
| `bugfix-small` | PASS | — |
| `auth-feature` | FAIL | 5 epics (expected ≤2), 23 stories (expected ≤10) |
| `data-pipeline` | FAIL | 6 epics, 26 stories |
| `refactor-scoped` | FAIL | 4 epics (expected ≤1), 18 stories (expected ≤5) |

**Regression signal.** The planner is **over-planning** — producing several
epics and many more stories than the briefs warrant, especially for narrow
work (a refactor, a single CLI feature). The two passes are the cases that
naturally span multiple stories (REST endpoint, bug-fix with regression
test).

**Most likely cause: skill auto-injection into the Analyst** (landed in commit
`2474a40`). The Analyst now sees `loom-brainstorm`, `loom-edge-case-review`,
`loom-plan-review`, and `loom-ux-design` skill bodies as "reference
practices," which push the brief toward thorough state inventory and option
generation. A thorough brief becomes a wider PRD becomes more stories. The
intention was right ("senior judgment on every task"); the dosage is wrong
for small briefs.

**Candidate fixes to investigate** (none built yet):

1. **Lower the planner's skill-injection limit.** `SkillSelector.selectByText`
   passes `limit = 4` from the planner today; dropping to 2 (or 0 for small
   briefs) would dial back the breadth-pressure.
2. **Per-skill `inject_in_planner: bool` flag.** Skills like
   `loom-edge-case-review` are review-time skills; injecting them at
   planning time amplifies scope. Add a metadata field so worker-time skills
   stay worker-only.
3. **Scope-aware skill selection.** The Analyst could see *fewer* skills for
   a short brief and *more* for a multi-page one. SkillSelector keyword match
   doesn't know brief length today.
4. **Re-run the eval with skills disabled** to confirm causation before
   spending time on the fix. Set `skillStore: undefined` in the eval's
   Planner construction temporarily.

The previous baseline (pre-skill-injection) was last measured during Epic 7;
not preserved in repo. Recommend running the eval against a known-good
revision (e.g. checkout `437d2d4` — Epic 13 commit, before skill injection)
to confirm the regression.

### Run 2 — same suite, *after* planner skill injection was removed

**Score: 2/6 (33%) — unchanged from Run 1.**

| Case | Run 1 (skills injected) | Run 2 (skills removed) | Delta |
|---|---|---|---|
| `single-feature-cli` | FAIL: 4 epics / 17 stories | FAIL: 3 epics / 12 stories | better |
| `rest-api-endpoint` | PASS | PASS | — |
| `bugfix-small` | PASS | PASS | — |
| `auth-feature` | FAIL: 5 / 23 | FAIL: 6 / 26 | worse |
| `data-pipeline` | FAIL: 6 / 26 | FAIL: 6 / 22 | mixed |
| `refactor-scoped` | FAIL: 4 / 18 | FAIL: 6 / 20 | worse |

**The fix was not the singular cause.** Skill injection was contributing to
over-planning — `single-feature-cli` improved meaningfully and
`data-pipeline` shrank a bit — but two cases got *worse* and the overall
score didn't move. Two competing explanations remain:

1. **Persona prompts push toward exhaustive decomposition.** The PM
   (`personas/pm.md`) and Architect (`personas/architect.md`) prompts may
   encourage more epics/stories than the briefs warrant. Audit the prompts
   for "be thorough" / "consider all" framing.
2. **Stochasticity is dominating a small sample.** Sonnet 4.6 without a
   pinned temperature can produce 3–6 epics on the same brief across runs.
   A single 6-case run is too small to trust as a baseline.

**Next investigations** (none scheduled yet):

- **Persona prompt audit** — read the three planner personas with the eval
  failures in mind, look for thoroughness pressure.
- **Multi-run baseline** — run the eval 3 times against the current main
  and compute mean + variance. If variance is large (±2 epics per case),
  stochasticity is dominating and we need stricter prompts or temperature
  pinning, not "fixes" against a noisy signal.
- **Bisect against history** — run the eval against `437d2d4` (pre-skill-
  injection) to confirm whether *some* prior revision did score better, or
  if the cases were always borderline.

The architectural move — planner injection off, chat-client-as-curator on
— stays either way. It is the right separation of concerns; the eval just
told us it is not by itself the fix for whatever the planner is currently
doing.

### Run 3 — after PM persona tightening {#run-3}

**Score: 6/6 (100%).** The over-planning regression is resolved.

| Case | Run 2 | Run 3 |
|---|---|---|
| `single-feature-cli` | FAIL: 3 / 12 | PASS |
| `rest-api-endpoint` | PASS | PASS |
| `bugfix-small` | PASS | PASS |
| `auth-feature` | FAIL: 6 / 26 | PASS |
| `data-pipeline` | FAIL: 6 / 22 | PASS |
| `refactor-scoped` | FAIL: 6 / 20 | PASS |

**Root cause.** Two structural pressures in `personas/pm.md` were overriding
the explicit "ONE epic typical" rule:

1. **The PRD task (Task A) had no FR/NFR bounds.** "Functional Requirements
   — numbered FR-1, FR-2, ..." with no upper bound let the model produce
   12–15 FRs for a one-paragraph brief by inventing error-handling,
   pagination, accessibility, and observability requirements. A bloated
   PRD then biased Task B toward many epics.
2. **The Task B rules were too soft.** "Prefer 3–8 stories per epic" and
   "A typical feature brief is ONE epic" used permissive language ("Prefer",
   "typical") that the model overrode in favor of thoroughness. Task B also
   received the PRD as its largest, most-recent context, biasing it toward
   the PRD's verbosity rather than the brief's actual scope.

**Fix.**

- Added a new Principle: **"Default to ONE epic"** with explicit examples
  (CLI tools, refactors, bug fixes, single-API additions are ALL ONE epic).
- Added a new Principle: **"The brief is the source of scope truth"** —
  Task B must re-read the brief, not just the PRD, when deciding epic count.
- Task A now says **"Size the PRD to the brief"** — explicit anti-padding
  rule, FR count guidance ("~3–7 for a one-paragraph brief, not 15"), and
  permission to skip Goals/Stories/NFR sections that don't earn their place.
- Task B rule changed from "Prefer 3–8 stories" to "Aim for 3–6; 8+ means
  over-decomposing"; "typical = ONE epic" replaced with explicit DEFAULT
  framing plus "producing 3+ epics for a one-paragraph brief is a bug,
  not thoroughness."

Diff: `packages/loom-core/personas/pm.md` only — Analyst and Architect
unchanged. The Analyst already had "Right-size to purpose"; the Architect
doesn't decide epic count.

**Caveat.** This is a single-run baseline. The Run 2 → Run 3 jump is
unambiguous (2 → 6 passes) but a few cases were borderline; future eval
expansion should add `multi-feature-platform` and `single-line-bugfix` to
stress the boundaries, and we should pin temperature once `claude-cli`
exposes that knob to reduce run-to-run variance.

### Runs 4 / 5 — post-session validation (skill visibility, review pass, cost tracking, image plumbing, SWE-bench harness) {#run-4-vs-run-5}

After shipping issues #4, #6, #5, #8, and #12 in one session, re-ran the
planning eval to confirm no regression in the planning pipeline.

| Run | Score | Notes |
|---|---|---|
| 4 | 5/6 (83%) | `rest-api-endpoint` timed out at 600s on a single LLM call. |
| 5 | 6/6 (100%) | Same suite, same code; `rest-api-endpoint` passes. |

The timeout in Run 4 is **stochastic CLI latency, not a content
regression** — Run 5 against the unchanged code passed all six cases.
The case has historically passed in every other run (Runs 1, 2, 3, 5).

The session's changes that *could* affect planning — the `--output-format
stream-json` switch on the worker, new schema columns, the cost-tracking
spine, image plumbing — touch the worker path and DB columns; they do
NOT touch the planner LLM client. The planner runs the same code path
as Run 3, so 6/6 is the expected baseline.

**Action item if Run 4-style timeouts recur:** raise
`ClaudeCliClient.DEFAULT_TIMEOUT_MS` from 10 min to 15 min and / or add
a one-retry pass at the eval level so a single transient timeout
doesn't fail an otherwise-good run. Not worth fixing on a 1-in-2 sample.

### Run 6 — first SWE-bench Lite bench, 10 tasks (issue #12) {#run-6}

The first real end-to-end bench. 10 tasks from the SWE-bench Lite test
split (the first 10 alphabetically: 6 astropy, 4 django). Backend:
`claude-cli`. Concurrency: default 3 workers / epic. No scoring yet —
this run was the harness validation; scoring requires Docker via the
official SWE-bench Python harness.

**Result: 7 of 10 produced patches; 3 errored before loom could
write a patch.**

| Task | Outcome | Stories done | Diff size | Wall-clock |
|---|---|---|---|---|
| astropy-12907 | ✓ patch | 4/4 | 44 KB | 30 min |
| astropy-14182 | ✓ patch | 4/4 | 60 KB | 66 min |
| astropy-14365 | ✓ patch | 4/4 | 45 KB | 36 min |
| astropy-14995 | ✓ patch | 4/4 | 56 KB | 41 min |
| astropy-6938  | ✓ patch | 3/3 | 30 KB | 27 min |
| astropy-7746  | ✓ patch | 3/3 | 39 KB | 35 min |
| django-10914  | ✓ patch | 4/4 | 47 KB | 30 min |
| django-10924  | – empty | — (planning failed) | 0 | <5 min |
| django-11001  | – empty | — (planning failed) | 0 | <5 min |
| django-11019  | – empty | 1 done, 1 failed, 3 blocked | 0 | <varies> |

Total wall-clock: ~5 hours for the 7 successful tasks.

**Loom-side bugs found and fixed (commit `8908020`):**

1. **Diff contamination.** Every successful patch contained 4 noise
   files from `.loom_outputs/<epic>/` plus ad-hoc worker scratch
   under `.loom/` and `.loom-notes/`. The 30–60 KB diff sizes are
   ~70% noise; the actual application change is small. Fix: pathspec
   exclusion in `SweBenchRunner.captureDiff` for loom-internal
   directories (`.loom`, `.loom_outputs`, `.loom-notes`, `.claude`,
   `.mcp.json`, `.cursor`, `CLAUDE.md`).
2. **No retry on transient API errors.** `django-10924` and
   `django-11001` both failed because Anthropic returned 529 Overloaded
   on the planner's LLM call — a transient server-side error. Fix:
   `ClaudeCliClient.complete` now retries on 408/429/500/502/503/504/529
   with 1s/2s/4s backoff, up to 3 retries.

**Observations worth noting (not fixed in this pass):**

- **Worker scratch files at the repo root.** One task wrote a top-level
  `ROOT_CAUSE.md`; another wrote `QDP_COMMAND_CLASSIFICATION_AUDIT.md`.
  These aren't under any loom-meta dir, so the diff filter doesn't
  catch them. They're not in scope for the bench — workers should be
  told to keep scratch under `.loom/` or not write it at all.
  Candidate for a worker-prompt tightening pass.
- **`django-11019` partial success.** Planning succeeded with 5 stories.
  Story-001-001 made a commit; story-001-002 "exited 1 and made no
  commits"; stories 003–005 got blocked on the failed dep. No clear
  cause from the log — the temp dir is gone, audit log with it.
  If this recurs, surface the worker stderr more aggressively or
  preserve worktrees on failure for post-mortem.
- **Self-learning fired during the bench.** Three skills generated as
  candidates: `loom-testing-prebuilt-overlay`, `loom-audit-existing-code`,
  `loom-regression-root-cause`. One canary-injected into a later
  story in the same run. The skill loop is doing its job under load.

**Caveats and what would need to change before treating this as a
quality baseline:**

- **Scoring not yet run.** The Python harness via `uv run --with
  swebench …` was not invoked. The 7 patches are real; whether they
  resolve the gold tests is the next question. The contamination fix
  makes future runs' patches cleaner but does not affect the application
  code in this run, so scoring this batch would still be valid — just
  with extra non-test files that the harness will apply and ignore.
- **Diff size is misleading right now.** The 30–60 KB figures include
  the meta-files; the real application change is ~3–10 KB per task,
  closer to (but still larger than) SWE-bench gold patches.
- **Single-run sample.** No claim about absolute resolution rate from
  a 10-task batch. The Run 6 numbers are a "the pipeline works
  end-to-end" signal, not a quality measurement.

**Action items recorded:**

- [x] Filter loom-meta from captured diffs (committed `8908020`)
- [x] Retry transient Anthropic API errors at the LLM-client layer (committed `8908020`)
- [x] Tighten worker prompt to keep scratch under `.loom/` (committed `5f69272`)
- [ ] Preserve worktrees on worker failure for post-mortem (open — needs CLI flag)

### Run 6 — scoring (official SWE-bench harness) {#run-6-scored}

Scored on 2026-05-25 via `uv run --with swebench python -m
swebench.harness.run_evaluation --run_id loom-run6-20260525-072924`.
~4 minutes for the 7 non-empty patches (Docker-per-task setup +
test execution).

**Headline:**

| Metric | Value |
|---|---|
| Resolution rate (of 10 attempted) | **4 / 10 = 40%** |
| Resolution rate (of 7 with patches) | **4 / 7 = 57%** |
| Resolution rate (of 7 evaluated by harness) | 4 / 7 = 57% |
| Empty patches | 3 / 10 |
| Harness errors | 0 |

**Per-task outcomes:**

| Task | Result | Notes |
|---|---|---|
| astropy-12907 | ✓ resolved | Modeling `separable` bug |
| astropy-6938  | ✓ resolved | `D` exponent in FITS write |
| astropy-14995 | ✓ resolved | `nddata.NDArithmeticMixin` mask propagation |
| django-10914  | ✓ resolved | `FILE_UPLOAD_PERMISSION` default |
| astropy-14182 | ✗ unresolved | `io.ascii.RST` header row support — patch produced, gold tests didn't pass |
| astropy-14365 | ✗ unresolved | QDP comment parsing — patch produced, gold tests didn't pass |
| astropy-7746  | ✗ unresolved | WCS empty list inputs — patch produced, gold tests didn't pass |
| django-10924  | – empty | Anthropic API 529 (planner) |
| django-11001  | – empty | Anthropic API 529 (planner) |
| django-11019  | – empty | Worker exit-1 mid-run |

**Context (numbers from the public SWE-bench leaderboard at the time
of this run; they shift with model versions):**

- Random baseline: ~0%
- Vanilla Claude Sonnet 4.x, single planning step: ~30–40%
- Specialized agent frameworks at the top: ~60–70%

Loom's first end-to-end measured run is **in the band of vanilla
single-step Claude**. Real signal but not yet competitive with the
specialized agent frameworks. Expected for a first run, no
benchmark-specific tuning, no review/revise loop wired into the
bench, planner-LLM not retrying its 529s (now fixed).

**What this tells us about where loom is leaving quality on the
table — observations, not yet actions:**

- 3 of 10 (30%) of the misses are loom-side reliability, not patch
  quality. The 529 retry (`8908020`) should rescue 2 of those next run.
  django-11019's worker-exit-1 remains the long-tail mystery.
- The 3 unresolved patches all *did something*. To know whether they
  were close (one test off) or wide (whole approach wrong) needs
  reading the per-task `report.json` produced by the harness — a
  thread for the next iteration.
- The 4 resolved cases were all "localized correctness bugs in a
  single function." The unresolved cases involved parser changes (RST,
  QDP) and an edge-case in WCS. Hypothesis: loom's worker over-engineers
  on parser changes (writes extra abstractions, breaks gold tests).
  Verify when Run 7 lands.

**Action items from scoring:**

- [x] Read the per-task `report.json` for the 3 unresolved cases to
  classify "near miss" vs "wrong approach." **All three are near-misses
  — patches apply cleanly, all PASS_TO_PASS tests still pass, exactly
  one FAIL_TO_PASS test missed per task.** Loom touched the right area
  and wrote safe code; it implemented a slightly different interpretation
  of the issue than the hidden gold test asserts.
- [ ] Compare resolution rate after Run 7 (with the diff filter and
  the worker prompt fix) — if the rate moves notably, we know the
  meta-file noise was distorting the gold-test evaluation.
- [ ] Consider re-running with `review_strategy: 'block-and-revise'`
  enabled. The bench did not exercise the review/revise loop —
  exactly the value-prop layer that should catch near-misses like
  these. A second pass asking "does this actually fix what the issue
  describes?" is the natural lever for this failure mode.

### Failure classification (Gate 1, applied retroactively)

Per the [bench methodology](bench-methodology.md), every failed task
gets classified before driving fixes. Applying the framework to Runs
6 + 7:

| Task | Run 6 | Run 7 | Category | Reading |
|---|---|---|---|---|
| astropy-14182 | ✗ | ✗ | **test misunderstanding** | patch applied; FAIL_TO_PASS missed by one specific assertion |
| astropy-14365 | ✗ | ✗ | **test misunderstanding** | same — near-miss pattern, one assertion off |
| astropy-7746  | ✗ | – | Run 6: **test misunderstanding**; Run 7: **dependency / tooling** | patch in 6 was near-miss; in 7 worker timed out under skill-injection load |
| astropy-14995 | ✓ | – | Run 7 regression: **dependency / tooling** | candidate skill from prior task canary-injected → worker no-commits |
| astropy-6938  | ✓ | – | Run 7 regression: **dependency / tooling** | same pattern |
| django-10924  | – | ✗ | Run 6: **flaky / environment** (API 529); Run 7: **test misunderstanding** | retry rescued the produce step; patch is near-miss |
| django-11001  | – | ✓ | Run 6: **flaky / environment** (API 529); Run 7: resolved | retry rescued it AND patch was right |
| django-11019  | – | – | **under-editing** | worker exited 1 with no commits across both runs — same task each time |

**Distribution across runs 6 + 7:**

| Category | Run 6 | Run 7 | Notes |
|---|---|---|---|
| test misunderstanding (near-miss) | 3 | 3 | persistent — needs `block-and-revise` |
| dependency / tooling | 0 | 3 | NEW in 7 — caused by candidate-skill cross-contamination |
| flaky / environment | 2 | 0 | 529-retry fixed this category cleanly |
| under-editing | 1 | 1 | django-11019 specifically; one task, isolated failure mode |

**Read:** the diff filter + 529 retry eliminated one failure category
(flaky / environment) — that's a real system improvement. The worker
prompt + skill-on-by-default introduced a different failure category
(dependency / tooling) — a system regression. Net: we traded.

The Run 8 intervention is hypothesis-driven (Gate 2):

- **`--skill-generation off` + cleared cache**: targets *dependency
  / tooling*. Hypothesis: eliminating cross-task candidate-skill
  injection brings those 3 regressed astropy tasks back to producing
  patches.
- **`--review-strategy block-and-revise`**: targets *test
  misunderstanding*. Hypothesis: a second pass re-reading the issue
  against the patch catches near-misses before commit.

If both work as predicted, the failure distribution should shift
toward "(empty) → resolved" for the 3 dep/tooling regressions, and
"unresolved (near-miss) → resolved" for 1-2 of the test-misunderstanding
cases. If they don't, the hypothesis is wrong — re-classify rather
than patch blindly.

### Holdout slice — Gate 3 validation (anti-overfit check) {#holdout-1}

**Score: 5/10 resolved (50%), 5/10 (50%) on produced patches —
identical to Run 8's tuning rate.**

10 tasks from `swe-bench-holdout.json` (a frozen 50-task subset
of SWE-bench Lite that has **never** been iterated against). Same
config as Run 8: `--skill-generation off --review-strategy
block-and-revise`. Skill cache pre-cleared.

| | Run 8 (tuning) | Holdout |
|---|---|---|
| Produced patches | 9/10 | **10/10** |
| Resolved | 5/10 | 5/10 |
| Resolution rate (attempted) | 50% | **50%** |
| Empty patches | 1 (harness limit) | **0** |
| Mean diff size | 11 KB | 12 KB |

**Per-task holdout:**

| Resolved | Unresolved |
|---|---|
| astropy-14995 | django-11019 |
| django-12286 | django-11283 |
| django-12700 | django-11742 |
| django-12983 | django-11964 |
| django-13265 | django-13551 |

Note: astropy-14995 RESOLVED here — it was the unresolved case from
Run 8's tuning side. Single-task variance is real; the system's *rate*
is stable.

**Gate 3 verdict: PASS.** The 50% rate generalizes to tasks the
iteration loop never saw. The interventions (skill-gen off,
block-and-revise) are improving the **system**, not the specific
tasks we kept staring at.

### Promotion verdict — Run 8 + holdout {#promotion-1}

Per [bench methodology](bench-methodology.md) Gate 5:

| Gate | Pass? | Evidence |
|---|---|---|
| 5.1 — Tuning rate improves | ✓ | 4 → 3 → 5 across Runs 6/7/8 |
| 5.2 — Holdout doesn't drop | ✓ | 5/10 holdout = 5/10 tuning (exact match) |
| 5.3 — ≤1 regression | ✓ | one (django-11001, planning stochasticity + harness limit; not system degradation) |

**The new baseline is promoted.** The validated bench configuration:

```
--skill-generation off
--review-strategy block-and-revise
+ cleared ~/.loom/skills/generated/ before each bench
```

Plus the system-level fixes from earlier commits (now permanent baseline):
- diff filter on captured patches (`8908020`)
- Anthropic 529 retry in `ClaudeCliClient` (`8908020`)
- worker prompt's `Scratch, probes, and investigation notes` section (`5f69272`)
- decision-trace capture for worker thinking blocks (`463fa91`)

**Final baseline: loom resolves 50% of SWE-bench Lite tasks on first
attempt** (range ~30–60% over short runs due to planning stochasticity),
with patches that scope cleanly to application code (no
loom-internal meta-files), without cross-task skill pollution, and
with the review/revise loop catching ~2 of 3 near-miss patches.

**Loom sits in the band of vanilla single-step Claude (~30–40%)
once + the review loop gain (~10–20pp).** The "specialized agent
framework" band (~60–70%) remains the next-target gap. Closing it
needs either:
- per-repo learned review skills (Epic 19 — closed but not implemented)
- cross-model review ensemble (different model writes vs. reviews)
- diff-first worker prompts (Epic 16 context spine — open as Issue #10)

These are the next intervention candidates — to be selected when
there's a Gate 1 reason from a future run.

### Run 10a — cross-model review wiring failure (Gate 1 forensic) {#run-10a}

**Status:** completed 2026-05-26 ~20:31 UTC. **Result is a wiring
failure, not a measurement** — re-probe is Run 10b below.

**What happened:** kicked off a 1-task probe against astropy-14182
with `--review-model cross --review-model-id claude-opus-4-7`. The
harness reported `✖ unresolved` (one instance, non-empty patch).
The preserved tempdir tells a different story:

- `story-001-001` exited with `Worker threw: cursor-agent exited 1:
  Cannot use this model: claude-opus-4-7. Available models: auto,
  composer-2-fast, composer-2, gpt-5.3-codex-low, ...`
- Stories 001-002 through 001-005 cascade-blocked on the dependency.
- The "non-empty patch" the harness scored was a partial-epic
  capture from the worker's pre-reviewer commits.

**Root cause:** Cursor model ids carry a reasoning-tier suffix.
`cursor-agent --list-models` shows the real ids:
`claude-opus-4-7-medium`, `claude-opus-4-7-high`, `claude-opus-4-7-low`,
etc. Bare `claude-opus-4-7` doesn't exist. The standing rule
[[feedback-cross-model-review-cursor-only]] specifies "no MAX mode,
always target a specific Claude model id" — needs amending to
require the tier suffix.

**Secondary finding (worth filing as its own issue):** a reviewer
failure cascade-fails the worker. The reviewer is downstream of the
worker's commits; a reviewer crash should LEAVE the worker's work
on the branch and continue (degrade to comment-mode review), not
mark the story failed and block downstream stories. Filed below.

**No measurement of the intervention itself is possible from this
run** — the reviewer never produced a verdict.

### Run 10b — cross-model review re-probe with correct Cursor model id {#run-10b}

**Result: ✖ unresolved, 7-commit / 11KB patch in 35 min. The
intervention is doing real work; the pipeline isn't acting on it.**

Cross-model review (Opus 4.7 medium reviewing Sonnet's worker
output) produced qualitatively different review content than what
same-model review would produce. Story-001-001's Opus reviewer:

- Cited specific line numbers (`fixedwidth.py:281-290`)
- Confirmed behavior preservation with a concrete derivation
  ("byte-identical: idx resolves to 1, matching the original
  lines[1] index for the position rule")
- **Flagged a real near-miss correctness concern:** *"One real
  concern: the new kwarg silently flows through to the read path,
  which is not actually updated."*

That's exactly the kind of defect that would cause hidden
FAIL_TO_PASS tests to fail — if the bug fix needs to update both
write AND read paths, and the worker only changed write, the read
path's tests stay red.

**The pipeline didn't act on the finding.** The Opus concern was
logged as `review_status: passed` (comment-level severity) and
block-and-revise only triggers on blockers, so no revision ran.
The incomplete implementation shipped to the harness as-is.

**This rewrites the interpretation matrix.** "Cross-model review
identifies better defects" is now established; the question is no
longer about the reviewer. The question is:

| New question | Hypothesis |
|---|---|
| Does same-model review miss this same defect on the same task? | Almost certainly yes — Sonnet self-reviewing its own work is the case Run 8 measured, where this task was also a near-miss. The Run 10c A/B probe verifies. |
| Why didn't the Opus reviewer escalate this to blocker severity? | Either the reviewer's severity prompt under-weights correctness concerns the worker would have caught, or "the kwarg flows through unchanged" reads as "intentional pass-through" to the LLM unless the test surface is in context. |
| Should block-and-revise escalate severity-comment correctness flags to blocker-equivalent? | Worth measuring. Could be a follow-up intervention: severity-promotion policy knob OR change block-and-revise to trigger on any non-empty findings. |

**Next probe (Run 10c, kicking off):** same task, same config,
EXCEPT `--review-model same`. Direct A/B. Confirms the review-content
delta is real and rules out "Opus would have flagged this even at
default review_model=same."

**Saved forensics:** `/var/folders/lt/_cgqf75s45g0_sc707r_5djw0000gp/T/loom-swe-AE0LuT/`
preserved by `--preserve-all`.

### Run 10c — same-model A/B baseline at astropy-14182 {#run-10c}

**Result: ✖ unresolved, 7-commit / 8.9 KB patch in ~37 min.**

Same task, same other config as Run 10b, EXCEPT `review_model=same`
(Sonnet reviewing Sonnet's work — the bench baseline default).

**Reviewer output, all 3 stories: `"Review produced no summary."`**

That's the BaseCliWorker fallback string for a review that returned
an empty findings array. Same-model Sonnet self-review found
*nothing* worth flagging on any of the 3 stories. Zero blocker,
zero comment, zero nit.

**Direct A/B comparison vs Run 10b:**

| Metric | Run 10b (cross, Opus) | Run 10c (same, Sonnet) |
|---|---|---|
| Harness verdict | ✖ unresolved | ✖ unresolved |
| Diff size | 11.0 KB | 8.9 KB |
| Story-001-001 review | 789-char substantive review with `fixedwidth.py:281-290` cite + a real correctness near-miss flagged ("the new kwarg silently flows through to the read path, which is not actually updated") | empty findings — "Review produced no summary." |
| Story-001-002 review | 400-char analytical verification | empty findings |
| Story-001-003 review | 400-char doc-format verification | empty findings |
| Revisions triggered | 0 (finding was comment, not blocker) | 0 (no findings at all) |

**Verdict: cross-model review IS the right intervention.** It
identifies defects same-model misses entirely. The bottleneck
remains the block-and-revise pipeline not acting on comment-severity
findings — the `review_revise_trigger='any'` knob shipped in
`ecc5c28` is the lever that closes the loop.

**Preserved tempdir:** `/var/folders/lt/_cgqf75s45g0_sc707r_5djw0000gp/T/loom-swe-R7uIRO/`.

### Run 10d — combined intervention RESOLVES astropy-14182 {#run-10d}

**Result: ✓ RESOLVED.** First time this task has flipped to ✓ in
any loom-bench run (Runs 6, 7, 8 + targeted reproductions + Runs
10a/b/c: all ✗ near-miss). 9 commits / 9.3 KB diff in 47 minutes.

Config:

```
--review-model cross --review-model-id claude-opus-4-7-medium \
--review-revise-trigger any
```

The prediction held: Opus identifies real defects → block-and-revise
triggers on comment-severity findings (new behavior) → worker
revises → hidden FAIL_TO_PASS tests flip green.

**Reviewer output across all 5 stories (vs 0 findings in Run 10c
same-model):**

- story-001-001 (spike): passed with 436-char "empty diff — this
  was an investigation, no code to review" rationale. Opus correctly
  identified the story shape.
- story-001-002 (write side): commented (400 chars, truncated in
  the snapshot). This is the story that the revise-on-any trigger
  acted on.
- story-001-003 (read side): passed with 528-char review confirming
  the read-path plumbing is correct + a real concern about a dtype
  round-trip test ("does not actually verify dtype metadata
  round-trips — it only asserts the parsed data is floating point").
- story-001-004: passed (empty findings — "Review produced no
  summary.")
- story-001-005: passed with 456-char review.

The planner produced 5 stories this time (vs 3 in Runs 10b/10c).
Single-data-point caveat: planning stochasticity may have helped —
need 3-task to disambiguate.

**Single-data-point signal, NOT a Gate 3 promotion.** Per the
frugal-bench playbook:

1. ✓ 1-task sanity: confirms behavior changes (DONE — this probe).
2. **Next: 3-task probe** across the test-misunderstanding cluster
   (astropy-14182 + astropy-7746 + astropy-14995). Reusing the
   preserved tempdirs from earlier runs makes the diff comparison
   easy. Predicted: at least one more flip (most likely
   astropy-14995, the other near-miss).
3. If 3-task holds, 10-task tuning for Gate 3 against Run 8 baseline.
4. If tuning passes the promote rule, 10-task holdout for Gate 3
   verification.

**Preserved tempdir:** `/var/folders/lt/_cgqf75s45g0_sc707r_5djw0000gp/T/loom-swe-hWDavW/`.

### Run 10f — 10-task tuning of cross-model alone (REJECTED, Gate 3 fail) {#run-10f}

**Result: 4/10 resolved. Net −1 vs Run 8 baseline. 2 regressions.**

Per-task vs Run 8:

| Task | Run 8 | Run 10f | Δ |
|---|---|---|---|
| astropy-12907 | ✓ | ✓ | held |
| astropy-14182 | ✗ | ✗ | held |
| astropy-14365 | ✓ | ✗ | **REGRESSED** |
| astropy-14995 | – empty | – empty | held |
| astropy-6938 | ✓ | – empty | **REGRESSED to empty** |
| astropy-7746 | ✗ | ✗ | held |
| django-10914 | ✓ | ✓ | held |
| django-10924 | ✓ | ✓ | held |
| django-11001 | – empty | ✓ | gain (from partial-epic capture fix `ced6def`, not from this intervention) |
| django-11019 | ✗ | ✗ | held |

**Gate 5 promote rule:**

| Gate | Pass? |
|---|---|
| Tuning rate improves | ✗ 5 → 4 |
| ≤ 1 regression | ✗ 2 regressions |
| Holdout doesn't drop | not measured (earlier gates failed) |

**Rejected.** Cross-model review stays in the codebase as an opt-in
capability (`policy.agents.review_model='cross'` works as designed),
but is NOT promoted as default.

**Honest diagnostic — variance is the bottleneck, not the reviewer:**

Looking across Run 9, 10d, 10e, and now 10f, the data shows the
**underlying planner+worker variance is too high to cleanly measure
any worker- or reviewer-layer intervention at N=10**. Same task +
same config produces different outcomes across runs because the
planner decomposes the work differently each time. The intervention's
signal is real (Run 10b identified a defect Sonnet missed; Run 10d
acted on it) but gets averaged out — and at this scale, AVERAGES TO
NEGATIVE because the cross-model session also introduces failure
modes (astropy-6938 dropping to empty patch in 10f).

**Strategic implication:**

The path to 70% does NOT go through more reviewer / worker
interventions until variance is addressed. **Planning stability is
the next intervention to tackle** — it's the foundational lever that
unlocks reliable measurement of everything downstream.

Concrete pivot path:

1. **Investigate temperature pinning at the planner level** — does
   claude-cli expose temperature? If yes, pin to a deterministic
   value. If no, document the limit.
2. **Tighten the PM persona for narrow briefs** — already done once
   (commit `44aca59`); revisit whether the bug-fix prompts produce
   too many stories.
3. **A separate methodology test:** run the SAME brief through the
   planner 5 times and measure decomposition variance. If 5 runs
   produce 5 different epic shapes, the planner is the variance
   source. If 5 runs produce similar shapes, look elsewhere.

After planning is stabilized, the intervention ladder can be measured
cleanly. Until then, 10-task interventions are throwing measurements
at a noise floor.

### Run 10e — 3-task probe SETBACK (0/3 resolved) {#run-10e}

**Result: 0/3 resolved.** Direct setback from Run 10d's ✓.

| Task | Run 8 | Run 10d | Run 10e | Tool histogram (10e) |
|---|---|---|---|---|
| astropy-14182 | ✗ | ✓ | ✗ | 12 Edits / 125 Bash — worker implemented but didn't reach gold fix |
| astropy-14995 | ✗ | – | – empty | **0 Edits** / 1 Write / 22 Bash — analysis-only failure |
| astropy-7746 | ✗ | – | ✗ | 7 Edits + 1 Write / 115 Bash — active worker, didn't reach fix |

**Diagnostic:**

The intervention's effect is REAL but variance-bounded:

- Run 10b proved cross-model Opus identifies defects same-model
  misses (the read-path near-miss). That fact is durable.
- Run 10d's ✓ wasn't fabricated — Opus did the work that
  block-and-revise acted on.
- Run 10e's regression on astropy-14182 (same config as Run 10d,
  same task, ✗ this time) is **planning stochasticity at the
  worker level**: 4-story decomposition this time, 5-story in
  10d. Different decompositions, different outcomes. This is
  Open #3 (planning stochasticity) biting at the worker level.

**Second diagnostic — `review_revise_trigger='any'` has a
failure-mode interaction:** astropy-14995 showed the analysis-only
pattern (0 Edits, worker stayed in analysis). The likely
mechanism: revise-loop fires on every Opus comment → worker
re-analyzes the review feedback instead of continuing
implementation → never edits → empty patch. Same failure mode
Run 9's worker-prompt-discipline accidentally produced.

**Two separable variables got conflated:**

1. **Cross-model review (`review_model=cross`)** — proven
   beneficial (10b/c/d). Default trigger (`blockers`) is the
   conservative way to use it.
2. **`review_revise_trigger='any'`** — produced 10d's ✓ but also
   10e's 14995 analysis-only failure. Mixed signal at low N;
   needs its own measurement.

### Run 10f — 10-task tuning, cross-model ONLY (default trigger) {#run-10f}

Per the methodology's "one variable per Gate 3" rule, the next
batch separates cross-model from revise-on-any. Cross-model has
the stronger evidence; measure it alone first.

Command:

```bash
./scripts/bench/run.sh \
  --limit 10 --preserve-all \
  --review-model cross --review-model-id claude-opus-4-7-medium
```

Same first-10 tasks as Run 8 baseline. Validated config otherwise
(block-and-revise + skill-gen off + pre-cleared cache). Cross-model
review on at default `blockers` trigger.

**Predicted outcome:** modest improvement over Run 8's 50%. Even
without revise-on-any, the cross-model reviewer's comment-level
findings still attach to PRs (just don't trigger revision).
Conservative expectation: 5-7 of 10. Less than the optimistic 70%
target but still measurable progress.

**If 10f ≥ 6 and ≤ 1 regression:** promote cross-model as default.
Then run a separate 10-task measuring revise-on-any on TOP of the
new baseline.

**If 10f = 5 (no movement):** cross-model alone doesn't pass.
Pivot to planner stabilization (Open #3) — variance is the
bottleneck, not the reviewer.

### Trajectory math (with caveats) {#trajectory-math}

Run 8 was 5/10 on the validated baseline. Of the 5 unresolved:

- 3 were test-misunderstanding near-misses (astropy-14182,
  astropy-7746, astropy-14995)
- 1 was over-engineering (django-11019)
- 1 was bench-harness limit (django-11001 — now resolved via
  ced6def's partial-epic capture fix)

The combined intervention (#20 + `review_revise_trigger='any'`)
targets test-misunderstanding directly. If it flips all 3 in the
3-task probe AND django-11001 stays resolved, the 10-task rate
becomes 5 + 3 + 1 = 9/10 (90%). Even with one of the 3 near-misses
NOT flipping, the rate is 5 + 2 + 1 = 8/10 (80%). The conservative
case (only 14182 flips at 10-task) is 5 + 1 + 1 = 7/10 (70%) — the
target.

This is single-data-point math; the actual rate is what the bench
measures, not what this paragraph predicts. But it gives the
probe a calibrated expectation.



### Run 10b — cross-model review re-probe interpretation matrix {#run-10b-matrix}

(Mapping from the original Run 10 frame. The probe configuration
is unchanged except for the review_model_id fix above.)

| Outcome | What it means |
|---|---|
| ✓ resolved | Cross-model review converted the near-miss. Strong signal — escalate to 3-task to confirm it isn't task-specific. |
| ✗ unresolved BUT review output changed | Intervention is doing something; need more tasks to see if it's the right something. Escalate to 3-task. |
| ✗ unresolved AND review output unchanged | Either Opus and Sonnet review the same way, or the wiring isn't actually flipping the reviewer. Forensics: read the review_summary from preserved tempdir's loom.db. |
| Worker error / empty patch | Cross-model wiring broke something else. Same revert pattern as Run 9. |

### Run 9 — worker-prompt scope discipline (REJECTED, Gate 3 fail) {#run-9}

**Score: 3/10 resolved (30%), 4 empty patches. Net −2 vs Run 8's
50%, with 4 regressions. Promotion rule fails cleanly.**

Single-variable intervention: the worker-prompt change in
`c633c42` (minimal-fix preference, principle-only) + `e670787`
(bug-fix workflow scaffold — numbered 5-step reproduce →
hypothesize → implement → verify-full → commit). Both reverted
together in `f61ecaa`; preserved on branch
`worker-prompt-scope-discipline-v1` for forensics.

The Gate 2 hypothesis was: "scope discipline cuts the wider-rewrite
failure mode (django-11019-class) without harming the rest." Hard
no — the rest got hurt.

**Configuration** (identical to Run 8 baseline except for the
worker prompt + `--preserve-all` for forensics):

- Same 10 tasks: `swe-lite-300.json` first 10
- `--review-strategy block-and-revise`
- `--skill-generation off`, skill cache pre-cleared
- `--preserve-all` (every tempdir kept for forensics)

**Per-task vs Run 8:**

| Task | Run 8 | Run 9 | Δ |
|---|---|---|---|
| astropy-12907 | ✓ | – empty | **REGRESSED** |
| astropy-14182 | ✗ | ✗ | held |
| astropy-14365 | ✓ | – empty | **REGRESSED** |
| astropy-14995 | ✗ near-miss | – empty | **REGRESSED** (was non-empty) |
| astropy-6938 | ✓ | – empty | **REGRESSED** |
| astropy-7746 | ✗ | ✗ | held |
| django-10914 | ✓ | ✓ | held |
| django-10924 | ✓ | ✓ | held |
| django-11001 | – empty | ✓ | **GAINED** (partial-epic capture fix from `ced6def` paying off — orthogonal to this run's prompt change) |
| django-11019 | ✗ | ✗ | held |

The astropy cluster going entirely empty is the smoking gun.
Earlier runs had specific astropy-emptiness from skill-cache
contamination (Run 7) which was fixed in Run 8 with skill-gen off
+ pre-clean. Run 8 saw all 4 astropies producing. Run 9 has all 4
astropies empty again, on a config where the ONLY change is the
worker prompt.

**Forensics from `--preserve-all` tempdirs** (per-task
`decision_traces` tool-intent histograms, story-001-001 only since
the others cascade-blocked):

| Task | Bash | Read/Grep | Edit | Write | MultiEdit | Outcome |
|---|---|---|---|---|---|---|
| astropy-12907 | 10 | 5 | **0** | **0** | 0 | failed |
| astropy-14365 | 12 | 2 | **0** | 1 | 0 | failed |
| astropy-6938 | 1 | 6 | **0** | **0** | 0 | failed |
| astropy-14995 | 44 | 2 | 2 | 3 | 0 | failed (step 4 likely timed out) |

Three of four made **zero or near-zero implementation calls.** The
worker on astropy-12907 left a thorough completion summary ending
literally with: *"The next story is a one-line change:
`cright[-right.shape[0]:, -right.shape[1]:] = 1` →
`cright[-right.shape[0]:, -right.shape[1]:] = right` at
`astropy/modeling/separable.py:245`."* Perfect hypothesis, never
implemented. The numbered "Bug-fix workflow" scaffold trained the
worker to treat the analysis as the deliverable instead of doing
step 3 (Implement only that change).

In every empty-patch case, story-001-001 failed, and stories
001-002 through 001-005 cascade-blocked on the dependency chain.
The planner over-decomposed astropy bug fixes into 5 stories —
likely a Run-9-independent issue (planner stochasticity, see
Run-8 open follow-up), but the worker-prompt change is what made
story-001-001 fail in the first place.

**Gate 5 — promotion verdict:**

| Gate | Pass? |
|---|---|
| Tuning rate improves (or holds) | ✗ 5 → 3 |
| At most one regression | ✗ 4 regressions |
| Holdout doesn't drop | not measured (intervention reverted before holdout) |

Reverted in `f61ecaa`. Branch
`worker-prompt-scope-discipline-v1` carries the change for
forensic reference.

**Gate 2 — refined hypothesis for v2 (NOT shipped, just
recorded so the next iteration has a starting point):**

| Element | Run 9 (rejected) | v2 sketch |
|---|---|---|
| Minimal-fix principle (single bullet) | shipped | keep — the principle alone didn't cause the cascade; it was the workflow that did |
| Numbered 5-step workflow scaffold | shipped | **drop entirely** — the load-bearing cause of analysis-as-deliverable |
| Anti-pattern guidance | none | add: "don't write a 'here's what should be done' summary; write the change" |

v2 would need its own Gate 3 measurement before promotion. The
forensic data lives in the preserved tempdirs (paths in the
`f61ecaa` revert commit body) for whoever picks this up.

**What the methodology saved us from:** We didn't pile on more
worker-prompt-related changes (or the auto-propose / cross-repo /
cloud-skills work) on top of an unmeasured intervention. The
single-variable rule caught a regression that would have been
much harder to attribute had it stacked.

**Net learning beyond this single intervention:** behavioral
prompt scaffolds for the worker are higher-risk than they read.
The principle / anti-pattern formulation is preferred over
multi-step procedural scaffolds — the latter is too easy for the
worker to follow literally past the point of usefulness.

### Visibility-layer tooling (shipped 2026-05-27) {#visibility-layer}

The 70%-trajectory pivot from intervention iteration to measurement
infrastructure. Three commands, all operating on existing bench
artifacts (predictions.json + harness reports + preserved tempdirs):

```bash
# Per-task failure-mode classification of one run
loom-bench classify <predictions.json> --report <harness.json> \
  --tempdirs "id=path,id=path,..."

# Per-task delta between two runs (held/gained/regressed/shifted)
loom-bench compare <a-predictions> <b-predictions> \
  --report-a <a-harness> --report-b <b-harness>

# Outcome distribution across K runs (the noise floor)
loom-bench variance --predictions r1.json r2.json ... rN.json \
  --reports r1-rep.json r2-rep.json ... rN-rep.json
```

Failure-mode tags the classifier produces (each tied to a runbook
pattern):

- `under-editing` — unresolved + smaller patch (most common)
- `over-engineering` — unresolved + patch ≥ 30 KB
- `analysis-only` — empty patch + ≤1 Edit/Write call (needs tempdir)
- `planner-cascade` — story-001-001 failed + others blocked (needs tempdir)
- `reviewer-error` — review_status='errored' on any story (#21)

Use the variance command BEFORE investing in a new intervention
measurement. If task X resolves 60% of the time at baseline, a
single 1-task probe showing ✓ is meaningless.

### Intervention candidate ladder (toward 70%) — REVISED post-10f {#interventions-toward-70}

Ordered by readiness. Top is the next single-variable intervention.

**Major reorder after Run 10f's Gate 3 fail:** worker- and reviewer-
layer interventions cannot be cleanly measured at 10-task N until
planning variance is reduced. Planning stability moves to #1.

| # | Intervention | State | Why this one |
|---|---|---|---|
| 1 | **Planning stability — temperature pinning + PM persona tightening** | Open follow-up #3 (longstanding) — now load-bearing | Run 9, 10d, 10e, 10f all show same-task-same-config producing different outcomes. Until this is fixed, downstream measurements are noise-bounded. **Variance is the bottleneck, not the reviewer.** |
| 2 | Planner-decomposition test — measure decomposition variance directly | Not started; methodology work | Quick experiment: run the same brief through the planner 5 times, measure epic-shape diff. Quantifies the variance source. |
| 3 | Cross-model review (#20) + review_revise_trigger='any' (combined) | Shipped opt-in. Run 10e showed 0/3 at 3-task. | Likely revisit AFTER planning is stabilized. The combined version may pass when measurement noise is lower. |
| 4 | Cross-model review alone | Shipped opt-in. Run 10f: 4/10, REJECTED. | Stays opt-in but not promoted. Don't re-measure until planning stabilizes. |
| 5 | Severity-promotion alone (`review_revise_trigger='any'`, same-model reviewer) | Shipped opt-in. Not yet probed alone. | Test after planning stable. |
| 6 | Diff-first worker prompts (#10 context spine) | Not started — capability work. | Bigger lift; orthogonal to review. Test independently once planning stable. |
| 7 | Worker-prompt v2 (drop numbered workflow, keep principle + anti-pattern) | Sketched in Run 9 writeup. | Lower priority. |

**Recommended immediate path:**

1. **Quick win**: Run the planner-decomposition test (#2 above). One
   brief, run 5 times, measure decomposition variance. If decomposition
   is highly variable, planning stochasticity is confirmed as the
   bottleneck and intervention #1 becomes top priority.
2. If variance is low: revisit why interventions failed Gate 3
   despite low variance. The bottleneck is elsewhere (worker
   variance? reviewer? something we haven't named).
3. Pursue #1 (temperature pinning + persona tightening) based on
   the variance findings.

This is methodology being honest with itself. Run 10f's result
isn't a failure of the iteration discipline — it's a signal that the
gates worked. We measured an intervention, it didn't promote, we
revert (no-op in this case since the change was opt-in), we learn
that the variance is the real problem, and we pivot to the right
lever.

### Open follow-ups from the bench loop

These surfaced during Runs 6–9 + holdout. None block the promoted
baseline (Run 8 config, restored after Run 9's revert); each is
filed or noted for the next iteration:

| | Item | Source |
|---|---|---|
| Filed | Worker writes scratch files at the repo root (one occurrence) | Run 6 |
| Open | django-11019 worker-exit-1 root cause | Runs 6–7 |
| Open | Partial-epic success doesn't capture in `SweBenchRunner.captureDiff` (cause of django-11001 empty in Run 8) | Run 8 |
| Open | Planning stochasticity (same brief → different epic structure across runs) | Run 7 → Run 8 |
| **Built** | `--preserve-failures` only triggers on loom-side failures, not on patches that fail the hidden SWE-bench harness. ➜ `--preserve-all` shipped — keeps every task tempdir regardless of loom's own pass/fail. Use sparingly (disk usage scales with task count). | django-11019 targeted reproduction |

### django-11019 targeted reproduction — Gate 1 diagnostic {#django-11019-targeted}

**Score: 0/1 resolved, patch produced (458 lines), 2/16 FAIL_TO_PASS,
59/59 PASS_TO_PASS.** First successful diagnostic on django-11019 after
two prior runs left only empty patches.

Single-task batch, default validated config (`--skill-generation off`,
`--review-strategy block-and-revise`, `--preserve-failures`).
Predictions: `predictions-20260526-101738.json`.
Per-instance report at
`logs/run_evaluation/loom-django-11019-targeted-20260526/loom/django__django-11019/`.

**Outcome shift from Runs 6–8.** The earlier empty-patch outcomes were
worker-exit-1 inside the dispatch (no commits captured). This time
the planner chose 5 stories, all 5 workers committed, the
EpicFinalizer produced a 12-commit epic branch, and a real 458-line
diff landed in the prediction. The "django-11019 worker-exit-1"
follow-up is therefore reclassified: not a deterministic worker
crash, a stochastic outcome of planning + dispatch.

**Patch shape (what loom actually did):**

| File | Change |
|---|---|
| `django/forms/widgets.py` | Added 120-line `_build_constraint_graph` + `_topological_merge` helpers (heapq, first-seen tie-breaking). Rewrote `Media._css`, `Media._js` to call the new topological merge. Deleted the original `Media.merge` body. |
| `tests/forms_tests/tests/test_media.py` | Added new tests of the topological-merge behavior. |
| `docs/releases/3.0.txt` | Release-note entry. |

**Gate 1 classification: wrong approach / over-engineering.** The
gold patch is a *minimal* improvement to the existing pairwise
`Media.merge` so it handles 3-way merges. Loom replaced the merge
algorithm entirely with a topological sort. The headline target
(`test_merge_js_three_way{,2}`) passes, but the rewrite breaks
enough surrounding semantics (warning emission rules, dedup order,
medium-iteration order, single-source preservation) that 14 other
expected-to-pass tests still fail — even though all 59
expected-to-pass-already tests still pass (no regressions).

This is the "wider rewrite passes the named test, fails everything
else the gold patch fixes" failure mode — characteristic of a
planner that converted "fix the merge bug" into "redesign the merge."

**Why this is more valuable than the empty-patch outcomes.** An
empty patch tells you nothing about *which* of the nine classes
applies. A non-empty patch with a clean PASS/FAIL split locates the
problem in the planning step: the brief refinement + PM decomposition
chose a scope too wide for the bug.

**Candidate interventions (Gate 2, none built yet):**

1. **Tighten the worker prompt** to prefer minimal in-place
   patches over algorithm replacement when a fix-existing path
   exists. Hypothesis: cuts the rewrite-rate.
2. **Diff-first worker prompts** (Issue #10) — re-frame the
   worker task as "produce the smallest diff that flips the
   FAIL_TO_PASS tests" rather than "implement the story." Bigger
   intervention; deferred capability work.
3. **Capture decision_traces from the planning step** (not just
   the worker) so a future Gate 1 review can read *why* the PRD
   said to redesign rather than patch.

**Tooling follow-up.** `--preserve-failures` didn't fire on this
task because loom's own pipeline succeeded (5/5 stories done,
non-empty patch). Diagnosing loom-passes-but-bench-fails outcomes
needs either `--preserve-all` or a post-run "preserve if bench
unresolved" hook keyed off the harness report. Filed in the Open
follow-ups table above.

**Cost:** single task, ~60 minutes wall-clock, 5 worker dispatches
+ 1 EpicFinalizer. Inside the per-task budget envelope used by the
full 10-task batches.

### Run 8 — block-and-revise + skill-gen off + cleared skill cache {#run-8}

**Score: 5/10 resolved (50%), 5/9 (56%) on produced patches.** First
run to hit the 50% mark.

Interventions, both from Gate 2 hypotheses in the Run 7 writeup:

| Intervention | Targets failure class | Predicted shift | Observed shift |
|---|---|---|---|
| `--skill-generation off` + cleared `~/.loom/skills/generated/` | dependency / tooling | 3 astropy regressions return to producing | all 3 produced ✓ |
| `--review-strategy block-and-revise` | test misunderstanding (near-miss) | 1–2 of 3 near-miss patches resolve | exactly 2 resolved (astropy-14365, django-10924) ✓ |

**Three-run trajectory:**

| Task | Run 6 | Run 7 | Run 8 | Trajectory |
|---|---|---|---|---|
| astropy-12907 | ✓ | ✓ | ✓ | held |
| astropy-14182 | ✗ | ✗ | ✗ | near-miss persists |
| astropy-14365 | ✗ | ✗ | **✓** | resolved via block-and-revise |
| astropy-14995 | ✓ | – | ✗ | recovered from Run 7 empty; still near-miss |
| astropy-6938  | ✓ | – | ✓ | recovered |
| astropy-7746  | ✗ | – | ✗ | recovered; still near-miss |
| django-10914 | ✓ | ✓ | ✓ | held |
| django-10924 | – | ✗ | **✓** | 529-retry rescued + block-and-revise solved |
| django-11001 | – | ✓ | – | regressed (planning stochasticity + partial-epic harness limit) |
| django-11019 | – | – | ✗ | rescued from empty, unresolved |

**Gate 1 — failure classification:**

| Task | Class | Notes |
|---|---|---|
| astropy-14182 | test misunderstanding | revise loop didn't catch the specific assertion |
| astropy-14995 | test misunderstanding | new near-miss after rescue |
| astropy-7746 | test misunderstanding | new near-miss after rescue |
| django-11019 | under-editing | worker committed but the patch didn't reach the gold test's assertion |
| django-11001 | **bench harness limit** | planner stochastically chose 3 stories; the 3rd failed; EpicFinalizer requires all-stories-success, so no epic branch → empty captured diff. Workers' commits on `story/*` branches were lost in capture |

**Failure distribution across runs:**

| Class | Run 6 | Run 7 | Run 8 |
|---|---|---|---|
| test misunderstanding | 3 | 3 | 3 (1 converted via block-and-revise; 2 new from rescued tasks) |
| dependency / tooling | 0 | 3 | **0** |
| flaky / environment (API 529) | 2 | 0 | 0 |
| under-editing | 1 | 1 | 1 |
| bench harness limit | 0 | 0 | 1 (NEW) |

Dep/tooling went from 3 to 0 — the skill-gen-off intervention cleanly
eliminated the category. The test-misunderstanding count held at 3
but composition shifted: 1 converted via block-and-revise, 2 new
ones emerged from tasks the previous run hadn't produced patches for.
Net: the resolution rate climbs even though the absolute
near-miss count stays similar.

**Gate 4 — cost / runtime:**

| Metric | Run 6 | Run 7 | Run 8 |
|---|---|---|---|
| Produced patches | 7 | 6 | 9 |
| Resolved | 4 | 3 | 5 |
| Resolution rate (attempted) | 40% | 30% | **50%** |
| Resolution rate (produced) | 57% | 50% | 56% |
| Wall-clock (bench portion) | ~5 hr | ~5 hr | ~14 hr |
| Mean diff size | 38 KB | 12 KB | 11 KB |

Run 8 wall-clock is ~2.8x Run 7. Most of that is `block-and-revise`
adding re-prompt rounds on blockers, plus the higher produce rate
(9 worker runs vs 6) just having more work to do. Not a cost
explosion per the methodology threshold (>2x for sub-10pp gain),
but a real cost increase that should be tracked.

**Gate 5 promotion verdict:**

| Gate | Pass? |
|---|---|
| Tuning rate improves (or holds) | ✓ 4 → 3 → 5 |
| At most one regression | ✓ exactly 1 (django-11001) |
| Holdout doesn't drop | ⚠ **NOT YET MEASURED** |

**Conditional promotion:** yes for the tuning side. **Final promotion
gated on a holdout run** (committed: `swe-bench-holdout.json`, 50 tasks).
A 10-task holdout slice is queued next as a directional check before
committing to the full 50.

**One bench-harness fix surfaced for follow-up:** when an epic
partially succeeds (some stories made commits, others failed), the
`SweBenchRunner.captureDiff` finds no epic branch (EpicFinalizer is
all-or-nothing) and returns empty. The story branches DO have the
commits. The runner should fall back to merging the succeeded story
branches when no epic branch exists, so partial work still surfaces
in the prediction. Filed as a known limitation for the next iteration
— not in scope for the current loop.

### Run 7 — clean batch (diff filter + worker prompt + 529 retry applied) {#run-7}

10 tasks (same as Run 6). All loom-side fixes from commit `8908020`
(diff filter, 529 retry) and `5f69272` (worker prompt scratch
section) in place.

**Score: 3/10 (30%) resolved, 3/6 (50%) on produced patches.**

| | Run 6 | Run 7 | Delta |
|---|---|---|---|
| Total attempted | 10 | 10 | — |
| Produced patches | 7 | 6 | -1 |
| Resolved | 4 | 3 | -1 |
| Resolution rate (attempted) | 40% | 30% | -10pp |
| Resolution rate (produced) | 57% | 50% | -7pp |
| Avg diff size | 30–60 KB | 4–17 KB | filter worked |

**Per-task transitions:**

| Task | Run 6 | Run 7 | Reading |
|---|---|---|---|
| astropy-12907 | ✓ resolved | ✓ resolved | held |
| astropy-14182 | ✗ unresolved | ✗ unresolved | held |
| astropy-14365 | ✗ unresolved | ✗ unresolved | held |
| astropy-14995 | **✓ resolved** | **– empty** | **REGRESSED** |
| astropy-6938  | **✓ resolved** | **– empty** | **REGRESSED** |
| astropy-7746  | ✗ unresolved | – empty | regressed |
| django-10914 | ✓ resolved | ✓ resolved | held |
| django-10924 | – empty (529) | ✗ unresolved | 529 retry worked, but didn't resolve |
| django-11001 | – empty (529) | **✓ resolved** | **529 retry rescued + solved** |
| django-11019 | – empty (worker) | – empty (worker) | held |

**Two real findings:**

1. **The diff filter worked end-to-end.** Patches shrank from 30–60 KB
   (70% noise) to 4–17 KB (mostly real code). Loom no longer
   pollutes predictions.json with `.loom_outputs/` planning artifacts
   or `.loom-notes/` scratch.
2. **The 529 retry worked.** Both django tasks that died at planning
   in Run 6 produced patches in Run 7; one of them resolved.

**One real regression:**

Three astropy tasks that previously *produced* patches (two of them
*resolved*) now produce empty patches. Looking at the worker output,
the failing story in each case is preceded by a candidate-skill
canary injection from a *different task earlier in the same bench run*:

- astropy-14995, story-001-003 failed AFTER
  `loom-testing-regression-verification` was canary-injected
- astropy-6938, story-001-003 failed AFTER
  `loom-numpy-slice-mutation` (generated from a prior task) was injected
- astropy-7746, story-001-003 hit a 30-minute worker timeout after
  multiple skill injections

**Hypothesis: cross-task candidate-skill pollution.** Loom's skill
loop generates a new candidate from a completed story, writes it to
`~/.loom/skills/generated/`, and the SkillSelector then canary-
injects it into subsequent tasks' stories. Within a bench run, this
means a candidate generated from task 3 can land in task 5's worker
prompt, carrying misaligned guidance from a different problem domain.

For SWE-bench specifically, where each task is independent, this is
a confound: the result on task N depends on which candidates tasks
1..N-1 produced. **The bench needs to opt out of skill generation**
and start with a clean skill cache.

**Run 8 plan (already in motion):**
- `--skill-generation off` to suppress new candidates during the bench
- Move existing `~/.loom/skills/generated/` aside before the run
- `--review-strategy block-and-revise` to exercise the review/revise
  loop that was off in Runs 6 + 7 — the intervention pre-planned for
  the near-miss failure mode (see below).

**The near-miss pattern, why it matters for the next iteration:**

The three unresolved tasks all have the same shape:

  | Task | Pattern |
  |---|---|
  | astropy-14182 | `RST` writer — issue asks for `header_rows` kwarg; loom added the kwarg but the hidden test exercises a path loom's implementation missed |
  | astropy-14365 | `QDP` parser — issue describes commenting behavior; loom fixed it for `False` cases but the `True` roundtrip path stayed broken |
  | astropy-7746  | `WCS` empty input — issue describes zero-size handling; loom's fix handled the explicit-empty case but missed the implicit-empty path the test asserts |

This is **not** a "loom can't fix bugs" failure — it's a "loom interprets
the issue slightly differently from the hidden test." Two interventions
have leverage:

1. **`review_strategy: 'block-and-revise'`** in the bench — a second pass
   re-reads the issue against the patch. Doesn't see the hidden test;
   does see the issue text; can ask "is the user's actual complaint
   addressed?"
2. **Worker prompt change** — direct the worker to write a test that
   *reproduces the user-reported bug from the issue text* first, then
   implement the fix. Currently the worker writes tests for what it
   implements; reversing that order forces engagement with the
   original failure mode.

(2) is a bigger persona change that should not be made without measuring
in isolation. (1) is a one-flag flip on the bench. If Run 7 doesn't move
the rate, Run 8 should be Run 7's config + `block-and-revise`.

---

## LLM backend — session vs. API

loom talks to Claude through one of two backends, set by `policy.agents.llm_backend`:

- **`claude-cli`** (default) — session-based, via the Claude Code login. **No API key,
  no API billing.** Requires the `claude` CLI installed and logged in. This is the path
  for environments that do not permit API spend.
- **`anthropic-api`** — direct Anthropic API. Requires `ANTHROPIC_API_KEY`.

Workers always run through the session-based `claude` CLI. Only the planner and skill
generator consult `llm_backend`. Runbook examples below that mention `ANTHROPIC_API_KEY`
apply only when you have switched to the `anthropic-api` backend.

---

## Epic 1 — Core Engine

**What was delivered**: `loom init`, the policy engine (`loom guard check`), and the SQLite state layer (epics, agents, audit_log).

### Automated tests

```bash
npm run test -w @loom-ai/core   # PolicyEngine + State unit tests (40)
npm run test -w loom-ai         # loom init + loom guard check integration tests (11)
```

### Manual verification

Set up a throwaway test repo:

```bash
mkdir -p /tmp/loom-demo && cd /tmp/loom-demo && git init
node /Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js init --cursor
```

You should see:

```
  created  .loom/policy.yaml
  created  .loom/loom.db
  updated  .gitignore
  updated  .claude/settings.json (PreToolUse hook)
  created  .cursor/mcp.json
  created  .cursor/rules/loom.mdc

  loom initialized. Run `loom epic "<your brief>"` to start.
```

Verify the files exist:

```bash
ls -la .loom/             # policy.yaml, loom.db, worktrees/
cat .claude/settings.json  # PreToolUse hook pointing to loom guard
cat .cursor/mcp.json       # worker MCP provisioning (no loom server)
```

Then exercise the **policy engine** via `loom guard check` (manual / CLI usage):

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js

# These should all BLOCK (exit 1) with a JSON reason on stderr:
node $LOOM guard check --command "git push --force"
node $LOOM guard check --command "git push --force-with-lease"
node $LOOM guard check --command "git reset --hard HEAD~1"
node $LOOM guard check --command "rm -rf ~/.ssh"
node $LOOM guard check --command "rm /etc/passwd"

# Bypass-attempt blockers (new in this pass):
node $LOOM guard check --command "git status; git push --force"      # blocked: shell.metacharacters
node $LOOM guard check --command "git add . && git push --force"     # blocked: shell.metacharacters
node $LOOM guard check --command "bash -c 'git push --force'"        # blocked: shell.wrapper_program
node $LOOM guard check --command "eval 'rm -rf ~/.ssh'"              # blocked: shell.wrapper_program
node $LOOM guard check --command "echo \$(rm -rf ~/.ssh)"            # blocked: shell.metacharacters

# These should all ALLOW (exit 0):
node $LOOM guard check --command "git add ."
node $LOOM guard check --command "git commit -m 'fix: a && b in message'"  # && inside quotes is fine
node $LOOM guard check --command "npm install"
node $LOOM guard check --command "rm -rf ./dist"
node $LOOM guard check --command "ls -la | grep loom"
```

Test the **Claude Code hook protocol** (`loom guard hook` reads stdin JSON):

```bash
# Blocked — exits 2 with a feedback message Claude Code will display:
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force"}}' \
  | node $LOOM guard hook
echo "exit: $?"   # Expected: exit 2, stderr: "loom blocked this command: ..."

# Allowed — exits 0 with no output:
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git add ."}}' \
  | node $LOOM guard hook
echo "exit: $?"   # Expected: exit 0

# Non-Bash tool calls pass through (only Bash is policy-checked):
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/foo"}}' \
  | node $LOOM guard hook
echo "exit: $?"   # Expected: exit 0
```

Verify the **audit log** captured every check (SQLite, FTS5-searchable):

```bash
sqlite3 .loom/loom.db "SELECT command, allowed, policy_rule FROM audit_log ORDER BY timestamp DESC LIMIT 10;"
```

Verify **idempotency** — running `init` again should skip existing files:

```bash
node /Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js init
# Expected: "exists" messages for policy.yaml, .claude hook, .cursor/mcp.json loom entry
```

Verify the **status** command (will be empty until Epic 2 lands):

```bash
node /Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js status
# Expected: "No epics found. Run `loom epic "<brief>"` to start."
```

### Definition of done for Epic 1

- [x] `npm test` passes (74 tests after the staff-review pass)
- [x] `loom init` creates all expected files; second run is idempotent
- [x] `loom guard check` blocks every documented destructive command
- [x] `loom guard check` allows every documented safe command
- [x] `.loom/loom.db` opens cleanly with `sqlite3` and has `epics`, `agents`, `audit_log`, `audit_log_fts` tables
- [x] `loom status` runs without error on an empty DB

---

## Epic 2 — BMAD Planning Pipeline

**What was delivered**: `loom epic "<brief>"` runs the Analyst → PM → Architect
personas headlessly. Each `loom epic` invocation is a *planning run* scoped to its own
directory `.loom/planning/<run-id>/`, producing `project-brief.md`, `prd.md`,
`architecture.md`, and `epics/epic-NNN.yaml`. Epic IDs are globally sequential across
runs so they never collide. Plus the human gate: `loom approve` / `loom reject`.

The planner is built on an `LLMClient` abstraction — `AnthropicClient` for real runs
(with prompt caching), `MockLLMClient` for tests.

### Automated tests

```bash
npm run test -w @loom-ai/core   # PersonaLoader + full planner pipeline (mock LLM)
npm run test -w loom-ai         # loom approve / reject / epic CLI
```

The planner tests use `MockLLMClient` — they exercise the entire Analyst→PM→Architect
pipeline, schema validation, the PM's JSON-retry, multi-run epic numbering, and prompt
caching **without an API key or any network calls**.

### Manual verification — no API key needed

The planner pipeline can be driven end-to-end with the mock client:

```bash
cd /tmp && rm -rf planner-demo && mkdir planner-demo && cd planner-demo && git init -q
node -e '
const { MockLLMClient, Planner, openDatabase } = require("/Users/jeromeortega/Repos/loom/packages/loom-core/dist/index.js");
const responder = (req) => {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes("Produce the project brief")) return "# Demo\n\n## The Problem\nA gap.";
  if (last.includes("task A: produce the PRD")) return "# PRD\n\n## Goals\nShip it.";
  if (last.includes("task B: produce the epic")) return JSON.stringify({epics:[{epic_id:"epic-001",title:"Demo epic title here",priority:"must-have",prd_ref:"x",requirements:["FR-1"],stories:[{id:"story-001-001",title:"A demo story",description:"do it",acceptance_criteria:["works"],estimated_complexity:"small",dependencies:[]}]}]});
  if (last.includes("task A: produce the architecture")) return "# Arch\n\n## Architecture Philosophy\nBoring tech.";
  if (last.includes("task B: produce per-story")) return JSON.stringify({tech_notes:{"story-001-001":"Use the module."}});
};
(async () => {
  const db = openDatabase(".loom");
  const r = await new Planner({ projectRoot: process.cwd(), llm: new MockLLMClient(responder), model: "mock", db }).run("Build a demo feature.");
  console.log("Planned:", r.runId, r.epicIds, r.storyCount + " stories");
})();
'
find .loom/planning -type f      # the four generated artifacts
```

### Manual verification — real planning run (session-based, no API key)

```bash
# Default backend is claude-cli — uses your Claude Code login, no API key.
# (Just make sure `claude` is installed and you have logged in.)
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js

cd /tmp && rm -rf loom-real && mkdir loom-real && cd loom-real && git init -q
node $LOOM init

# Planning runs headless and blocks for a few minutes:
node $LOOM epic "Build a CLI tool that lists my GitHub starred repos sorted by last commit date"

# Inspect what the personas produced:
ls .loom/planning/epic-001/                 # project-brief.md, prd.md, architecture.md, epics/
cat .loom/planning/epic-001/epics/epic-001.yaml

# The human gate:
node $LOOM status                           # epic shown as [planned]
node $LOOM approve epic-001                 # or: loom approve  (approves all planned)
node $LOOM status                           # epic now [approved]

# Run a second planning run — note epic IDs continue from epic-002:
node $LOOM epic "Add a JSON output mode to the starred-repos tool"
node $LOOM reject epic-002 --reason "defer to next sprint"
```

### Definition of done for Epic 2

- [x] `loom epic "<brief>"` produces `project-brief.md`, `prd.md`, `architecture.md`, and ≥1 epic YAML
- [x] Generated epic YAML validates against `EpicYamlSchema` / `schemas/epic.schema.yaml`
- [x] `loom approve <epic-id>` (and bare `loom approve`) transition epics to `approved`
- [x] `loom reject <epic-id> --reason` transitions to `rejected` with the reason stored
- [x] Headless — no human interaction during planning
- [x] Prompt caching applied — persona system block flagged `cache: true` on every call
- [x] Repeated `loom epic` runs get unique epic IDs and isolated run directories
- [x] PM agent retries once on malformed epic JSON; fails loudly after two attempts
- [x] `loom epic` works session-based by default; the `anthropic-api` backend fails cleanly without a key
- [x] PM agent rejects dangling story dependencies and mis-numbered epics (retry)
- [x] `npm test` passes (113 tests)

---

## Epic 3 — Story Dispatch

**What was delivered**: `loom run` — the Supervisor reads approved epics, dependency-
orders their stories, and dispatches up to `policy.agents.max_concurrent` worker agents,
each in its own git worktree on a `story/<id>` branch. Workers run via the pluggable
`WorkerRunner` interface: `ClaudeCodeWorker` shells out to the `claude` CLI in the
worktree; `MockWorkerRunner` drives tests. The SQLite agents table is the source of
truth for every status transition.

A dependent story's worktree branches from its dependency's branch, so the worker
already has the dependency's committed code. `loom run` is resumable — stories already
completed in a prior run are skipped.

### Automated tests

```bash
npm run test -w @loom-ai/core   # WorktreeManager (real git), Supervisor, worker prompt
```

`WorktreeManager` tests exercise real `git worktree` operations in throwaway repos.
`Supervisor` tests use `MockWorkerRunner` — they verify dependency ordering, the
`maxConcurrent` cap, failure→blocked propagation, resumability, and worktree branching,
all **without invoking the real `claude` CLI**.

### Manual verification — no API key needed

Drive the Supervisor with a mock worker against a real git repo:

```bash
cd /tmp && rm -rf run-demo && mkdir run-demo && cd run-demo
git init -q && git config user.email t@t.dev && git config user.name T
echo "# demo" > README.md && git add . && git commit -q -m init

node -e '
const { openDatabase, EpicStore, AgentStore, Supervisor, MockWorkerRunner } = require("/Users/jeromeortega/Repos/loom/packages/loom-core/dist/index.js");
const yaml = require("/Users/jeromeortega/Repos/loom/node_modules/js-yaml");
const fs = require("fs"), path = require("path");
const epic = { epic_id:"epic-001", title:"Demo epic for dispatch", status:"planned", priority:"must-have", prd_ref:"x", requirements:["FR-1"], stories:[
  {id:"story-001-001",title:"First story",description:"A",acceptance_criteria:["a"],estimated_complexity:"small",dependencies:[]},
  {id:"story-001-002",title:"Second story",description:"B",acceptance_criteria:["b"],estimated_complexity:"small",dependencies:["story-001-001"]},
]};
const rel = ".loom/planning/epic-001/epics/epic-001.yaml";
fs.mkdirSync(path.dirname(rel),{recursive:true}); fs.writeFileSync(rel, yaml.dump(epic));
const db = openDatabase(".loom");
const es = new EpicStore(db); es.create("epic-001",epic.title,rel); es.updateStatus("epic-001","approved");
(async () => {
  const r = await new Supervisor({ projectRoot: process.cwd(), db, worker: new MockWorkerRunner({status:"done"}), maxConcurrent: 2 }).run();
  console.log("result:", JSON.stringify(r));
  for (const a of new AgentStore(db).listByEpic("epic-001")) console.log(" ", a.story_id, "->", a.status);
})();
'
git worktree list      # main + one worktree per story
```

### Manual verification — real workers (needs `claude` + API key)

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
# In a repo where you have already run `loom epic` and `loom approve`:
node $LOOM run                    # dispatch all approved epics
node $LOOM run epic-001 epic-002  # or specific epics
node $LOOM status                 # per-story status + PR links
git worktree list                  # one worktree per story under .loom/worktrees/
```

Real workers need the `claude` CLI installed and authenticated, and `gh` for PRs.
Workers run with `--permission-mode bypassPermissions` — safe because the loom guard
hook (Epic 1) is the structural safety net inside each worktree.

### Definition of done for Epic 3

- [x] Each story gets its own worktree under `.loom/worktrees/story-*/` on a `story/*` branch
- [x] `loom run` honours `policy.agents.max_concurrent` (never exceeds it in flight)
- [x] Dependency ordering respected — a story waits for its dependencies
- [x] A dependent story's worktree branches from its dependency (has its code)
- [x] A failed dependency blocks its dependents (`blocked` status)
- [x] Workers open a PR when the repo has a remote; local-only repos leave a ready branch
- [x] Worker failure / crash transitions the agent to `failed`
- [x] `loom run` is resumable — completed stories are skipped on re-run
- [x] Dependency cycles are rejected at planning time (`validateEpicSet`)
- [x] `npm test` passes (140 tests)

> Worktree cleanup after PR merge is deferred — see `docs/known-limitations.md`.

---

## Epic 4 — MCP Server

> **REMOVED — historical record.**  
> The `loom serve` command and the `@loom-ai/mcp` package were removed in a subsequent epic. The section below is preserved for institutional memory only — none of the commands here are operational in the current codebase. See [`docs/dogfooding/mcp-removal-notes.md`](../dogfooding/mcp-removal-notes.md) for removal rationale and migration guidance.

**What was delivered**: All 7 MCP tools are live and tested. The handlers were
extracted from `server.ts` into a `tools/` module behind a `ToolContext` (injectable
LLM and worker factories), so they are unit-testable without stdio, a real API key, or
a real `claude` CLI. `loom_approve_plan` now approves the epic and kicks off story
dispatch **in the background** — it returns immediately, and the client polls
`loom_get_status` for progress.

The core tools: `loom_policy_check`, `loom_get_status`, `loom_get_audit_log`,
`loom_start_epic`, `loom_approve_plan`, `loom_reject_plan`,
`loom_get_planning_artifacts`, `loom_get_diff`, `loom_get_review`,
`loom_revert_epic`, `loom_stop_agent`, `loom_stop_epic`, `loom_guide_agent`,
`loom_pull_guidance`, `loom_get_decision_traces`, `loom_list_projects`,
`loom_get_project`, `loom_refine_brief`.

### Automated tests

```bash
npm run test -w @loom-ai/mcp   # tool handlers, temp DB + injected mocks
```

The handler tests drive the full planning pipeline (`loom_start_epic`) and background
dispatch (`loom_approve_plan`) with `MockLLMClient` and `MockWorkerRunner` — no
network, no `claude` CLI.

### Manual verification

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js

# Start the MCP server (normally a client launches it via .cursor/mcp.json):
node $LOOM serve     # listens on stdio; Ctrl+C to stop

# In Cursor, with `loom init --cursor` already run in the repo:
#   the MCP panel shows the loom_* tools.
# A Cursor or Claude Code agent can then:
#   loom_start_epic({brief})    -> plans (blocks a few minutes)
#   loom_approve_plan({epic_id}) -> approves + dispatches in the background
#   loom_get_status()            -> poll for story progress
#   loom_policy_check({command}) -> pre-flight a shell command
```

### Definition of done for Epic 4

- [x] `loom serve` starts cleanly on stdio
- [x] Tools are registered with name, description, and input schema
- [x] Tool handlers are extracted and unit-tested
- [x] `loom_policy_check` returns correct allow/block results
- [x] `loom_get_status` returns the epic/story status tree as JSON
- [x] `loom_start_epic` runs the planner and persists a planned epic
- [x] `loom_approve_plan` approves and dispatches in the background (non-blocking)
- [x] `loom_reject_plan` rejects with a reason; status guards reject bad input
- [x] `npm test` passes

---

## Epic 5 — Skill System

**What was delivered**: the self-learning loop. `SkillStore` discovers agentskills.io
skills from `.loom/skills/` (project) and `~/.loom/skills/` (global, incl. `generated/`).
`SkillSelector` ranks skills by keyword overlap with a story. `SkillGenerator` runs
after each successful story, asks Claude (Haiku) whether the work yielded a reusable
skill, and writes a new `SKILL.md` to `~/.loom/skills/generated/`.

The Supervisor injects the selected skills into each worker assignment and triggers
skill generation after successful stories — skills generated early in a run are
available to later stories.

### Automated tests

```bash
npm run test -w @loom-ai/core   # SkillStore, SkillSelector, SkillGenerator (mock LLM)
```

### Manual verification — no API key needed

```bash
cd /tmp && rm -rf skills-demo && mkdir -p skills-demo/.loom/skills/team-style && cd skills-demo
git init -q
cat > .loom/skills/team-style/SKILL.md <<'EOF'
---
name: team-style
description: Conventions for authentication and JWT login code in this repo.
---
# Team style
Use the shared auth middleware; never hand-roll token parsing.
EOF

LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
# The SkillStore discovers team-style as a project-tier skill at dispatch time.
```

`SkillGenerator` is exercised end-to-end by the automated tests with `MockLLMClient`
(NONE response, valid SKILL.md, invalid-name rejection, malformed-response safety).

### Manual verification — real generation (needs API key)

After a real `loom run` (session-based by default — no key needed), loom extracts
skills from successful stories:

```bash
ls ~/.loom/skills/generated/                 # one dir per generated skill
cat ~/.loom/skills/generated/*/SKILL.md
```

### Definition of done for Epic 5

- [x] `SkillStore` discovers project + global + generated skills with correct sources
- [x] Invalid `SKILL.md` files are skipped; project skills shadow global on name clash
- [x] `SkillSelector` ranks by keyword overlap and caps at the requested limit
- [x] `SkillGenerator` writes a valid generated `SKILL.md`, or returns null for NONE
- [x] Generated skill names are validated against agentskills.io rules (bad names rejected)
- [x] `SkillGenerator` never throws — a malformed LLM response yields null
- [x] The Supervisor injects selected skills into worker assignments
- [x] The Supervisor runs skill generation after each successful story
- [x] `npm test` passes (168 tests)

---

## Epic 6 — IDE Integrations

**What was delivered**: `loom init` now sets up both IDEs fully.

- **Claude Code**: `.claude/settings.json` PreToolUse hook, `.mcp.json` (loom MCP
  server), a `CLAUDE.md` workflow guide, and `.claude/skills/loom-*` slash commands
  (`/loom-epic`, `/loom-status`, `/loom-approve`).
- **Cursor** (`--cursor`): `.cursor/mcp.json` and `.cursor/rules/loom.mdc`.

The hook and MCP commands are written with an **absolute path** to the loom script
(`node "<dist/index.js>" guard hook`) — so the guardrail fires even when `loom` is not
on the worker's PATH (the Epic 3 review's top finding). `loom status` and
`loom_get_status` now show real story titles.

### Automated tests

```bash
npm run test -w loom-ai   # loom init: hook, .mcp.json, CLAUDE.md, slash commands
```

### Manual verification

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
cd /tmp && rm -rf ide-demo && mkdir ide-demo && cd ide-demo && git init -q
node $LOOM init --cursor

ls .claude/skills/         # loom-epic, loom-status, loom-approve
cat .mcp.json              # loom MCP server, absolute node path
cat CLAUDE.md              # workflow guide

# The hook works by absolute path even outside PATH:
echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force"}}' \
  | node $LOOM guard hook    # exit 2, blocked

# In Cursor: open the repo — the MCP panel shows 7 loom_* tools.
# In Claude Code: open the repo — /loom-epic, /loom-status, /loom-approve
#   are available, and the PreToolUse hook blocks destructive Bash inline.
```

### Definition of done for Epic 6

- [x] `loom init` writes the Claude Code hook with an absolute loom path (no PATH dependency)
- [x] `loom init` writes `.mcp.json` so Claude Code gets the 7 loom tools
- [x] `loom init` writes a `CLAUDE.md` workflow guide (does not overwrite an existing one)
- [x] `loom init` writes `/loom-epic`, `/loom-status`, `/loom-approve` slash commands
- [x] `loom init --cursor` writes `.cursor/mcp.json` and `.cursor/rules/loom.mdc`
- [x] `loom status` / `loom_get_status` show real story titles
- [x] The absolute-path hook still blocks destructive commands (verified end-to-end)
- [x] `npm test` passes (180 tests)

---

## Epic 7 — Eval & Safety

**What was delivered**: the measurement substrate and the anti-degradation loop.

- **Skill provenance** — a `skill_usage` table records every skill injection and the
  story's outcome; `SkillUsageStore.trackRecord()` gives each skill a success/fail record.
- **Skill lifecycle** — generated skills are born `candidate`; `SkillSelector` injects
  them only as a *canary* (spare slots after `active` skills). `SkillLifecycle`
  auto-promotes proven candidates to `active` and auto-demotes failing skills to
  `disabled`. Manual override means editing the skill row in `.loom/loom.db`.
- **Eval runner** — `node scripts/eval.mjs` runs a bundled planning suite (6 cases) through the
  full planner in isolated temp dirs, scores it, and stores the score; `node scripts/eval.mjs
  --compare` flags a regression versus the last run.
- **Skill-quality judge** — `SkillGenerator` runs an LLM judge against a rubric before
  a generated skill is written; sub-threshold skills are rejected. The judge is
  best-effort — a judge failure defaults to accept, never blocking a run.

### Automated tests

```bash
npm run test -w @loom-ai/core   # SkillUsageStore, SkillLifecycle, SkillJudge, EvalRunner
```

The eval and lifecycle machinery is fully tested with `MockLLMClient` and temp
databases — no API key, no network.

### Manual verification

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
cd /path/to/an/initialized/loom/repo

node $LOOM skills list            # each skill shows [source/lifecycle] + track record
node $LOOM skills promote <name>  # manual lifecycle override
node $LOOM skills demote <name>

# Real eval run (session-based; runs the planner per case — several minutes):
node $LOOM eval                   # score the bundled planning suite
node $LOOM eval --compare         # ...and flag a regression vs the last run
```

The lifecycle loop runs automatically after each `loom run` — proven candidate skills
are promoted, failing skills demoted, with no manual step.

### Definition of done for Epic 7

- [x] `skill_usage` records injections and outcomes; `trackRecord()` aggregates them
- [x] Generated skills are born `candidate`; `disabled` skills are never injected
- [x] Candidates are canary-injected only into slots `active` skills did not fill
- [x] `SkillLifecycle` auto-promotes proven candidates and auto-demotes failing skills
- [x] Hand-authored (project/global) skills are never auto-managed
- [x] `node scripts/eval.mjs` scores the bundled suite; `--compare` flags regressions
- [x] Eval planner runs are isolated — they never touch the app database
- [x] `SkillGenerator` rejects skills the quality judge scores below threshold
- [x] The judge is best-effort — a judge failure never blocks a run
- [x] `npm test` passes (207 tests)

---

## Epic 8 — Org MCP Provisioning

**What was delivered**: `loom mcp` — provisioning approved MCP servers from an org
registry into the project's MCP config so worker agents inherit them.

- `McpRegistry` reads `server.json` files from a configurable registry path
  (`policy.mcp.registry` — a checkout of the org's registry repo, e.g. an
  `awesome/mcp`-style repo). loom ships no built-in registry — it stays open-source-generic.
- `loom mcp list` shows the approved servers; `loom mcp add <name>` merges a server
  into `.mcp.json` and `.cursor/mcp.json`.
- Secrets are written as env-var **references** (`${JIRA_TOKEN}`) and the required
  ones are printed for the user to set — **loom never reads, prompts for, or stores a
  credential value.**
- Because loom workers are `claude` CLI sessions that read `.mcp.json`, a provisioned
  server is inherited by every worker with no worker-path code.

### Automated tests

```bash
npm run test -w @loom-ai/core   # McpRegistry parsing + the server.json -> .mcp.json adapter
```

### Manual verification

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
# Point policy.mcp.registry at a checkout of your org's MCP registry, then:
node $LOOM mcp list               # approved servers from the registry
node $LOOM mcp add jira-mcp   # merges into .mcp.json + .cursor/mcp.json
cat .mcp.json                      # the server entry, secrets as ${REFERENCES}
# The command prints which secret env vars you must export yourself.
```

For your org: `git clone` your `awesome/mcp`-style registry repo somewhere
and set `policy.mcp.registry` to that path.

### Definition of done for Epic 8

- [x] `McpRegistry` parses `server.json` (stdio + streamable-http) from a configurable path
- [x] A malformed `server.json` is skipped, not fatal
- [x] `loom mcp list` shows approved servers; `loom mcp add` provisions one
- [x] stdio servers map to `{command,args,env}`; http servers to `{url,headers}`
- [x] Secrets are written as `${REFERENCES}`; required ones are printed for the user
- [x] loom never reads, stores, or commits a credential value
- [x] No org-internal registry is hardcoded — loom stays generic
- [x] `npm test` passes (216 tests)

> Caveat: approved-MCP tool calls are not Bash and bypass the policy engine — the
> allowlist is the trust boundary. See `docs/known-limitations.md`.

---

## Epic 10 — Onboarding & Control

**What was delivered**: a frictionless first-run experience and the brakes.

- `loom doctor` — checks Node 20+, git, the `claude` CLI, and `gh`, and reports the
  init state. Exits non-zero only if a *required* prerequisite (Node, git) is missing.
- A developer-facing `README.md` that leads with how you stay in control, then a
  first-10-minutes path, then full reference. `docs/RELEASING.md` covers npm publishing.
- `loom stop` — signals a running supervisor to halt gracefully (in-flight stories
  finish, no more dispatch). The run is resumable with `loom run`.
- `loom run --checkpoint story|epic` — runs one story (or one epic) and stops cleanly
  at that boundary; `loom run` with no flag completes everything.

### Automated tests

```bash
npm run test -w @loom-ai/core   # ControlStore + Supervisor checkpoints & stop
npm run test -w loom-ai         # loom doctor, loom stop
```

### Manual verification

```bash
LOOM=/Users/jeromeortega/Repos/loom/packages/loom-cli/dist/index.js
node $LOOM doctor                       # prerequisite check — try it anywhere

# In a repo with approved epics:
node $LOOM run --checkpoint epic        # runs one epic, halts; review, then:
node $LOOM run                          # continues — completed stories skipped
# In another terminal, during a run:
node $LOOM stop                          # graceful halt
```

### Definition of done for Epic 10

- [x] `loom doctor` checks Node/git/claude/gh and reports the init state
- [x] `loom doctor` exits non-zero only when a required prerequisite is missing
- [x] A clear developer README leads with control, then a first-10-minutes path
- [x] `loom-ai` package.json has the metadata for `npm install -g`; `docs/RELEASING.md` exists
- [x] `loom stop` halts a run gracefully; the run resumes with `loom run`
- [x] `loom run --checkpoint story` runs one story then halts
- [x] `loom run --checkpoint epic` runs one epic then halts
- [x] A halted/in-progress epic is picked up on the next `loom run` (resumable)
- [x] `run()` clears a stale stop signal from a previous run
- [x] `npm test` passes (225 tests)

---

## Epic 13 — Cursor CLI Backend

**What was delivered**: loom can plan and execute stories with Cursor's
`cursor-agent` CLI as an alternative to Claude Code — both session-based, no API
key, never MAX mode.

- `CursorCliClient` — an `LLMClient` that runs the planner via
  `cursor-agent -p --output-format json --model <id> --mode ask --trust`
  (`--mode ask` is read-only, the planner never writes files).
- `CursorAgentWorker` — a `WorkerRunner` that runs story implementation via
  `cursor-agent -p --model <id> --force --trust`.
- `BaseCliWorker` — the shared run flow (worktree spawn, commit counting, PR
  open, log tail) extracted so `ClaudeCodeWorker` and `CursorAgentWorker` are
  thin: each only supplies `binary()` and `agentArgs()`.
- Backend selection: `policy.agents.llm_backend` (`claude-cli` | `cursor-cli` |
  `anthropic-api`) and `policy.agents.worker_backend` (`claude-code` |
  `cursor-cli`). `modelFor()` resolves the right model id per backend — Cursor
  uses its own ids (`sonnet-4`), so `cursor_model` applies to every role when
  the Cursor backend is active.

### Automated tests

```bash
npm run test -w @loom-ai/core   # Backend.test.ts — see below
```

`packages/loom-core/src/__tests__/Backend.test.ts` covers:

- `parseCursorJson` — extracts text from `result`/`text`/`response`/`content`,
  and falls back to raw stdout for non-JSON output.
- `createLLMClient` — returns the right client per backend; defaults to the
  session-based `claude-cli`.
- `createWorker` — returns `ClaudeCodeWorker` / `CursorAgentWorker` per backend.
- `modelFor` — role-specific Claude ids for `claude-cli`, the single
  `cursor_model` for every role under `cursor-cli`.
- `CursorCliClient` / `CursorAgentWorker` construct without an API key.

The subprocess dispatch itself (spawning `cursor-agent`) is an integration seam
and is not unit-tested — same convention as `ClaudeCliClient`/`ClaudeCodeWorker`.

### Manual verification

```bash
# In .loom/policy.yaml set:  agents.llm_backend: cursor-cli
#                             agents.worker_backend: cursor-cli
node $LOOM doctor                       # warns if `cursor-agent` is not installed
node $LOOM epic "<brief>"               # planner runs via cursor-agent --mode ask
```

### Definition of done for Epic 13

- [x] `CursorCliClient` runs the planner via session-based `cursor-agent`
- [x] `CursorAgentWorker` runs stories via session-based `cursor-agent`, never MAX
- [x] `BaseCliWorker` extraction removed worker duplication (no copy-paste)
- [x] `llm_backend` / `worker_backend` select the backend; `modelFor` resolves ids
- [x] `loom doctor` probes `cursor-agent` (warn-level — Cursor is optional)
- [x] `npm test` passes (237 tests)

> **Known gap**: the loom guardrail hook is wired into Claude Code's
> `.claude/settings.json` PreToolUse. Cursor's `cursor-agent` does not read that
> file, so a `worker_backend: cursor-cli` agent runs `--force` without the
> structural PreToolUse guard. See `docs/known-limitations.md`. Until a Cursor
> hook is added, prefer `worker_backend: claude-code` for guarded autonomous
> runs, or run the Cursor worker under `--checkpoint` with human review.

---

## Epic 14 — pi.dev UI Surface (REMOVED)

**Originally delivered**: `@loom-ai/pi`, a pi.dev extension. **Removed**
before the internal alpha because pi.dev was not an approved tool. The
visibility/control loop this surface provided is now served by
`loom web` (see the `architecture/web-ui.md` doc). The historical planning
artifacts in `epics/epic-014.yaml` and `docs/reviews/epic-14-review.md`
remain as a record of what was tried.

---

## Epic 11 — Multi-Product Orchestration

**What was delivered**: a single view across every loom repo on a machine, and
a machine-wide worker cap so several products do not collectively exhaust the
developer's Claude session.

- `ProjectRegistry` (`<loomHome>/projects.json`) — `loom init` records the
  repo; reads self-heal (a registered directory that no longer exists is
  pruned, never fatal).
- `loom status --all` — aggregates the epic/agent tree across every registered
  project; plain `loom status` is unchanged.
- `MachineConfig` (`<loomHome>/config.json`) — `max_global_workers` sets the
  machine-wide cap. This is **per-machine** config: each machine has its own
  `~/.loom/config.json`, so the cap can differ from machine to machine.
- `GlobalLimiter` — a SQLite-backed semaphore under `<loomHome>` shared across
  processes. Each supervisor acquires a slot before dispatching a worker; the
  sum of in-flight workers across all loom runs never exceeds the cap. A
  crashed run's slots are reclaimed (holder pid is dead) on the next acquire.
- `loomHome()` — `~/.loom`, overridable with `LOOM_HOME` (used by tests).
- `loom doctor` now reports the machine config path and the global cap.

### Automated tests

```bash
npm run test -w @loom-ai/core   # ProjectRegistry, GlobalLimiter, Supervisor
```

- `ProjectRegistry.test.ts` — register + dedup, prune-missing-directory,
  corrupt-file tolerance, unregister.
- `GlobalLimiter.test.ts` — capacity cap, release frees a slot, the cap is
  shared across separate instances (cross-process), a dead holder is reclaimed;
  `processAlive`; `loadMachineConfig` parsing.
- `Supervisor.test.ts` (`Supervisor + GlobalLimiter`) — the limiter caps
  concurrency below `maxConcurrent`; a run *waits* for a slot rather than
  exiting when the cap is full; an unset limiter changes nothing.

### Manual verification

```bash
# Set a machine-wide cap (per machine — this file is not committed):
echo '{ "max_global_workers": 4 }' > ~/.loom/config.json
node $LOOM doctor                       # reports the cap
node $LOOM status --all                 # aggregate across every registered repo
```

### Definition of done for Epic 11

- [x] `loom init` records the repo in `<loomHome>/projects.json`
- [x] `loom status --all` aggregates epic/agent status across every project
- [x] A registered project whose directory is gone is pruned, not fatal
- [x] Plain `loom status` (no `--all`) is unchanged
- [x] `max_global_workers` in the machine config sets a global cap
- [x] Each supervisor acquires a shared slot before dispatch
- [x] In-flight workers across all runs never exceed the global cap
- [x] A crashed run's slots are reclaimed (not leaked permanently)
- [x] `npm test` passes (264 tests)

---

## Cost-aware planning (commit `438fde0`)

**What was delivered**: the cheap half of cost governance — refine before you
plan, route models per role, see what planning actually cost.

- `loom brief "<rough idea>"` — a single Sonnet call against the bundled
  `loom-brief-builder` skill, prints a tightened brief BEFORE the Opus
  planner spends tokens. Avoiding one wasted Analyst→PM→Architect cycle
  pays for many of these.
- Tiered model routing — Opus 4.7 (xhigh) on the planner only; Sonnet on
  workers; Haiku on skill-gen / judge. Configurable per role.
- Schema v7 adds `planner_tokens_input` / `_output` / `_cached` / `planner_ms`
  to `epics`. `Planner.run` records them on completion; `loom status`
  displays them per epic.
- `policy.agents.planning_token_budget` (optional) — `loom epic` warns at
  the end of a planning run if input + output exceeded the budget.

### Tests

- `Planner.test.ts` — "writes planner token usage + wall time to each epic
  of the run".
- The README's "Cost-aware by design" section ships the value-prop.

Deeper cost work — context manifests, repo digest, diff-first prompts,
worker-level token tracking, per-story budget halt — is specced in
`epics/epic-016.yaml` for later.

---

## Epic 17 — One PR per epic

**What was delivered**: the unit of human review matches the unit of loom
work. Multi-story epics produce ONE PR with story commits preserved on the
epic branch.

- `policy.agents.pr_strategy` accepts only `per-epic`.
- `BaseCliWorker.maybeOpenPr` short-circuits in per-epic mode; workers commit
  on the story branch locally, do not push or open per-story PRs.
- Schema v8 adds `epics.base_sha`; the Supervisor captures it on the first
  dispatch for an epic (the first root-story worktree's `baseSha`).
- `EpicFinalizer` (new orchestrator module) topo-sorts succeeded stories by
  their declared dependencies, merges each in order onto `epic/<epic-id>`,
  pushes (subject to `allowed_remotes`), and opens one PR. Merge conflict
  on a story → fall back: drop the conflicting story from the epic PR,
  preserve its branch, log an audit entry.

### Tests

`packages/loom-core/src/__tests__/Supervisor.test.ts` adds a
`Supervisor + EpicFinalizer (per-epic PR strategy)` block:

- Per-epic happy path: real `--allow-empty` commits on each story worktree,
  finalize creates `epic/epic-001` with both story merges.
- LLM-throws fallback: an LLMClient that always throws on the PR-body
  generation — the run must complete (the catch in `composeBody` falls
  back to the hand-rolled body), and the epic branch is still built.

### Manual verification

```bash
# In a loom-initialized repo, after planning + approving an epic:
node $LOOM run                  # workers commit story branches locally;
                                 # finalizer merges them into epic/epic-001
                                 # and opens one PR (when allowed_remotes is set).
# Inspect the resulting branch / PR list:
git branch                       # epic/epic-001 plus any local story/* branches
gh pr list                       # one PR for the epic
```

### Definition of done for Epic 17

- [x] `pr_strategy` is `per-epic`
- [x] Workers honor the strategy (no per-story PR in per-epic mode)
- [x] Schema v8 + `base_sha` captured on first dispatch
- [x] EpicFinalizer merges story branches in dependency order
- [x] Merge-conflict fallback: per-story drop, recorded in audit log
- [x] README documents the change; known-limitations records trade-offs
- [x] Tests cover per-epic happy path, LLM-throw fallback, per-story mode
- [x] `npm test` passes

---

## Epic 18 — Pre-PR code review (foundation slice)

**What was delivered**: the agents and the PR-description integration. Story
018-002 (worker-side block-and-revise) and story-018-004 (`loom review` CLI
+ dashboard surfacing) remain specced.

- `packages/loom-core/skills/loom-pr-description/SKILL.md` — bundled rubric
  for PR descriptions: lead with the user-visible outcome, name files to
  review first, flag risky changes, mark what readers can skim, cover testing
  notes and open questions.
- `packages/loom-core/src/review/`:
  - `ReviewFinding` / `ReviewReport` types.
  - `CodeReviewAgent` — single LLM call against the `loom-code-review`
    skill; expects a fenced JSON block; defensive parser (never throws).
  - `PrDescriptionAgent` — single LLM call against the new
    `loom-pr-description` skill; produces a markdown body from story
    context + `git diff --stat` + `git log --oneline`.
- `EpicFinalizer.composeBody` integration: when an `llmClient` is supplied
  the finalizer asks `PrDescriptionAgent` to write the PR body; falls back
  to the hand-rolled `epicPrBody` on any error. The conflict-note section
  is appended deterministically so the model can't lose it.

### Tests

`packages/loom-core/src/__tests__/Review.test.ts` adds:

- `parseReviewReport` — fenced JSON, no JSON block, malformed findings (all
  three paths assert defensive behavior — never throws).
- `CodeReviewAgent.review` — scripted MockLLMClient → structured report.
- `PrDescriptionAgent.generate` — scripted MockLLMClient → body verbatim.

### Manual verification

```bash
# Per-epic with LLM body generation requires policy.git.allowed_remotes set
# AND a real `gh` install. The unit tests cover the in-process path
# (composeBody → PrDescriptionAgent.generate); the gh CLI step is the same
# call BaseCliWorker uses for per-story PRs today.
```

### Definition of done for Epic 18 foundation

- [x] `CodeReviewAgent` + `PrDescriptionAgent` shipped with defensive parsing
- [x] Bundled `loom-pr-description` skill
- [x] `EpicFinalizer` uses `PrDescriptionAgent` when llmClient is supplied
- [x] Hand-rolled fallback on LLM error (tested)
- [x] `npm test` passes

Remaining (specced, not built):

- [ ] story-018-002: worker review pass with comment / block-and-revise modes
- [ ] story-018-004: `loom review` CLI + dashboard surfacing

---

## Epic 66 — Durable, Recoverable Epic Finalization

**What was delivered:** `loom finalize --resume <epic-id>`, plus automatic recovery routing inside `loom run`, `loom publish`, and `loom reconcile`. An epic that was interrupted mid-finalization (network drop between push and PR-open, force-killed process, concurrent lock failure) can now be carried to `done` without redoing merged work.

### Recovery flow (strand → resume)

When the EpicFinalizer is interrupted after pushing the integration branch but before opening the PR, the epic is left in `finalizing` (or `publish_pending` if the push succeeded but PR-open failed). The operator-visible recovery path:

```
# loom run reports:
  Skipped: epic-001
  Recover it: loom finalize --resume epic-001

# Operator runs:
loom finalize --resume epic-001

# Output on success:
  PR: https://github.com/org/repo/pull/42
  Epic epic-001 driven to done.
```

`EpicFinalizer.resume()` reads git and gh state to detect which phases remain:

| Detected state | Action taken |
|---|---|
| PR already open for the pushed ref | Records the PR URL and flips to `done` |
| Branch pushed, no PR | Opens the PR, records URL, flips to `done` |
| Integration tree built but not pushed | Pushes the branch, opens the PR, flips to `done` |
| Epic already `done` | No-op |
| No recoverable state (no remote, or remote not in `allowed_remotes`) | Exits non-zero; prints reason (e.g. `no remote configured` or `remote "…" is not in policy.git.allowed_remotes`) |

### Automatic recovery in `loom run`

`loom run` automatically routes `finalizing` and `publish_pending` epics through `EpicFinalizer.resume()` **before** dispatching new stories. If auto-resume succeeds, the epic moves to `done` and appears in `epicsProcessed`. If it fails (no remote, concurrent lease, or a gate block), the epic is moved to `epicsSkipped` and `loom run` prints:

```
  Skipped: epic-001
  Recover it: loom finalize --resume epic-001
```

The recovery command string in this output is byte-identical to the `loom finalize` invocation so operators can copy-paste it directly.

### Changed command behavior

| Command | Before epic-066 | After epic-066 |
|---|---|---|
| `loom run` | Skipped `finalizing`/`publish_pending` epics with no recovery hint | Automatically resumes them via `resume()`; prints copy-paste recovery hint on failure |
| `loom publish <epic-id>` | Accepted only `publish_pending` epics | Also accepts `finalizing`; delegates to `resume()` |
| `loom reconcile <epic-id>` | Accepted `in_progress` epics; required branch to be pre-merged | Also accepts `finalizing`; delegates to `resume()` which detects merge state |

### Automated tests

```bash
npm run test -w loom-ai    # runRecovery.test.ts, finalize.test.ts, publish.test.ts, reconcile.test.ts
npm run test -w @loom-ai/core   # SupervisorRecovery.test.ts
```

### Definition of done for Epic 66

- [x] `loom finalize --resume <epic-id>` command exists and is registered
- [x] `loom run` routes `finalizing`/`publish_pending` epics to `resume()` within the same run (after the story-dispatch loop)
- [x] `loom run` prints `  Recover it: loom finalize --resume <epic-id>` when auto-resume is impossible
- [x] `loom publish` accepts `finalizing` and delegates to `resume()`
- [x] `loom reconcile` accepts `finalizing` and delegates to `resume()`
- [x] `docs/capabilities.md` documents `loom finalize --resume` and updated `run`/`publish`/`reconcile` surfaces
- [x] `README.md` reflects the new and changed command surface
- [x] `npm test` passes

---

## Epic 68 — Toolchain-Aware Integration Gate

**What was delivered:** The integration gate is now multi-step and toolchain-aware. Instead of running only a single unit-test command, the gate resolves an ordered `GateStep[]` plan — one unit step plus zero or more toolchain steps — and runs every step independently, reporting per-step pass/fail and wall-clock. `loom doctor` now also executes the gate on the current project via a `gate-runnable` real-exec check.

### New toolchain step detection

The gate appends toolchain steps after the unit step, in fixed order:

| Signal file | Step name | Command |
|---|---|---|
| `tsconfig.json` | `typecheck:tsc` | `npx --no-install tsc --noEmit` |
| `next.config.*` or `next` dep in `package.json` | `build:next` | `npx --no-install next build` |
| `go.mod` | `build:go` | `go build ./...` |
| `Cargo.toml` | `build:cargo` | `cargo build --workspace` |

uv-managed Python projects rewrite the unit step command:

| Signal | Command |
|---|---|
| `[tool.uv.workspace]` in `pyproject.toml` | `uv run --all-packages pytest` |
| `[tool.uv]` section or `uv.lock` present | `uv run pytest` |

When `policy.agents.test_command` is set, all auto-detection is suppressed and only the configured command runs as the single unit step.

### Operator wall-clock note

Build steps run full compilations and materially increase gate time. `build:next` (`next build`) and `build:cargo` (`cargo build --workspace`) can each add minutes on non-trivial projects. When `integration_gate: block` is configured on a repo with Next.js or Rust in scope, budget for the additional compilation time.

### Gate-runnable doctor check

`loom doctor` now includes a `gate-runnable` check that actually executes the resolved gate plan via `resolveGatePlan` + `runGateSteps` on the current project directory. The check:

- Resolves the same steps the EpicFinalizer would run (configured override or auto-detected)
- Runs every step and collects per-step outcomes
- Reports `ok` when all steps pass; reports `failed: <step-name> exited <N>` on failure
- Is advisory only (`required: false`) — never flips doctor's own exit code
- Detects PATH divergence (a binary found on the login shell but absent in the gate's non-interactive `/bin/sh`) and reports it explicitly

```
# Example doctor output when all steps pass:
✓ gate-runnable: gate ran and passed (2 step(s) in 14s)

# Example output when a step fails:
✗ gate-runnable: gate failed: typecheck:tsc exited 1 (...)
```

### Automated tests

```bash
npm run test -w @loom-ai/core   # GatePreflight.plan.test.ts, GatePreflight.toolchain.test.ts, GatePreflight.uv.test.ts, IntegrationGate.steps.test.ts
npm run test -w loom-ai         # doctorGateCheck.test.ts
```

### Manual verification

```bash
# In a TypeScript + Next.js repo:
loom doctor
# Expect a gate-runnable check that shows typecheck:tsc + build:next steps

# In a Python uv workspace:
loom doctor
# Expect gate-runnable to run `uv run --all-packages pytest`

# In a repo with no detectable test suite:
loom doctor
# gate-runnable: no gate steps to run; gate runs amputation check only
```

### Definition of done for Epic 68

- [x] `resolveGatePlan()` returns ordered steps: unit + toolchain (tsc/next/go/cargo) based on detected signals
- [x] uv-aware Python detection rewrites the unit step to `uv run pytest` or `uv run --all-packages pytest`
- [x] All steps run independently (no short-circuit on failure — ADR-3)
- [x] `loom doctor` includes the `gate-runnable` real-exec check (advisory, `required: false`)
- [x] `docs/capabilities.md` documents all four: toolchain auto-detection, uv gate, per-step reporting, gate-runnable check
- [x] `README.md` mirrors the gate behavior at overview depth
- [x] Operator wall-clock note for build steps is present in capabilities and README
- [x] `npm test` passes

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `loom: command not found` | `npm install -g` not run yet | Run from repo root: `npm link -w loom-ai` |
| `Cannot find module '@loom-ai/core'` | Build hasn't run | `npm run build` |
| `loom guard check` always allows | `.loom/policy.yaml` missing or malformed | Run `loom init` again or check YAML syntax |
| Cursor MCP panel doesn't show loom | `loom` binary not on PATH | `npm link -w loom-ai` or set absolute path in `.cursor/mcp.json` |
| Tests fail with FTS5 errors | better-sqlite3 not built with FTS5 | `npm rebuild better-sqlite3` |
