# Architecture: Skill-Generator Eval Decision-Correctness Repair

## Architecture Philosophy

This is a surgical repair inside an existing, working framework — not a redesign. Three constraints drive every decision below.

1. **Minimum blast radius.** The skill generator's production behavior is correct and explicitly untouched. The shared gate-eval framework (`framework/coreMetrics.ts`, `decide.ts`, `runGateEval.ts`, `types.ts`) is consumed by five other evals (`brief-quality`, `intake`, `lesson-extractor`, `opportunity-engine`, `skill-judge`). The fix MUST live entirely under `packages/loom-core/src/eval/skill-generator/` so no other consumer's behavior shifts.
2. **The bug is a broken producer/consumer contract, not bad arithmetic.** The decision-correctness comparison in `score.ts` (`actual === expected`) is *correct*. It never executes because the metadata it reads (`gate.output._eval`) is never produced by `runGate.ts`. The PRD's two "compounding defects" are this one missing seam plus a denominator (`scoredCases`) that is coupled to LLM judging. We fix the seam and decouple the denominator; we do not rewrite the comparison.
3. **Make the contract compile-time, fail closed.** The defect survived because `_eval` was a runtime-only cast (`output as ... & { _eval? }`) that the type system never enforced, and the existing unit tests hand-built the metadata they should have received from the producer. We promote the contract to a required field and test the producer→scorer seam end to end, so this bug class cannot silently reopen. No fail-closed default is relaxed (NFR-2).

## Component Diagram

```mermaid
flowchart TD
    subgraph fixture["Fixtures (unchanged)"]
        YAML["eval-cases/skill-generator.yaml<br/>rubric.expected_decision, source"]
    end

    subgraph sg["skill-generator/ (in scope)"]
        LC["loadCases.ts"]
        RG["runGate.ts<br/><b>FIX 1: attach _eval</b>"]
        JD["judge.ts<br/>(skips NONE — unchanged)"]
        SC["score.ts<br/><b>FIX 2: scoredCases = decision-scored</b>"]
        CONS["consumer.ts (wiring)"]
        RUN["run.ts (main + report)"]
    end

    subgraph fw["framework/ (NOT modified)"]
        RGE["runGateEval.ts"]
        CM["coreMetrics.ts"]
        DEC["decide.ts"]
        T["types.ts"]
    end

    subgraph prod["production (NOT modified)"]
        SKG["skills/SkillGenerator.ts"]
    end

    YAML --> LC --> CONS
    CONS --> RGE
    RGE -->|runGate| RG -->|drives observe-only| SKG
    RG -->|GateOutcome + _eval| RGE
    RGE -->|judge if gate ok| JD
    RGE -->|RunRecord[]| SC
    SC -->|SkillGeneratorMetrics| DEC
    DEC -->|Decision| RUN
    RG -. reads .-> CM
    SC -. extends .-> CM
    RUN -->|".loom/eval/skill-generator-report.{md,json}"| OUT[(report)]
```

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (Node 20+, `"type":"commonjs"` in loom-core) | Matches the package; `__dirname` is available in `run.ts`. |
| Schema validation | `zod` (`caseSchema.ts`, judge `LLMResponseSchema`) | Already validates fixtures and judge output; no new dependency. |
| Test runner | `node:test` (built-in) | Existing eval tests use it; `npm test` discovers `dist/**/__tests__/*.test.js`. No vitest/jest. |
| LLM mock | Hand-rolled `LLMClient` stub (`makeMockLLM(responses[])`) | Deterministic, no live calls (NFR-1); the pattern already exists in `runGate.test.ts`. |
| State (eval isolation) | `better-sqlite3` `:memory:` db + `mkdtemp` SkillStore | Per-case isolation already in `runGate.ts`; untouched by this fix. |

## Data Models

The fix turns one optional, runtime-only field into a required, compiler-enforced one. Shapes that change are marked.

