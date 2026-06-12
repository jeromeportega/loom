# Session handoff — where loom stands

A single landing page so a fresh session can catch up without scrolling
through chat history. Updated 2026-05-26 mid-sprint after the cloud
skill loop + Tier-1 UX gap closure + cross-model review intervention
landing.

## TL;DR — current state

- **Baseline: 50% resolution rate on SWE-bench Lite (Run 8). Holds.**
  Run 9 (worker-prompt scope discipline) regressed to 3/10, reverted.
  Run 10f (cross-model review alone) regressed to 4/10, NOT promoted
  (stays opt-in via `policy.agents.review_model='cross'`).
- **Strategic finding from Runs 9 / 10d / 10e / 10f:** worker- and
  reviewer-layer interventions cannot be cleanly measured at 10-task
  N until planning variance is reduced. Same-task-same-config
  produces different outcomes because the planner decomposes the
  work differently each run. **Variance is the bottleneck.**
- **Path-to-70% pivot:** the intervention ladder
  (`docs/testing/runbook.md#interventions-toward-70`) reordered to
  put planning stability at #1. Next probe: a quick variance-
  measurement experiment (run same brief through planner 5 times,
  measure decomposition spread) before investing in any 10-task
  intervention measurement.
- **Visibility layer shipped (2026-05-27)** —
  `loom bench classify`, `loom bench compare`, `loom bench
  variance`. Replaces the manual failure-mode + cross-run prose in
  runbook writeups with mechanically reproducible structured
  output. See `docs/testing/runbook.md#visibility-layer` for usage.
  Validated against Run 9 → Run 10f compare — surfaced findings I'd
  missed manually.
