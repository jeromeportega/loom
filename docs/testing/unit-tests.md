# Unit tests

The day-to-day pipeline. Every code path in loom, tested deterministically
with mocks. **No LLM, no network, no real CLI subprocess.** Catches loom
bugs without paying for model calls.

## Run

```bash
npm test                           # full suite across all packages
npm test -w @loom-ai/core         # just one package
npm test -w @loom-ai/core -- --test-name-pattern=Supervisor   # one file
```

About 340 tests as of 2026-05-24. ~15 seconds to run.

## What it covers

- **State stores** — `EpicStore`, `AgentStore`, `AuditLog`, `SkillUsageStore`,
  `ControlStore`. Round-trip persistence, query shapes, migration paths.
- **Orchestrator** — `Supervisor` (dispatch, dependency ordering,
  checkpoints, stop signal, max_concurrent, skill injection, event
  surface, review/cost persistence), `EpicFinalizer` (per-epic PR
  merge logic), `WorktreeManager`.
- **Worker base** — `BaseCliWorker` review pass (`off` / `comment` /
  `block-and-revise`), `parseStreamLine` for cost tracking,
  `workerPrompt` rendering (incl. tech-notes, dependencies, image refs,
  revision context).
- **Planning** — `Planner.run` orchestration, `AnalystAgent` /
  `PMAgent` / `ArchitectAgent` (with mock LLMs returning fixture text),
  `validateEpicSet`, image copy + YAML rewrite.
- **Skills** — `SkillStore` discovery, `SkillSelector` overlap scoring,
  `SkillGenerator` extraction flow (mock LLM), `SkillJudge`,
  `SkillLifecycle` promotion/demotion thresholds.
- **Review** — `CodeReviewAgent` JSON parsing (incl. defensive paths
  for malformed responses), `PrDescriptionAgent`.
- **Bench** — `SweBenchLoader` (both dataset shapes), `SweBenchRunner`
  (clone → runLoom callback → diff capture, with a local file:// repo
  fixture), `writePredictions`.
- **Guardrails** — `PolicyEngine` enforcement against forbidden flags,
  protected paths, allowed remotes.
- **LLM clients** — `MockLLMClient` plumbing, `parseClaudeJson`,
  `parseCursorJson`.
- **CLI** — `init`, `mcp`, basic command wiring.
- **MCP server** — every tool handler against a fixture context.

## What it doesn't cover

By design (see [philosophy](index.md#principle-test-the-orchestration-not-the-llm)):

- LLM output quality — that's the planning eval's job.
- Resolution rates on real codebases — that's the SWE-bench bench.
- Skill *content* — skills earn their place via the lifecycle, not a
  static test of prose.
- Whether `claude` or `cursor-agent` is correctly installed — runtime
  concern caught by `loom doctor`.

## How tests are organized

Every test lives next to the code it tests:

```
packages/loom-core/src/
  orchestrator/Supervisor.ts
  __tests__/Supervisor.test.ts          # tests Supervisor.ts
  bench/SweBenchRunner.ts
  __tests__/SweBench.test.ts             # tests bench/*
```

Test framework: **`node:test`** (Node's built-in runner). Assertions:
`node:assert/strict`. No Jest, no Vitest. Keeps the dependency surface
small.

## Mock LLM pattern

LLM-touching code paths in unit tests use `MockLLMClient`:

```ts
import { MockLLMClient } from '@loom-ai/core';

// Scripted: queues responses in order
const llm = new MockLLMClient([RESPONSE_1, RESPONSE_2]);

// Responder: function-based, can branch on the request
const llm = new MockLLMClient((req) => {
  if (req.messages[0].content.includes('JSON')) return JSON_RESPONSE;
  return PROSE_RESPONSE;
});
```

This is the pattern that keeps tests deterministic. If a test wants to
exercise "what happens when the LLM returns malformed JSON" — feed
`MockLLMClient` exactly that string. No model calls, no flake.

## Mock worker pattern

`MockWorkerRunner` is the worker-side analogue:

```ts
import { MockWorkerRunner } from '@loom-ai/core';

// Fixed result for every story
const worker = new MockWorkerRunner({ status: 'done', commitCount: 1 });

// Per-assignment responder
const worker = new MockWorkerRunner(async (a) => {
  return { status: 'done', commitCount: 1, summary: `mock ${a.storyId}`, logTail: '' };
});
```

Tests of the Supervisor (event order, persistence, retry logic) use
this — they don't spawn `claude` subprocesses.

## When a test feels too elaborate

Trim. A test exercises **one** behavior. If it's setting up six fixture
files to verify two assertions, the wrong thing is under test. Common
shape:

```ts
it('persists review outcome to agents.review_status', async () => {
  // 1. Set up minimal state
  seedEpic('epic-001', [story('story-001-001')]);
  const db = openDatabase(path.join(repo, '.loom'));

  // 2. Run the unit under test with a tightly-scoped mock
  await new Supervisor({
    /* … */,
    worker: new MockWorkerRunner({ review: { status: 'commented', /* … */ } }),
  }).run();

  // 3. Assert the persistent state
  const agent = new AgentStore(db).getByStory('story-001-001');
  assert.equal(agent?.review_status, 'commented');
});
```

Three sections. If your test has six, split it.

## See also

- **[Planning eval](planning-eval.md)** — the next layer up, where the LLM is real.
- **[SWE-bench Lite bench](swe-bench-lite.md)** — the outermost layer.
- **[Testing runbook](runbook.md)** — manual verification steps per epic.
