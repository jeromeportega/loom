Let me confirm the exact prompt text and the noise eval fixture before writing.I have the exact prompt and types. Let me check the noise fixture in the eval to reference it accurately.# Architecture: Noise-Resistant Non-Agentic Clustering in the Opportunity Engine

## Architecture Philosophy

This is a conceptual change wearing the clothes of a code change. The clustering logic, data shapes, persistence, and call topology are all correct as they stand — what is wrong is a single instruction inside one prompt constant that makes "nothing here" an answer the model cannot reach. The architecture below is therefore deliberately small, and the discipline is in what it refuses to touch.

Three constraints drive every decision:

1. **The blast radius is one prompt constant and one test file.** `CLUSTER_SYSTEM_PROMPT` in `packages/loom-core/src/signals/OpportunityEngine.ts` and a sibling under `__tests__/`. The wire contract (`ClusterProposal`, `OpportunityRecord`), the single-batched-call topology (ADR-002), the id→key resolution (ADR-005), and the scoring formula stay byte-for-byte identical. A reviewer should be able to read the diff in under a minute.

2. **The measure must not move to make the number look better.** The opportunity-engine eval (`eval-cases/opportunity-engine.yaml`, `src/eval/opportunity-engine/`) is the instrument that *detects* forced clustering via its `forced_clustering_rate` metric. We change the engine so the eval reads better — we do not touch the eval. An eval edited in the same change that it grades is no longer evidence.

3. **Abstention is a behavior we add, not a mechanism we build.** The engine already supports the empty result — `generate()` returns `[]` cleanly, the prompt already says "Return [] if no meaningful clusters exist." The defect is that the surrounding instruction biases *against* using it. We raise the grouping bar with words, not with a new numeric coherence threshold. The trade-off: we accept the softer guarantees of prompt steering in exchange for zero new surface area. ADR-003 records why.

The agentic path (`scopeOpportunity.ts` → `BriefRefiner`, `Planner`) operates downstream on *already-clustered* opportunities and shares no code with this prompt. It stays untouched by construction, not by care.

## Component Diagram

```mermaid
flowchart TD
    subgraph scan["runScan.ts (orchestrator)"]
        SS[SignalStore<br/>open SignalRecord[]]
    end

    subgraph engine["OpportunityEngine.ts — NON-AGENTIC PATH"]
        direction TB
        GEN["generate(openSignals)"]
        PROMPT["CLUSTER_SYSTEM_PROMPT<br/>★ CHANGE SITE ★"]
        PARSE["parseClusterProposals()"]
        SCORE["scoreOf() / opportunityKey()"]
        GEN --> PROMPT
        GEN --> PARSE
        PARSE --> SCORE
    end

    LLM["LLMClient.complete()<br/>nonAgentic: excludeDynamicSections"]
    OS[(OpportunityStore<br/>OpportunityRecord)]

    SS --> GEN
    PROMPT --> LLM
    LLM --> PARSE
    SCORE --> OS

    subgraph untouched["OUT OF SCOPE — do not edit"]
        direction LR
        AGENTIC["scopeOpportunity.ts<br/>→ BriefRefiner → Planner<br/>(agentic path)"]
        EVAL["eval-cases/opportunity-engine.yaml<br/>src/eval/opportunity-engine/*<br/>(the measure)"]
    end

    OS -.->|"downstream, later"| AGENTIC
    OS -.->|"graded by, not edited by"| EVAL

    subgraph test["★ NEW: regression test ★"]
        T["OpportunityEngine.test.ts<br/>mock LLMClient<br/>noise→few/none · related→clusters"]
    end
    T -.->|exercises| GEN

    style PROMPT fill:#ffe0b2,stroke:#e65100,stroke-width:2px
    style T fill:#c8e6c9,stroke:#2e7d32,stroke-width:2px
    style untouched fill:#f5f5f5,stroke:#9e9e9e,stroke-dasharray: 4 4
```

## Tech Stack

No new dependencies. The change lives entirely within the existing stack.

| Layer | Choice | Rationale |
|---|---|---|
| Prompt | Inline `CLUSTER_SYSTEM_PROMPT` string constant | Already the single source of clustering instruction; editing it in place keeps the diff legible and the cache key co-located (`cache: true` on the system block). |
| LLM transport | `LLMClient.complete()` (`src/llm/LLMClient.ts`), `nonAgentic: { excludeDynamicSections: true }` | Existing seam. The non-agentic flag is what isolates this path from Claude Code's dynamic sections; it is preserved unchanged on both the initial and repair calls. |
| Model | `this.model` (planning model, injected at construction) | Routed in, not hard-coded. The fix must hold across whatever planning model is configured; no model pin is introduced. |
| Validation / parse | `parseClusterProposals()` + `clamp01()` (in-file) | Already tolerant of markdown fences and out-of-range scores. An empty array `[]` is already a valid, fully-handled parse — abstention needs no new parsing. |
| Test runner | `node:test` (`describe`/`it`), mock `LLMClient` | The existing `OpportunityEngine.test.ts` uses `node:test` with a hand-rolled sequenced-response mock. The new case extends that pattern — deterministic, no live LLM, no flake. |
| Eval (reference only) | Zod-schema'd YAML cases + LLM judge (`src/eval/opportunity-engine/`) | The external instrument that confirms the behavior shift over time. Referenced, never modified (FR-8). |

