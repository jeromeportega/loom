# PRD: Route Single-Purpose Analysis Gates Through Non-Agentic Completion Mode

## Overview

Loom runs two classes of LLM call on one transport: agentic personas/workers that legitimately need the full `claude-cli` agent harness, and single-purpose **analysis gates** (classifiers, scorers, judges, extractors) that take text in and return a structured verdict. Six of these gates still run on the agentic harness, which is both overkill and a correctness hazard — the agent harness has already caused a verdict-only call to execute briefs instead of classifying them, and a quality scorer to return garbage under load. This work migrates each in-scope gate to the existing, regression-tested `nonAgentic` completion mode (system prompt replaced, tools disabled, dynamic workspace context excluded), following the `IntakeClassifier` reference pattern. It is a transport-only change on the same `claude-cli` subscription session — no API key, no billing change — aimed purely at correctness and reliability.

## Goals

1. **Eliminate agent risk on verdict-only gates.** All six in-scope gates issue their `llm.complete` call in non-agentic mode. *Metric: 6/6 gates request `nonAgentic` (verified by a per-gate test); 0 gates can invoke tools or execute their input.*
2. **Preserve verdict behavior exactly.** Each gate's output schema, parsing, retry, and fallback semantics are unchanged. *Metric: all pre-existing gate tests pass with no schema or fallback edits; full build + test suite green.*
3. **Prevent token-truncation regressions.** Each migrated gate sets a `max output tokens` sized to its structured output rather than relying on a default. *Metric: 6/6 gates set an explicit `max output tokens`; the brief scorer's larger payload is sized for its full JSON.*
4. **Keep agentic paths untouched.** `CodeReviewAgent`, `PrDescriptionAgent`, `reviewerSkills`, and the planner personas (Analyst/PM/Architect/QA) remain agentic and unmodified, as does the `nonAgentic` plumbing. *Metric: 0 diffs to those files.*

## User Stories

- **As a loom operator**, I want readiness scores, accept/reject decisions, and clustered opportunities to be produced by deterministic completions, so that a bad transport doesn't poison my plans or waste a run. *(Must)*
- **As a loom maintainer extending a gate**, I want each gate to follow one consistent non-agentic pattern with a regression test, so that the safe transport is obvious and stays enforced. *(Should)*

## Functional Requirements

- **FR-1** — Each of the six in-scope gates (`BriefRefiner`, `SkillJudge`, `LessonExtractor`, `OpportunityEngine`, `SkillGenerator`, `IntakeJudge`) MUST pass `nonAgentic` with `excludeDynamicSections: true` on its existing `llm.complete` call, mirroring `IntakeClassifier`.
- **FR-2** — `BriefRefiner` MUST be migrated first as the lead item and MUST set a `max output tokens` sized to its full JSON payload (readiness flag, 0–10 score, optional refined brief, critique, clarification questions).
- **FR-3** — Each migrated gate MUST set an explicit `max output tokens` sized to its structured output rather than relying on the default.
- **FR-4** — For each gate, the system prompt MUST be verified self-contained — no reliance on working directory, environment, or git status — and any dependency on dynamic workspace context found during verification MUST be folded into the static prompt before migration.
- **FR-5** — `OpportunityEngine`'s migration MUST include its JSON-repair retry path running in non-agentic mode.
- **FR-6** — Each gate's existing output schema, parsing, retry, and fallback behavior MUST be preserved; only the transport changes.
- **FR-7** — Each migrated gate MUST have a test asserting its call requests non-agentic mode, mirroring the `IntakeClassifier` regression test.
- **FR-8** — `CodeReviewAgent.ts`, `PrDescriptionAgent.ts`, `reviewerSkills.ts`, and the planner personas MUST remain agentic and unchanged; the `nonAgentic` plumbing (`LLMClient.ts` request field, `ClaudeCliClient.ts` replace-prompt/disable-tools branch) MUST NOT be modified.
- **FR-9** — `docs/capabilities.md` MUST be updated if any user-visible behavior changes, and the capabilities drift check MUST pass.

## Non-Functional Requirements

- **NFR-1** — Every gate stays on the `claude-cli` subscription-session path. The change MUST NOT introduce an API key or metered/billed call.
- **NFR-2** — No guardrail may be weakened by the migration.

## Epics

This is one cohesive, transport-only migration across six gates plus a final whole-suite verification — **one epic**.

- **Epic 1 — Migrate single-purpose analysis gates to non-agentic completion mode.**

## Out of Scope

- Modifying the `nonAgentic` plumbing in `LLMClient.ts` or `ClaudeCliClient.ts`.
- Migrating or otherwise changing `CodeReviewAgent`, `PrDescriptionAgent`, `reviewerSkills`, or the Analyst/PM/Architect/QA planner personas.
- Any API-key, billing, or transport change beyond toggling `nonAgentic` on the six in-scope gates.
- Changing any gate's output schema, parsing logic, retry strategy, or fallback semantics.
- Definitively attributing the prior garbage-score-under-load incident to the agentic transport (the migration is justified on overkill/correctness grounds regardless).
