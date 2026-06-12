# Planning eval

The planning eval runs loom's full planning pipeline (Analyst → PM → Architect)
against real Claude on six hand-curated briefs and grades the output's
**structure** — epic count, story count, dependency validity. It's the
sharpest feedback loop on loom's planning prompts.

## Run

```bash
node scripts/eval.mjs                         # all six cases, ~5–10 min
```

Output:

```
  Running the planning eval suite — 6 cases.
  Each case runs the full planner; this takes several minutes.

  [PASS] single-feature-cli
  [PASS] rest-api-endpoint
  [PASS] bugfix-small
  [PASS] auth-feature
  [PASS] data-pipeline
  [PASS] refactor-scoped

  Score: 6/6 (100%)
```

Each case lives in `packages/loom-core/eval-cases/planning.yaml`. The
graders are in `packages/loom-core/src/eval/EvalRunner.ts`.

## What it measures (and what it doesn't)

It **measures**:

- Does the persona chain produce **N epics in the expected range**? E.g.,
  `single-feature-cli` expects 1 epic; `data-pipeline` expects 1–3.
- Does it produce **M stories in the expected range**? E.g.,
  `single-feature-cli` expects 2–8.
- Are **story dependencies valid** — do all `dependencies: [...]` refer
  to real story IDs in the same plan, with no cycles?

It does **not** measure:

- Whether the brief / PRD / architecture text is *good prose*. That's
  prompt-tuning craft, evaluated by human reading.
- Whether the implementation against the plan would *work* — that's the
  SWE-bench bench's job.
- Specific persona output content. We deliberately don't pin "the PRD
  must contain the word X" — too brittle, no value.

## Why it works as a loom test (and not a Claude test)

The structural checks (epic count, story count, dep validity) are
**loom-shaped**: they catch regressions in:

1. **Persona prompt drift.** A PM persona that softens "default to one
   epic" tips the over-decomposition baseline. The eval catches this.
2. **Planner code paths.** Bug in the YAML rewrite step, the validation
   retry loop, the epic-numbering offset — eval catches.
3. **Model behavior shift that surfaces a brittle prompt.** When Claude
   4.7 came out and started producing more verbose PRDs, the eval went
   from 6/6 to 2/6, exposing that our "Prefer 3–8 stories" wording was
   too soft. We tightened to "DEFAULT to ONE epic" and recovered to
   6/6. ([Session record.](runbook.md#run-3))

When the eval moves, **loom changes** — either the personas got worse
(rare), or the prompts have to adapt to keep producing sound structure.

## How the planning eval guards against over-decomposition {#over-decomposition}

This is the regression the eval exists to catch. The PM persona
defaults to ONE epic; a verbose PRD with unbounded FRs can override
that and produce 3–6 epics for a one-paragraph brief. The cases:

| Case | Brief size | Expected | A bad run looks like |
|---|---|---|---|
| `single-feature-cli` | One paragraph | 1 epic, 2–8 stories | 3 epics, 12 stories |
| `rest-api-endpoint` | One paragraph | 1–2 epics, 2–10 stories | timeouts (10 min/call) or 4+ epics |
| `bugfix-small` | One sentence | 1 epic, 1–5 stories | 2+ epics, 8+ stories |
| `auth-feature` | One paragraph | 1–2 epics, 4–14 stories | 6 epics, 26 stories |
| `data-pipeline` | One paragraph | 1–3 epics, 4–20 stories | 6 epics, 22 stories |
| `refactor-scoped` | One sentence | 1 epic, 2–8 stories | 6 epics, 20 stories |

The score in `node scripts/eval.mjs` IS the over-decomposition gauge. When it
drops, the PM persona prompt is the first place to look.

## Stochasticity (and the timeout caveat)

Claude isn't deterministic. Same prompt, same model, ±some output
variance. The eval is robust to small variation (we use ranges, not
exact counts) but two things bite:

1. **A single LLM call can stall.** The default per-call timeout is
   10 min. On a slow turn (rate limit, network jitter), a case can
   fail with `claude CLI timed out after 600000ms` even though the
   underlying prompt is fine. Re-run before reading too much into one
   failure — [Run 4 vs Run 5](runbook.md#run-4-vs-run-5) showed this
   pattern (5/6 then 6/6 against unchanged code).
2. **Single-run scores are noisy.** A persona PR moves the eval from
   6/6 to 5/6 — could be regression, could be one timeout. For
   important changes, run the eval 2–3 times to separate signal from
   variance.

Pin temperature when `claude-cli` exposes it; until then, accept the
noise and re-run.

## When to run

- **Before a persona / prompt PR.** Always. A persona change should
  not land without an eval pass.
- **Before any release.** Catch drift introduced by other changes.
- **Weekly as a drift check.** Even without loom changes, a model
  release can shift behavior.

## When not to bother

- Per-commit CI. Too slow, too noisy, no incremental benefit.
- After a worker-side or schema-only change. The eval doesn't touch
  worker code or the DB schema — running it just burns session
  capacity.

## Configuration

```bash
# Override the backend (default: claude-cli, session-based)
LOOM_EVAL_BACKEND=anthropic-api node scripts/eval.mjs

# Override the model (default: from policy.agents.planning_model)
LOOM_EVAL_MODEL=claude-opus-4-7 node scripts/eval.mjs
```

Each `node scripts/eval.mjs` run also writes a row to `eval_runs` in the SQLite
DB so trend data accumulates locally. Future `node scripts/eval.mjs --compare`
will surface the delta vs the previous run.

## Adding a case

Edit `packages/loom-core/eval-cases/planning.yaml`:

```yaml
- id: my-new-case
  description: A short label for the case
  brief: >
    The brief, as if the operator typed it into loom epic.
  expect:
    minEpics: 1
    maxEpics: 1
    minStories: 2
    maxStories: 6
    dependenciesValid: true
```

Then `node scripts/eval.mjs` includes it. Cases should:

- Be **short**. A one-paragraph brief is right; a multi-page spec
  is testing the wrong thing.
- Have **calibrated bounds**. Run the case 2–3 times against a
  known-good build to learn the range; set bounds at 1.5× the
  observed variance.
- Cover a **distinct planning failure mode**. The existing six
  cover: tiny features, focused APIs, one-line bugs, broader
  features, multi-step pipelines, scoped refactors. New cases
  should target a gap.

## See also

- **[Testing runbook](runbook.md)** — historical eval run results (Runs 1–5)
  and detail on the over-planning fix.
- **[SWE-bench Lite bench](swe-bench-lite.md)** — the next layer:
  measures whether the plan, once executed, produces working code.
