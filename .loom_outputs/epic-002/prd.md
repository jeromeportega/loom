# Activate Review Forge: Make the Ported Reviewers Actually Run

## Overview

Epic-001 shipped Review Forge's contract and scaffolding — the shared `zod` findings schema, lexical dedupe, the deterministic failure router, the bounded `runReviewPass`/`runReviewLoop` orchestrator, the `skillReviewer`/`codeReviewReviewer` adapters, and the `invokeSkill` provenance seam — but the headline three-reviewer capability is inert. The `adversarial-review` and `edge-case-hunter` handlers are stubs that return `{ findings: [] }` without calling a model, and the fully-implemented orchestrator (`BaseCliWorker.runOrchestratedReviewPass`) never runs because nothing sets `reviewOrchestrator`. This release makes the two ported review skills LLM-backed and wires the existing orchestrator into the live worker path, so an operator on `review_strategy='block-and-revise'` gets the advertised code-review + adversarial + edge-case pass actually critiquing a story's diff — without touching the already-correct schema, dedupe, router, or loop-cap logic.

## Goals

- **Activate the three-reviewer pass.** Both ported reviewers return real parsed `ReviewerOutput` findings (not the empty stub) when invoked. *Metric: an integration test under `block-and-revise` with a stubbed client proves the orchestrated path runs end-to-end — deduped union, a blocker/high finding triggering a bounded revision.*
- **Preserve provenance for every invocation.** *Metric: `skill_usage` and `audit_log` rows are present for both `adversarial-review` and `edge-case-hunter` on every reviewer call, written via the existing `invokeSkill` path (not duplicated).*
- **Zero regression for non-`block-and-revise` operators.** *Metric: the legacy single-agent path is byte-for-byte unchanged for `comment` and `off`; the existing suite stays green.*
- **Keep the capabilities surface honest.** *Metric: the two `docs/capabilities.md` rows flip from "scaffolded; stub handler, not wired" to active-under-`block-and-revise`, accurately describing real behavior.*

## User Stories

- **As a loom operator running `block-and-revise`,** I want the advertised three-reviewer pass to actually critique my story's diff and force revisions on serious findings, so that the capability I rely on does what the product claims. **(Must)**
- **As a loom maintainer auditing agent behavior,** I want a `skill_usage` + `audit_log` record for every reviewer invocation, so that I can trace which reviewer produced which finding. **(Must)**
- **As an operator on `comment` or `off`,** I want my review behavior to stay exactly as it is today, so that this change carries no risk for me. **(Must)**

## Functional Requirements

- **FR-1:** The `adversarial-review` and `edge-case-hunter` registry handlers MUST be LLM-backed — loading each skill's `SKILL.md` body via `SkillStore` as the system prefix, sending the `ReviewerInput` as the user message, parsing the model response, and validating it against the shared `ReviewerOutput` schema — mirroring the existing `CodeReviewAgent` pattern. The `{ findings: [] }` stubs are removed.
- **FR-2:** On malformed model output, the handler MUST let the `zod` parse throw; the orchestrator's existing one-repair-then-warn-and-continue path handles recovery. No new error-handling is added in the handlers.
- **FR-3:** The `LLMClient` MUST be dependency-injected into skill execution (via a `SkillRuntimeContext` extension or a factory closing over the client), so tests can pass a stub returning canned JSON.
- **FR-4:** Every reviewer invocation MUST reuse `invokeSkill`'s existing `skill_usage` + `audit_log` writes; provenance writes are not duplicated in the new handlers.
- **FR-5:** A `reviewOrchestrator(assignment)` MUST assemble `ReviewPassDeps` from the three reviewers, a db-backed `AuditSink`, and a `warn` logger, engaging only under `review_strategy='block-and-revise'` when the reviewers and agent are available.
- **FR-6:** `workerFactory.createWorker` and `run.ts` MUST thread loom's `db` and an `LLMClient` through and set `reviewOrchestrator`.
- **FR-7:** When reviewers or the agent are unavailable, the path MUST degrade predictably to the legacy single-agent behavior rather than throwing; the availability check and fallback are explicit.
- **FR-8:** An integration test MUST prove the orchestrated path with a stubbed client: deduped union of findings, a blocker/high finding triggering a revision bounded by `maxReviewRevisions`, and provenance rows for **both** ported reviewers.
- **FR-9:** Unit tests MUST cover both new handlers with a stubbed client across **valid and malformed** output.
- **FR-10:** `docs/capabilities.md` MUST reflect the two now-active reviewers as active-under-`block-and-revise`.

## Non-Functional Requirements

- **NFR-1 (Caching, invariant #3):** The `SKILL.md` body is the cacheable static system prefix; per-diff `ReviewerInput` goes in the user message *after* the cache boundary.
- **NFR-2 (Provenance, invariant #5):** Every invocation writes its `skill_usage` + `audit_log` rows before returning.
- **NFR-3 (Test isolation):** No live model calls anywhere in the test suite — the `LLMClient` is always stubbed.
- **NFR-4 (Green build):** `npm run build` and `npm run test` pass across all workspace packages.

## Epics

- **Epic-001 — Activate Review Forge reviewers:** make the two ported handlers LLM-backed, inject a stubbable `LLMClient`, wire `reviewOrchestrator` through `workerFactory`/`run.ts`, prove the orchestrated path with tests, and update the capabilities doc. *(Single cohesive shipping unit.)*

## Out of Scope

- Any change to the findings schema, lexical dedupe, deterministic failure router, or `runReviewLoop` cap logic — these are already correct.
- Real handlers for `failure-investigator`, `doc-distiller`, or `lesson-extractor` (follow-up work).
- Injecting `doc-distiller` into the worker prompt.
- Flipping the committed default `review_strategy` to `block-and-revise` — that remains an operator decision, not a code change here.
- Modifying the vendored `.agents/skills/` or `.claude/skills/` originals.
- Tuning or capping the additional token cost of two extra LLM-backed reviewers per pass (flagged for operators, not addressed here).