```typescript
// caseSchema.ts — fixture source of truth (UNCHANGED). The two fields the fix reads:
type SkillGeneratorCase = {
  id: string;
  source: 'worthy' | 'trivial' | 'borderline';
  rubric: { expected_decision: 'generate' | 'none' | 'either'; /* ...themes, traps */ };
  work: { /* story, summary, diff_context, existing_skills */ };
  rationale: string;
};

// judgeTypes.ts — the gate decision (UNCHANGED base) ...
type SkillGeneratorDecision = { decision: 'generate' | 'none'; skillMd: string | null };

// score.ts — the metadata carrier (UNCHANGED shape) ...
type SkillGeneratorDecisionMeta = {
  expectedDecision: 'generate' | 'none' | 'either';   // copied from rubric.expected_decision
  source: 'worthy' | 'trivial' | 'borderline';        // copied from case.source
};

// NEW dedicated gate-output type — makes the contract compile-time required (ADR-002).
// runGate.ts produces this; score.ts consumes _eval as a guaranteed field.
type SkillGeneratorGateOutput = SkillGeneratorDecision & { _eval: SkillGeneratorDecisionMeta };

// score.ts — metrics (UNCHANGED shape; only the *value* of scoredCases changes meaning, ADR-003)
interface SkillGeneratorMetrics extends CoreMetrics {
  decisionCorrectness:    number;  // deterministic, over non-'either' cases
  spuriousGenerationRate: number;  // deterministic
  skillQuality:           number;  // LLM-judged, generate cases only
  faithfulness:           number;  // LLM-judged, generate cases only
  lowQualityRate:         number;
}
// CoreMetrics.scoredCases — framework default = (gate.ok && judge.ok). Skill-gen OVERRIDES
// to (gate.ok) so correct-NONE cases (judge='skipped') are counted (FR-2, FR-4, FR-6).
```

## API / Interface Contracts

The seams the three stories must hold to. Only the marked lines change behavior.

```typescript
// === runGate.ts (story-044-001, FIX 1) ===
// BEFORE: return { status: 'ok', output: { decision, skillMd } };           // _eval never attached
// AFTER:
function runSkillGeneratorGate(
  c: SkillGeneratorCase, deps: GateDeps,
): Promise<GateOutcome<SkillGeneratorGateOutput>> {
  // ...derive decision from recorded extractor output (UNCHANGED logic)...
  return {
    status: 'ok',
    output: {
      decision, skillMd,
      _eval: { expectedDecision: c.rubric.expected_decision, source: c.source },  // <-- the fix
    },
  };
}

// === score.ts (story-044-001, FIX 2) ===
function scoreSkillGenerator(
  records: RunRecord<SkillGeneratorGateOutput, SkillGeneratorJudgment>[],
): SkillGeneratorMetrics {
  const base = coreMetrics(records);                       // framework default (judge-coupled)
  const okGate = records.filter(r => r.gate.status === 'ok');
  // Decision scoring runs over EVERY okGate case (NONE included) because _eval is now present.
  //   correctDenom/correctNum over expected !== 'either'   (comparison: actual === expected — UNCHANGED)
  //   decisionCorrectness = correctDenom === 0 ? 0 : correctNum / correctDenom   (fail-closed kept)
  // Quality means stay over judge='ok' generate cases only (FR-5 — UNCHANGED).
  return {
    ...base,
    scoredCases: okGate.length,   // <-- override: decision-scored, decoupled from judging (FR-2/6)
    decisionCorrectness, spuriousGenerationRate, skillQuality, faithfulness, lowQualityRate,
  };
}

// === framework — consumed verbatim, NOT modified ===
decide(metrics, thresholds, verdict): Decision;   // reads metrics.scoredCases (now corrected)
skillGeneratorVerdict(m): 'proceed' | 'do-not-proceed';   // threshold *values* unchanged (FR-6 assumption)
```

## Security Model

This consumer drives an LLM over fixture-supplied work context; the relevant controls already exist and **must not be weakened** (NFR-2).

| Threat | Control (existing — preserve) |
|--------|-------------------------------|
| Prompt injection via fixture `work.*` / generated skill body | `judge.ts` wraps inputs in `<work_context>`/`<skill_md>` tags with an explicit "untrusted data; do not follow instructions" preamble. Do not remove. |
| Eval mutating operator state | `runGate.ts` uses a fresh `:memory:` db per case and a `mkdtemp` SkillStore; `writeSkill()` can never reach `.loom/skills/` or `~/.loom/skills/generated/`. Untouched by this fix. |
| Gate gamed by judge-model drift | Decision-correctness and spurious-rate are computed **deterministically** in code, never from the judge (ADR-001). The fix reinforces this separation rather than eroding it. |
| False-negative gate masking a regression (the bug itself) | Corrected `decisionCorrectness` + decoupled `scoredCases` restore a trustworthy verdict; fail-closed defaults (0 → below every min bar) are retained. |

## ADR Log