- **Cloud skill loop is shipped end-to-end (#18 closes).** `loom
  skills sync`, `loom skills propose`, auto-propose policy machinery,
  shared-tier discovery in SkillStore, operator docs at
  `docs/operations/cloud-skills.md`. First canonical skill
  (`loom-code-review`) lives in `loom-skills`.
- **Tier-1 UX gaps closed** since Run 9: `loom revert <epic-id>`
  (CLI + MCP), `loom_stop_epic`, `pr_attribution` policy knob,
  `push_gate=confirm` policy knob, operator guidance side-channel
  (`loom guide` + `loom_guide_agent`), brief `quality_score`,
  `/api/projects` multi-repo directory.
- **Cross-model review (#20) shipped as an INTERVENTION CANDIDATE** —
  `agents.review_model='cross'` + `review_model_id`. Default OFF;
  needs its own Gate 3 measurement before promotion.
- **MCP surface: 8 action + 13 read = 21 tools** (started at 9).
  Newest action tool: `loom_retry_story` (resume/clean retry of a failed
  story; see `docs/architecture/worker-resilience.md`).
- **All system-level interventions still promoted** as default in
  `scripts/bench/run.sh`: `--review-strategy block-and-revise`,
  `--skill-generation off`, pre-clean skill cache.
- **Decision traces** capture worker reasoning to SQLite + `--preserve-all`
  flag means every run has full forensics regardless of pass/fail.

## What loom looks like today

Single-machine engineering substrate:

- **`loom epic "<brief>"`** — planner runs (Analyst → PM → Architect),
  writes epic to DB at start (status='planning'), updates phase per
  persona, flips to 'planned' at the end. Epic + original brief visible
  in `loom web` from t=0.
- **`loom brief "<rough>"`** — single Sonnet call against the
  `loom-brief-builder` skill, refines a rough idea into a focused
  brief.
- **`loom_refine_brief` (MCP tool)** — structured critique of a
  brief. Pi/Claude Code/Cursor call it before `loom_plan_epic` to
  catch ambiguity. See `docs/architecture/brief-refinement.md`.
- **`loom web`** — localhost dashboard. Token in URL fragment +
  sessionStorage. Live SSE stream of worker stdout + status diffs.
  Click an epic to see its brief, story rows with live log panes,
  approve/reject/stop controls, per-worker kill.
- **`loom bench swe-bench-lite`** — runs loom end-to-end against
  SWE-bench Lite tasks. Validated config is default in
  `scripts/bench/run.sh`.

## Test counts (mid-sprint, 2026-05-26)

- Full test suite green across the four packages:
  - `@loom-ai/core`
  - `@loom-ai/mcp`
  - `loom-ai` (CLI)
  - `@loom-ai/web`

## The 50% baseline — provenance + how to re-run

The headline number was reached via the methodology gates documented in
`docs/testing/bench-methodology.md`. Per-run analysis in
`docs/testing/runbook.md` (Run 6 through Run 8 + holdout).

Validated configuration (now default in `scripts/bench/run.sh`):

```bash
./scripts/bench/run.sh --limit 10
# → runs with --skill-generation off --review-strategy block-and-revise
# → pre-cleans ~/.loom/skills/generated/ to isolate the run
# → scores via uv run --with swebench at the end
```

Re-running the holdout (Gate 3 verification):

```bash
./scripts/bench/run.sh \
  --tasks packages/loom-core/eval-cases/swe-bench-holdout.json \
  --limit 10
```

Tuning + holdout sets are frozen at:

- `packages/loom-core/eval-cases/swe-bench-tuning.json` (50 tasks)
- `packages/loom-core/eval-cases/swe-bench-holdout.json` (50 tasks)

Reserved 200 tasks for the final external-comparison measurement —
not yet allocated.

## Methodology recap (read in full at `docs/testing/bench-methodology.md`)

Every bench iteration moves through five gates:

1. **Diagnose every failure** into one of nine categories (context
   retrieval, bad decomposition, wrong file selection, compile/runtime,
   test misunderstanding, over-editing, under-editing,
   dependency/tooling, flaky/environment).
2. **Hypothesize the fix.** Every code change responds to a named
   failure class with a predicted distribution shift.
3. **Tuning vs holdout.** Never tune against holdout; verify with
   it every 3-4 iterations or before promotion.
4. **Cost cap.** Track tokens, wall-clock, tool calls, regressions.
5. **Promotion rule.** Tuning improves, holdout doesn't drop, ≤1
   regression on tuning.

Don't loop until N%. Optimize the **system** — retrieval, planning,
patch strategy, validation behavior. The rate is the observable.

## Architecture — the major chunks

| Component | What | Docs |
|---|---|---|
| `@loom-ai/core` | Orchestrator, planner, supervisor, skills, state | `docs/architecture/index.md` |
| `@loom-ai/cli` | `loom` command | `docs/getting-started/index.md` |
| `@loom-ai/mcp` | MCP server — the primary loom surface | tool descriptions are the docs |
| `@loom-ai/web` | Localhost dashboard with SSE | `docs/architecture/web-ui.md` |
| Decision traces | Worker reasoning → SQLite, replayable | `docs/architecture/decision-traces.md` |
| Brief refinement | Pre-planner gatekeeper, MCP-callable | `docs/architecture/brief-refinement.md` |
| Worker resilience | Progress-aware timeouts, commit-on-exit, per-story handoff/resume | `docs/architecture/worker-resilience.md` |

## Open follow-ups (none block the baseline)

| # | Item | State | What to do |
|---|---|---|---|
| 1 | Polling/SSE thrash in `loom web` (back button broken on detail view, refresh sometimes fails to fetch) | **Fixed** (`8d28759`) | List polling separated from detail view; SSE drives detail updates in place |
| 2 | django-11019 Gate 1 diagnostic: wrong approach / over-engineering (458-line algorithm rewrite, 2/16 FAIL_TO_PASS) | Diagnosed | See `docs/testing/runbook.md` § django-11019 targeted reproduction |
| 2a | Run 9 — worker-prompt scope discipline regressed 5/10 → 3/10, reverted in `f61ecaa`; branch `worker-prompt-scope-discipline-v1` preserves the change | Rejected | v2 sketched in the runbook |
| 3 | Planning stochasticity | Documented, not fixed | Same brief produces different epic structures across runs. Likely needs temperature pinning when claude-cli exposes it |
| 4 | Cross-model review (Cursor-CLI multi-model session) | **Shipped as opt-in intervention** (`ffbceb8`) | Set `policy.agents.review_model='cross'` + `review_model_id`. Next Gate 3 candidate; recommend 1-task probe first |
| 5 | Diff-first worker prompts (#10 context spine) | Not started — capability work | Awaiting the cross-model review measurement; may overlap |
| 6 | Cloud skills (#9) | **Closed via #18** | All 5 stories shipped; `loom-skills` live; first canonical skill (`loom-code-review`) published; auto-propose policy machinery in place |
| 7 | Bench `--review-model` / `--review-model-id` flag passthrough on `bench.sh` | Open, small | Mirror how `--review-strategy` flows through — adds the per-task policy override for #20 probes |
| 8 | Worker resource caps (CPU / RAM / subprocess count) | Open, defensive | A bad worker can fork-bomb today. Filed in earlier scan |
| 9 | Multi-repo web UI federation (#15) | **First slice shipped** (`/api/projects`) | Full SSE-multiplex + cross-DB epic detail routing remains |
| 10 | LoomArchive + DX export (#19) | Designed, not built | New Python FastAPI service; internal API-service conventions captured in the issue. Multi-session lift |

## Major commits since the methodology + observability sprint

Use `git log --oneline -50` for the full list. Highlights (most recent first):

```
ffbceb8 feat(review): cross-model review via Cursor-CLI (#20 shipped opt-in)
cd81c36 feat(orchestrator): operator guidance side-channel — soft-lock recovery
4d2d7b2 feat(brief): quality_score on BriefRefinement
8962ffb feat(mcp): loom_revert_epic
94f7287 feat(cli): loom revert <epic-id> — local + optional remote teardown
c03f4f2 feat(finalizer): push_gate=confirm gates push on local merge
d8f779a feat(finalizer): pr_attribution policy knob — opt-in "Built by loom"
c67a4d9 feat(mcp): loom_stop_epic
9a325c5 feat(web): GET /api/projects — multi-repo first slice
68ac80d docs(operations): cloud-skills operator guide (closes #18 story-cloud-005)
ae777d6 feat(skills): auto-propose hook into SkillGenerator
27ebfec feat(skills): loom skills propose + auto-propose policy knobs
e0cdd89 feat(skills): SkillStore discovers ~/.loom/skills/shared/
9780953 feat(skills): loom skills sync command
ecb6172 feat(skills): SourcesConfig loader (story-cloud-001)
b008e69 feat(mcp): 8 introspection tools — read-side gap closed
e529eb2 feat(finalizer): prune story worktrees + branches after merge
f494c36 feat(bench): --preserve-all keeps every tempdir
35dd3eb docs(testing): Run 9 writeup — worker-prompt intervention rejected
f61ecaa revert(worker): scope-discipline prompt (Gate 3 fail)
327e00d docs(testing): django-11019 targeted reproduction Gate 1 diagnostic
3f9abf2 feat(web): per-tool human-readable tool_use rendering
```

## How to resume in a fresh session

If you're picking this up cold, the highest-leverage reads in order:

1. **This file** (`docs/operations/session-handoff.md`) — you're here.
2. **`docs/testing/bench-methodology.md`** — the five gates. The
   load-bearing change in process discipline.
3. **`docs/testing/runbook.md` § Run 6–8 + Holdout** — the data
   that justified the 50% baseline and how each intervention paid.
4. **`docs/architecture/index.md`** — system layout.

Then `git log --oneline -50` to see what's been moving and
`gh issue list --repo jeromeportega/loom` for open issues. The four open ones
are all deferred future work — none block normal use.

## What I'd do next, if pinned for a recommendation

Most of the items in the prior recommendation list shipped this
session. Updated for current state:

1. **Read the Run 10e 3-task probe outcome** when it lands. File at
   `~/loom-bench/predictions-20260526-225300.json`; harness scoring
   runs automatically at the end of the bench script. The runbook's
   intervention ladder predicts at least one more flip (most likely
   astropy-14995) beyond the 14182 already-flipped from Run 10d.
2. **Depending on 10e outcome:**
   - All 3 flip → 10-task tuning is fully justified; 70% target
     plausibly in reach.
   - 2 of 3 flip → still warrants 10-task; expect 70-75% range.
   - 1 of 3 (just 14182 again) → marginal signal; consider whether
     the single flip was task-specific. Probably worth one more 1-task
     probe on a different test-misunderstanding-class task before
     spending 10-task budget.
   - 0 of 3 → 14182's Run 10d flip was variance. Diagnose via
     preserved tempdirs; pick a different intervention from the
     ladder (worker-prompt v2 or diff-first prompts).
3. **Worker resource caps** (Open #8) — defensive, prevents a future
   bad worker from fork-bombing. ~1 hour. Lower priority than the
   intervention measurement above.
4. **Continue building #15 (multi-repo web UI federation)** — first
   slice is shipped, the full SSE-multiplex view is the next layer.
5. **LoomArchive + DX export (#19)** — multi-session lift, new
   Python service, Terraform. Save for a dedicated chunk of time.

What NOT to do:

- Don't burn a full 10-task tuning batch without 3-task confirmation.
  Use the 1/3/5 escalation per
  [[feedback-bench-authorization-and-frugality]].
- Don't loop the bench chasing rate.
- Don't change worker behavior between probes — single-variable rule.
  The combined intervention shipped (cross-model + revise-on-any) is
  the variable being measured RIGHT NOW; don't pile on another
  worker-prompt change until the measurement completes.
