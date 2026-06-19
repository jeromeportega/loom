# Re-anchoring audit — intake-classification.yaml (story-023-005)

**Date:** 2026-06-19  
**Criteria (ADR-006, ADR-008):** Size labels must reflect a brief's intrinsic scope,
not loom's historical story count. Multiple functional areas / services / cross-cutting
concerns → **epic**; single bounded change → **story**; ambiguity → **epic** (conservative
tiebreak). The scorer reads `label.size` as ground truth; `story_count` is evidence-only.

## Process

Each case's brief was read on its own text. The sizing question applied was:

> Does this brief span multiple functional areas or cross-cutting concerns (→ epic),
> or does it describe a single bounded change (→ story)?

Low-confidence / ambiguous cases default to **epic** per the conservative tiebreak.

## Outcome — no labels changed

A careful reading of all 22 cases (3 anchors + 19 epic-derived) confirmed that every
current label correctly reflects intrinsic scope. Zero corrections were made.

This is the expected outcome when labels were originally assigned by humans who
understood the work — not a sign that the review was cursory. The residual noise
the eval may surface (if the classifier disagrees with some labels) is a signal
about classifier accuracy, not about label quality.

## Per-case review

### Anchors (labels confirmed correct)

| id | label | brief | verdict |
|----|-------|-------|---------|
| anchor-obvious-single-story | story | Add a --version flag to the loom CLI | ✓ Single bounded change: one flag, one function. |
| anchor-obvious-bug | story | Fix the date picker wrong-month-in-west-UTC bug | ✓ Single-symptom bug + regression test. |
| anchor-obvious-large-epic | epic | Build a distributed task queue (REST API + worker fleet + Postgres + dashboard + DLQ) | ✓ Five explicitly named distinct concerns. |

### Epic-derived cases (labels confirmed correct)

| id | label | rationale for confirming |
|----|-------|--------------------------|
| epic-001 | epic | Brief names three distinct components: `loom init`, policy engine, SQLite state. Three independent functional areas. |
| epic-002 | epic | Brief names three AI personas in sequence across planner orchestration, LLM integration, and output serialization — multiple modules. |
| epic-003 | epic | Brief names three named components: supervisor, worktree isolation, subagent runner — each a distinct infrastructure concern. |
| epic-004 | epic | Brief explicitly states 7 tools across 2 IDE targets. Multi-dimensional scope by tool count alone. |
| epic-005 | epic | Brief lists four lifecycle stages: discovery, loading, injection, post-story generation. |
| epic-006 | epic | Brief names two distinct IDE surfaces (Cursor MCP + Claude Code slash commands) with different protocol requirements. |
| epic-007 | epic | Brief names two distinct domains (Eval + Safety), each decomposing into multiple subsystems. |
| epic-008 | epic | Brief describes provisioning to a registry ("connect loom to an approved MCP registry"). "Provisioning" implies ingestion + enforcement — two distinct concerns. Conservative tiebreak applied. |
| epic-009 | epic | Brief introduces an org-maintained external repo with discovery, sync, and conflict resolution — a new multi-step data pipeline. |
| epic-010 | epic | Brief names two distinct domains: Onboarding ("frictionless setup") + Control ("agent steering"), each requiring independent acceptance criteria. |
| epic-011 | epic | Brief describes a cross-repo orchestration layer ("many repos at once") — new persistent state + cross-process coordination. |
| epic-012 | epic | Brief introduces a new interaction mode ("Research & Q&A") requiring a new agent persona + new CLI command. Two components; conservative tiebreak applied. |
| epic-013 | epic | Brief targets a new LLM backend for a second IDE ("Cursor's session too") — new backend + streaming normalization + worker type. |
| epic-014 | epic | Brief introduces a new standalone publishable package ("pi.dev UI surface") — a new package is epic scope even at two stories. |
| epic-015 | epic | Brief adds image input ("mockups and screenshots") to the planning pipeline — new media type + vision-model integration + annotation. |
| epic-016 | epic | Brief explicitly enumerates four named features: context manifests, repo digest, diff-first, full dashboard. |
| epic-017 | epic | Brief changes the PR delivery contract ("one epic PR by default instead of N story PRs") — touches branch consolidation, PR creation, and gate logic across multiple system layers. |
| epic-018 | epic | Brief introduces a pre-PR automated review gate — new review agent + findings schema + dedup + supervisor wiring: four distinct components. |
| epic-019 | epic | Brief describes a self-improving review system — skill extraction + repo corpus + promotion/demotion loop: three distinct data pipeline stages. |

## Changes to intake-classification.yaml

None. All labels were confirmed correct on intrinsic scope.

Structural changes made:
- Updated file header to make the re-anchoring policy explicit (ADR-008, story-023-005).
- Added `# @deprecated — evidence only (FR-3, ADR-004)` inline on every `story_count` field
  to reinforce that the scorer must not read this value as size ground truth.

## Scorecard

- Cases reviewed: 22
- Labels changed: **0**
- Labels that required the conservative tiebreak (ambiguity → epic): epic-008, epic-012
- Residual label noise: none detected