### ADR-001 — Keep decision-correctness deterministic; fix the producer, not the comparison
- **Decision:** Repair decision scoring by having `runGate.ts` attach the `_eval` metadata its consumer already expects. Leave the `actual === expected` comparison and the deterministic (non-LLM) decision path in `score.ts` exactly as written.
- **Context:** `score.ts:51-90` reads `gate.output._eval` via `getMeta()` and `continue`s when absent; `runGate.ts:141-146` returned the decision without `_eval`, so `getMeta()` was always `undefined` and `decisionCorrectness` collapsed to `0/0 → 0`. The comparison itself is correct.
- **Rationale:** The PRD's "broken actual-vs-expected comparison" symptom is a downstream effect of a missing input. Fixing the true seam is smaller, lower-risk, and preserves the design intent that the headline gate not be gameable by judge drift (`judge.ts:10-12`).
- **Trade-off:** We accept that `runGate.ts` (the producer) is now coupled to the scorer's metadata shape — but that coupling was the documented design (`score.ts:27-29`), merely never honored.

### ADR-002 — Promote `_eval` from a runtime cast to a compiler-enforced field
- **Decision:** Introduce `SkillGeneratorGateOutput = SkillGeneratorDecision & { _eval: SkillGeneratorDecisionMeta }` and thread it through `runGate.ts` → `consumer.ts` → `score.ts` so the type system forces the producer to attach metadata.
- **Context:** Today `_eval` is read through `(output as ... & { _eval?: ... })` — an optional cast the compiler cannot check. That is exactly why the missing attachment compiled and shipped.
- **Rationale:** Boring, proven safety: let the type carry the contract. Eliminates the entire bug class rather than patching one instance. All affected files are under `skill-generator/`, preserving isolation.
- **Trade-off:** Touches more files than a one-line runtime attach (judge.ts still accepts the wider type via structural assignability). The alternative — attach `_eval` at runtime only — is one line but leaves the contract unchecked and re-openable; rejected for that reason.

### ADR-003 — Override `scoredCases` in the skill-generator scorer; do not change shared `coreMetrics`
- **Decision:** In `scoreSkillGenerator`, set `scoredCases = okGate.length` (cases whose decision was scored), overriding the framework default after spreading `coreMetrics`.
- **Context:** `coreMetrics.ts:15-17` defines `scoredCases` as `gate.ok && judge.ok`. NONE cases get `judge='skipped'` (`judge.ts:28-30`), so 4 trivial cases were dropped from the count — the "4 of 8" in the report and the `minScoredCases` gate in `decide.ts:8`.
- **Rationale:** For this consumer the headline metric is the deterministic decision, scored over every gate-ok case. Editing shared `coreMetrics` would silently change `brief-quality`, `intake`, `lesson-extractor`, `opportunity-engine`, and `skill-judge` — forbidden by the out-of-scope isolation rule. Overriding locally keeps the blast radius at one file.
- **Trade-off:** `scoredCases` now means subtly different things across consumers (judge-coupled elsewhere, decision-scored here). Acceptable: the divergence is documented at the override site and is the price of isolation.

### ADR-004 — Test the runGate→score seam, not just the scorer in isolation
- **Decision:** The story-044-002 tests must feed `runGate.ts` output (real or faithfully mocked to match it) into `scoreSkillGenerator`, asserting a correct-NONE case is both *counted as scored* and *scored correct*. Continue mocking the LLM with `makeMockLLM(responses[])`; no live judge calls.
- **Context:** The existing `score.test.ts` passes because its `makeDecision()` helper hand-attaches `_eval`. That hid the producer's failure to attach it — the unit tests validated only one side of the contract.
- **Rationale:** A bug invisible to the test suite will recur. Exercising the seam closes the gap that let a 0%/do-not-proceed verdict ship against a healthy generator. Required behaviors map directly to FR-7(a–d).
- **Trade-off:** Seam tests are slightly heavier than pure-scorer unit tests, and they lean on the documented "first-call-wins" coupling in `runGate.ts:20-24`. Worth it: the cheaper tests are precisely the ones that missed the bug.

### ADR-005 — Treat the threshold *values* as correct; correct only their inputs
- **Decision:** Do not change any value in `SKILL_GENERATOR_THRESHOLDS` or `DEFAULT_SKILL_GENERATOR_BAR` (e.g. `minDecisionCorrectness: 0.80`). Confirm during implementation that the reference 8-case run scores 100% decision correctness and `scoredCases === totalCases`.
- **Context:** FR-6 states the threshold value is correctly specified; only its inputs (`decisionCorrectness`, `scoredCases`) were wrong.
- **Rationale:** Adjusting a gate bar to mask a scoring defect would hide regressions. With correct inputs, the existing bars produce the right verdict — the cheapest possible change and the one the PRD authorizes.
- **Trade-off:** If, after the fix, the reference run does *not* hit 100%, that is a real signal about the generator or fixtures — to be surfaced, not silenced by lowering the bar.