## Data Models

All shapes are **unchanged**. They are reproduced here so the contract is explicit: the prompt edit must keep emitting exactly this, and the test asserts against exactly this.

```typescript
// INPUT — src/signals/types.ts
interface SignalRecord extends Signal {
  id: number;                  // batch-local id the LLM clusters on (ADR-005)
  status: 'open' | 'stale';
  first_seen: string;
  last_seen: string;
}
interface Signal {
  key: string;                 // stable dedup identity (durable across scans)
  source: 'audit-introspection' | 'code-debt' | 'github-issues';
  kind: string;                // 'todo' | 'security' | 'performance' | ...
  title: string;
  detail?: string;             // longer free text — rendered into the user prompt
  evidenceUrl?: string;
  weight?: number;
  metadata?: Record<string, unknown>;
}

// LLM WIRE OUTPUT — src/signals/OpportunityEngine.ts
interface ClusterProposal {
  title: string;
  signal_ids: number[];        // batch-local ids; MUST be non-empty per cluster
  impact: number;              // [0,1]
  effort: number;              // [0,1]
  confidence: number;          // [0,1]
  rationale: string;
}
// The empty result — an empty array — is a first-class, already-handled value:
//   type ClusterResponse = ClusterProposal[]   //  []  ⇒  abstention

// PERSISTED — src/signals/OpportunityEngine.ts
interface OpportunityRecord {
  id: number; key: string;     // SHA1 of sorted member_keys (ADR-001)
  title: string; rationale: string;
  impact: number; effort: number; confidence: number;
  score: number;               // scoreOf(impact, confidence, effort)
  rank: number;                // 1 = highest (NFR-5)
  status: 'open' | 'scoped' | 'dismissed';
  signal_count: number;
  member_keys: string[];       // durable Signal.key values, NOT numeric ids
  evidence: { title: string; url: string }[];
  scoped_epic_id: string | null;
  created_at: string; updated_at: string;
}
```

**Note on coherence:** there is no coherence field on any of these shapes, and we are not adding one. Coherence is judged by the model from the prompt and, separately, scored *post-hoc* by the eval judge — it is never a persisted number on `OpportunityRecord`. This is the crux of ADR-003.

## API / Interface Contracts

The only behavioral seam that changes is the *meaning* of the empty array. Signatures are frozen.

```typescript
// FROZEN — signature and call topology unchanged
class OpportunityEngine {
  constructor(opts: { db: Database; llm: LLMClient; model: string; auditLog: AuditLog });
  async generate(openSignals: SignalRecord[]): Promise<OpportunityRecord[]>;
}

// FROZEN — exactly one batched call (ADR-002); flags preserved verbatim
llm.complete({
  model: this.model,
  system: [{ text: CLUSTER_SYSTEM_PROMPT, cache: true }],   // ← prompt text is the ONLY edit
  messages: [{ role: 'user', content: userPrompt }],
  maxTokens: 4096,
  nonAgentic: { excludeDynamicSections: true },
});
```

**The behavioral contract, sharpened (FR-1, FR-2, FR-3):**

| Input character | Required output |
|---|---|
| Genuinely related signals (coherent theme) | Clusters as today — **no regression** (FR-4). Verified against the `oe-separable-auth-perf` / mixed cases. |
| Pure noise (no shared remediation/owner/surface) | `[]`, tolerating at most one low-coherence cluster (FR-1, FR-7). Mirrors the `oe-noise-maintenance-backlog` fixture. |
| Subtle-but-real relatedness | Clustered — abstention applies to *noise*, not to *weak signal* (FR-3). The prompt must name this distinction explicitly so raising the bar does not silence quiet-but-true clusters. |

**Test contract (FR-6, FR-7)** — new cases in `OpportunityEngine.test.ts`, driven by the existing mock `LLMClient` (no live model):

```
it('noise fixture → few-or-no clusters'):
   feed unrelated signals; mock returns []  ⇒  assert result.length <= 1
   (tolerance band, not strict 0 — FR-7; exact band settled vs. observed variance)

it('related fixture → correct clustering'):
   feed coherent signals; mock returns a valid ClusterProposal[]
   ⇒  assert clusters surface with expected member_keys (no regression — FR-4)
```

## Security & Integrity Model

Classic confidentiality/integrity threats are not what this change addresses, but two integrity-of-output risks are worth naming, because the whole point of the change is *trust*:

