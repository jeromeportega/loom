# Activate Review Forge: Make the Ported Reviewers Actually Run

## The Problem

Epic-001 shipped Review Forge's contract and scaffolding — a shared `zod` findings schema, lexical dedupe, the deterministic failure router, the bounded review/revise orchestrator (`runReviewPass`/`runReviewLoop`), the `skillReviewer`/`codeReviewReviewer` adapters, and the `invokeSkill` provenance seam. But the headline three-reviewer review capability is **inert** for two concrete reasons:

1. **The reviewers are blind.** The `adversarial-review` and `edge-case-hunter` registry handlers in `skills/types.ts` are stubs returning `{ findings: [] }`. They never call a model, so even when invoked they produce nothing.
2. **The orchestrator is never engaged.** `BaseCliWorker.runOrchestratedReviewPass` is fully implemented but only runs when `reviewOrchestrator` is set — and neither `workerFactory.ts` nor `run.ts` ever sets it.

The result is a capability that exists on paper but does not execute. `docs/capabilities.md` correctly flags it as scaffolded/not-yet-active, which is honest but a gap in the product surface loom advertises. This epic closes both gaps and proves the capability runs end-to-end.

## Target Users

- **Primary — loom operators** running story agents under `review_strategy='block-and-revise'`, who expect the advertised three-reviewer pass (code-review + adversarial + edge-case) to actually critique a story's diff and force revisions on serious findings.
- **Secondary — loom maintainers** auditing agent behavior via `skill_usage` and `audit_log` rows, who need provenance for every reviewer invocation.
- **Anti-persona — operators on `comment` or `off` strategies.** This epic must NOT change their behavior; the legacy single-agent path stays exactly as it is today.

## Proposed Solution

Make the two ported review skills LLM-backed and wire the existing orchestrator into the live worker path — without touching the schema, dedupe, router, or loop-cap logic, which are already correct. Two pieces:

1. Replace the stub handlers with real handlers that load each skill's `SKILL.md` body as a cacheable static system prefix, send the `ReviewerInput` as the user message through an **injected** `LLMClient`, and parse the response into the shared `ReviewerOutput` schema — mirroring the existing `CodeReviewAgent` pattern.
2. Thread loom's `db` and an `LLMClient` through `workerFactory.createWorker` and `run.ts`, and set a `reviewOrchestrator(assignment)` that assembles the three reviewers, a db-backed `AuditSink`, and a `warn` logger.

## Key Capabilities

1. **Real LLM-backed handlers** for `adversarial-review` and `edge-case-hunter`: load `SKILL.md` via `SkillStore`, prompt, parse JSON, validate against `ReviewerOutput`. On malformed output, let the `zod` parse throw — the orchestrator's existing one-repair-then-warn-and-continue path handles it.
2. **Dependency-injected `LLMClient`** threaded explicitly into skill execution (e.g. via `SkillRuntimeContext` extension or a factory closing over the client), so tests pass a stub returning canned JSON and never hit a live model.
3. **Preserved provenance**: every reviewer invocation reuses `invokeSkill`'s existing `skill_usage` + `audit_log` writes — not duplicated.
4. **Live orchestrator wiring**: `reviewOrchestrator` builds `ReviewPassDeps` from the three reviewers, engaging only under `review_strategy='block-and-revise'` when reviewers/agent are available.
5. **Integration test** proving the orchestrated path runs with a stubbed client: deduped union, blocker/high triggers a bounded revision, and provenance rows for both ported reviewers.
6. **Docs update**: flip the two `docs/capabilities.md` rows from "scaffolded; stub handler, not wired" to active-under-`block-and-revise`, accurately describing real behavior.

## Constraints

- **Caching invariant (#3):** the `SKILL.md` body is the cacheable static system prefix; per-diff input goes in the user message *after* the cache boundary.
- **Provenance invariant (#5):** every invocation writes `skill_usage` + `audit_log` rows before returning — reuse `invokeSkill`'s writes; do not duplicate.
- **No live model calls anywhere in the test suite** — the `LLMClient` is always stubbed.
- Do not modify vendored `.agents/skills/` or `.claude/skills/` originals.
- `npm run build` and `npm run test` must be green across all workspace packages.
- **Scope fences:** no changes to the findings schema, dedupe, router, or `runReviewLoop` cap logic; no real handlers for `failure-investigator`, `doc-distiller`, or `lesson-extractor` (follow-up); no `doc-distiller` injection into the worker prompt; do **not** flip the committed default `review_strategy` to `block-and-revise` — that is an operator decision, not a code change here.

## Risks and Open Questions

- **Injection seam choice.** The brief offers two paths — extend `SkillRuntimeContext`/registration with an `llm`, or register the reviewer skills via a factory closing over an injected client. The cleaner option depends on how `invokeSkill` currently resolves handlers. `[ASSUMPTION]` the factory-closure approach is lower-blast-radius since it avoids changing the shared runtime context signature; the implementer should confirm against the registration call sites.
- **Model JSON discipline.** Real handlers depend on the model emitting parseable JSON matching `ReviewerOutput`. The one-repair-then-warn path is the safety net, but `[ASSUMPTION]` reviewers that frequently emit prose-wrapped JSON could degrade to empty findings under load — worth observing once live.
- **Prompt-cache boundary correctness.** Mis-placing per-diff input before the cache boundary would silently break caching (invariant #3) without failing tests. `[ASSUMPTION]` no existing test asserts cache-boundary placement; consider whether one is warranted.
- **Reviewer/agent availability.** The orchestrated path engages only when "reviewers/agent are available" — the exact availability check and its fallback to legacy behavior should be made explicit so a missing reviewer degrades predictably rather than throwing.
- **Cost.** Two additional LLM-backed reviewers per review pass (plus revisions) increase token spend under `block-and-revise`. Out of scope to tune here, but flag for operators choosing the default.

## Success Criteria

- Invoking `adversarial-review` or `edge-case-hunter` through `invokeSkill` with a stubbed client returns real parsed `ReviewerOutput` findings (not the empty stub) and still writes `skill_usage` + `audit_log` rows.
- A real dispatched story under `review_strategy='block-and-revise'` runs the orchestrated three-reviewer pass — proven by an integration test with a stubbed client — where findings are unioned and deduped, a blocker/high finding triggers a revision bounded by `maxReviewRevisions`, and `skill_usage`/`audit_log` rows are present for **both** ported reviewers.
- `workerFactory` and `run.ts` set `reviewOrchestrator` with `db` + `LLMClient` threaded through; the legacy path is unchanged for `comment`/`off`.
- Unit tests cover both new handlers with a stubbed client across valid **and** malformed output.
- `docs/capabilities.md` accurately reflects the two now-active reviewers.
- `npm run build` and `npm run test` green across all packages.
