# Testing

How loom tests *itself*, and — crucially — what it deliberately doesn't.

---

## Principle: test the orchestration, not the LLM

A useful test catches a bug in loom's code, prompts, or data flow. A useless
test catches a stylistic difference in what Claude or Cursor happened to
output today. The line is sharp on purpose:

> **If changing loom can make the test pass or fail, it's a loom test.
> If changing only the LLM (model version, vendor, temperature) can make
> it pass or fail, it's not a loom test — that's an LLM evaluation, which
> belongs to its own dedicated pipeline.**

This rules out a whole class of tempting-but-wrong tests:

- ❌ Tests that assert "Claude wrote a `for` loop" — the model decides
  control flow; we don't pin it.
- ❌ Tests that grade skill content quality (a skill is good because the
  worker uses it well, not because a test thinks the prose reads well).
- ❌ End-to-end "did the agent write code that compiles" assertions
  bolted into the unit test suite. Compilation is downstream of loom's
  job; if loom dispatched correctly, the test of *loom* passed.

And lets us write tests we actually trust:

- ✓ The SkillSelector returns N candidates ranked by overlap given a
  fixture story and a fixture skill set.
- ✓ The Supervisor persists `agents.review_status='blocked'` when the
  worker reports a blocker.
- ✓ `BaseCliWorker.parseStreamLine` extracts cumulative token usage
  from a fixture stream-json event.

These are deterministic — they catch real bugs and never flake on a
model release.

## Three pipelines, three jobs

| Pipeline | What it tests | LLM involved? | Cost | When to run |
|---|---|---|---|---|
| **[Unit tests](unit-tests.md)** | Every code path in `loom-core` / `loom-cli` / `loom-mcp` / `loom-web` | No — mocks + stubs | Free, ~15 sec | Every commit, every PR, CI |
| **[Planning eval](planning-eval.md)** | The persona prompts + planner orchestration produce sound epic/story decomposition | Yes — real Claude | Free on session auth; ~5–10 min | Before persona/prompt PRs, weekly drift check |
| **[SWE-bench Lite bench](swe-bench-lite.md)** | Loom's end-to-end pipeline produces working code on real GitHub issues | Yes — real Claude | Session capacity, ~1–2 hrs / 10 tasks | Before/after model swaps, before releases |

Read each page to learn when it pays back. **Most days you only run the
unit tests.** The eval and bench are quality probes, not gates.

## What's NOT in any pipeline

Deliberate omissions, in case you're tempted to add them:

- **Compiling / type-checking the worker's output.** Loom orchestrates a
  worker that compiles its own work; if the worker leaves uncompiled
  code, the worker fails its commits. We don't double-test compilation
  from loom's side.
- **Verifying skill prose is "good."** Skills earn their place by the
  lifecycle (candidate→active→disabled). A skill that doesn't help
  workers gets demoted automatically. A static prose test would freeze
  bad skills as "passing."
- **Asserting specific Claude output strings.** Today Sonnet 4.6, tomorrow
  Sonnet 5; loom keeps working, but the test would brittle out.
- **Reproducing exact SWE-bench resolution rates.** Same reason — the
  rate shifts with model versions. We use the bench to *compare* runs
  (before/after a loom change), not to gate at an absolute number.

## How to know if a new test is loom-shaped

Ask: *"If I rolled back the LLM to the previous version and re-ran this
test, would it still pass?"*

- **Yes** → it's a loom test. Use a mock LLM, write deterministic
  assertions.
- **No** → it belongs in the eval or the bench, not the unit suite.

## Where the runbooks live

Long-form, manual-verification runbooks (separate from the pipeline pages):

- **[Testing runbook](runbook.md)** — per-epic manual verification steps and
  the historical eval-result log (Runs 1–5).
- **[SWE-bench runbook](swe-bench-runbook.md)** — operator details for
  downloading the dataset, configuring scoring, interpreting predictions.