| Threat | Surface | Control |
|---|---|---|
| **False-positive clusters erode trust** (the actual defect) | `CLUSTER_SYSTEM_PROMPT` biasing toward "produce *some* grouping" | Raise the grouping bar; make `[]` an explicitly-sanctioned outcome (FR-1, FR-2). The eval's `forced_clustering_rate` is the standing detector. |
| **Silent over-correction** suppresses real-but-weak clusters | Same prompt, if the bar is raised bluntly | Prompt must distinguish "weak because noise" from "weak because subtle-but-real" (FR-3); the related-signal regression assertion is the guardrail (FR-4). |
| Prompt injection via `Signal.detail` | `detail` free text is interpolated into the user prompt (`OpportunityEngine.ts:97`) | **Pre-existing and out of scope.** Noted for the record: a hostile signal could attempt to steer clustering. This change neither introduces nor worsens it; do not attempt to fix it here. |

The non-agentic flag (`excludeDynamicSections: true`) remains the boundary that keeps repo/git/env context out of this prompt. It is part of the contract — preserved on every call, including the repair re-prompt.

## ADR Log

### ADR-001 — Change the prompt in place; do not extract a prompt module
**Decision:** Edit the `CLUSTER_SYSTEM_PROMPT` string literal where it lives in `OpportunityEngine.ts`. Do not introduce a prompts file, template, or config knob.
**Context:** A natural instinct on "improve the prompt" is to lift it into its own module first. The PRD and epic scope this to a single cohesive change and explicitly forbid new modules.
**Rationale:** The constant is already isolated, already cache-keyed (`cache: true`), and read in exactly one place. Extraction adds files and an indirection without serving this change.
**Trade-off:** We accept that the prompt stays coupled to the engine class. If prompt-versioning or A/B steering is wanted later, that is a separate, deliberate refactor — not smuggled in under a noise fix.

### ADR-002 — Steer abstention with prompt language, not a numeric coherence threshold
**Decision:** Achieve noise-resistance by sharpening the instruction (raise the bar; sanction `[]`; name the noise-vs-subtle distinction). Do **not** add a downstream numeric coherence score or cutoff.
**Context:** FR-2 demands "a real coherence/relatedness threshold." The tempting reading is a number. The PRD flags as an open `[ASSUMPTION]` whether coherence is judged by the model or against an existing downstream threshold, and rules a *new* scoring mechanism out of scope for V1.
**Rationale:** No coherence number exists on `OpportunityRecord` today; clustering is a single model judgment. A new threshold means new state, new calibration, new failure modes — and a far larger diff than the change warrants. The model can already abstain; it simply needs permission and a higher bar.
**Trade-off:** Prompt steering gives softer, less mechanically-verifiable guarantees than a hard threshold. We buy a one-constant change and zero new surface area at the cost of relying on the eval (`forced_clustering_rate`) and the regression test, rather than a deterministic gate, to hold the behavior. *Confirm during implementation* whether any downstream threshold already exists before assuming none does.

### ADR-003 — Assert the noise outcome with a tolerance band, not strict zero
**Decision:** The noise regression assertion checks `clusters.length <= 1` (zero, or one low-coherence cluster), not `=== 0`. Exact band finalized against observed variance during implementation.
**Context:** The LLM is non-deterministic even at the configured model. A strict-zero assertion on a real model would flake; FR-7 explicitly calls for tolerance.
**Rationale:** A regression test that fails intermittently is worse than no test — it trains maintainers to ignore it. The band encodes the *real* requirement ("don't manufacture coherence"), which permits the occasional single weak cluster while still catching the forced-cluster regression.
**Trade-off:** A band is a weaker assertion than equality — a genuine single-forced-cluster regression inside tolerance could slip. We mitigate by driving the unit test through the deterministic mock `LLMClient` (tight assertions, no flake) and leaning on the eval's aggregate `forced_clustering_rate` for the statistical signal across runs.

### ADR-004 — Treat the eval as the unmodifiable measure
**Decision:** The fix moves the eval result by changing the engine. `eval-cases/opportunity-engine.yaml` and everything under `src/eval/opportunity-engine/` are read-only for this change (FR-8).
**Context:** The `oe-noise-maintenance-backlog` fixture and the `forced_clustering_rate` metric are precisely what surfaced this defect. They are the most convenient thing to "adjust" and the most dangerous.
**Rationale:** An instrument edited in the same change it grades stops being evidence. Keeping the eval frozen is what lets the before/after `forced_clustering_rate` delta credibly demonstrate the fix.
**Trade-off:** We forgo adding a dedicated noise eval case or tightening the judge rubric here, even though both might be valuable. They belong to a separate change so the measure stays independent of the fix it measures.

### ADR-005 — New regression lives in the existing test, driven by the mock LLM
**Decision:** Add the noise→few/none and related→clusters cases to the existing `OpportunityEngine.test.ts` using its sequenced mock `LLMClient`. Do not stand up a new test harness or call a live model in unit tests.
**Context:** The file already mocks `LLMClient`, asserts the single-call topology, the repair path, and id→key resolution. The new behavior is one more facet of the same unit.
**Rationale:** Co-locating keeps the contract in one place and reuses the deterministic mock, so the unit test is fast and flake-free. Live-model behavior is the eval's job (ADR-004), not the unit suite's.
**Trade-off:** A mock-driven unit test proves the *engine handles* an empty/related response correctly — it does not prove the *real model produces* one. That gap is intentional and covered by the eval; conflating the two would reintroduce flake into the unit suite.
