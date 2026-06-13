# Signal Scout — On-Demand Work Discovery and Gated Scoping (Epic C, v3.0)

## Overview

loom can already execute engineering work autonomously (v1) and govern it through an autonomy dial, decision inbox, and fleet board (v2.0, Fleet Commander). What it cannot do is *find* work: every epic still originates from a human writing a brief, leaving the operator as both the source of direction and the sole bottleneck. Signal Scout adds an **on-demand discovery layer** that reads loom's own real signals (audit history, code debt, GitHub issues), clusters and scores them into ranked opportunities via a single batched LLM call per scan, and routes a selected opportunity — *only on explicit operator action* — through the existing `BriefRefiner` → `Planner` path into a `planned` + `manual` epic that flows through the same `plan_approval` inbox gate that already governs execution. The hard line is preserved: loom may **propose**, but never self-scope or self-execute. A blocking prerequisite — epic-003's orphaned web routes (`inbox.ts` / `mutations.ts` never mounted, so `GET /api/inbox` 404s) — is fixed first, because Signal Scout's surfaces depend on a healthy web layer.

## Goals

1. **Shift the operator from authoring briefs to approving direction.** Success metric: a single `loom scan` produces a ranked opportunity board sourced from ≥3 real scanners reading this repo's actual state, with zero hand-authored brief required to reach a `planned` epic.
2. **Preserve the governance invariant under discovery.** Success metric: 100% of scoped epics enter as `planned` + `autonomy_level='manual'` and appear as pending `plan_approval` in `GET /api/inbox`; there exists no code path that auto-approves, auto-scopes on a score threshold, or runs discovery on a schedule — proven by test.
3. **Deliver high-signal, low-noise proposals.** Success metric: every opportunity carries a written `rationale` plus evidence links and signal counts; a re-scan UPSERT-dedupes signals (marking unobserved ones `stale`) and never duplicates or resurfaces `scoped`/`dismissed` opportunities — proven by a test keyed on the opportunity `key`.
4. **Restore a healthy web layer.** Success metric: `inbox.ts` and `mutations.ts` are mounted in the real `createApp`, `GET /api/inbox` returns 200 (not 404), duplicate inline handlers are removed while the inline archive handler is kept, and `POST /api/epics/:id/resume` is served — all covered by real-`createApp` route tests.

## User Stories

- **Must** — As the loom operator, I want to run `loom scan` on demand and see a ranked board of opportunities with rationale and evidence, so that I can decide where attention is warranted without first writing a brief.
- **Must** — As the loom operator, I want to "Scope this" on a chosen opportunity and have it become a real `planned` epic that I still must approve, so that I retain final say at the gate.
- **Must** — As the loom operator, I want to "Dismiss" an opportunity permanently, so that noise I've rejected does not resurface on the next scan.
- **Should** — As a downstream planning agent (John/Winston), I want a scoped opportunity to arrive as a well-formed brief that passes the brief gate, so that it flows cleanly into the existing planning pipeline.
- **Should** — As a future integrator, I want scanners to implement a stable `SignalScanner` interface, so that later connectors (Slack, Jira, telemetry) can be added without redesign.

## Functional Requirements

**Web wiring fix (blocking prerequisite)**

- **FR-1** — `createApp()` mounts the `inbox.ts` and `mutations.ts` routers *before* any leftover inline route for the same path (Express runs first-registered); the now-duplicate inline approve/reject/retry/stop/kill handlers are deleted, located by route path + body (not line number). The inline archive handler is **kept** (mutations.ts has no archive).
- **FR-2** — `POST /api/epics/:id/resume` is newly served, and the approve endpoint returns `{status:'dispatching'}`.

**Signal scanners**

- **FR-3** — At least three `SignalScanner` implementations exist under `loom-core/src/signals/`, reading this repo's real state with no fixtures in the live path: **audit-introspection** (recurring `work_failure`, retry clusters, `review_status='errored'`, `epic_integration_gate` failures), **code-debt** (regex `TODO|FIXME|HACK` over tracked source), and **github-issues** (one signal per open `gh issue list` result).
- **FR-4** — code-debt caps at 200 deterministic matches per scan, with dropped matches logged.
- **FR-5** — github-issues degrades gracefully on missing `gh`, missing remote, auth failure, rate-limit, and network timeout: it never throws and returns zero signals plus an audit note.

**Signal persistence**

- **FR-6** — `SignalStore` writes to a `signals` table (schema v17) with a UNIQUE constraint on a stable `key`. Re-running a scan UPSERTs `last_seen`; any previously-`open` signal not re-observed is marked `stale`. Each scan writes an audit row.

**Opportunity engine**

- **FR-7** — One batched LLM clustering+scoring call per scan operates over the capped open-signal set; the LLM client is injectable and stubbable in tests. The LLM proposes `impact`/`effort`/`confidence` ∈ [0,1] plus a written `rationale`.
- **FR-8** — A pure deterministic function computes `score = impact * confidence / max(effort, 0.1)` and assigns descending `rank`.
- **FR-9** — Each opportunity has a stable `key = sha1(sorted(member signal keys))`. `scoped`/`dismissed` keys are never resurfaced, `open` keys are refreshed, and materially-changed membership yields a new key (exact-set hash).
- **FR-10** — Cluster output is validated robustly: unknown `signal_id`s are dropped, empty clusters are skipped, and malformed JSON triggers exactly one repair re-prompt; if it still fails, opportunity generation is skipped without failing the whole scan.

**Scoping**

- **FR-11** — `scopeOpportunity(opportunityId)` runs only on explicit operator action. It feeds `description` + `evidence_summary` through `BriefRefiner` (honoring `min_brief_quality_score`); on pass it runs `Planner` to produce a `planned` epic, links `scoped_epic_id`, and sets the opportunity `status='scoped'`. On gate failure it records the critique and leaves the opportunity `open`.

**Governance**

- **FR-12** — Scoped epics are `planned` + `autonomy_level='manual'` and surface in the inbox through the existing `plan_approval` source (no new inbox tagging); the Supervisor never auto-approves them. A later-rejected scoped epic returns its opportunity to `open`.

**Surfaces**

- **FR-13** — `GET /api/opportunities` serves a read-only federated list (like fleet), and an `opportunities.js` board renders opportunities ranked, with rationale, evidence links, signal counts, Scope/Dismiss buttons, and an empty state.
- **FR-14** — `POST /api/opportunities/:id/scope` and `POST /api/opportunities/:id/dismiss` are token-gated and audit-logged.
- **FR-15** — A `loom scan` CLI command (and optional `loom opportunities`) plus a `loom_scan_signals` MCP tool expose the pipeline.

## Non-Functional Requirements

- **NFR-1 (Compatibility)** — Schema changes are additive: `Database.ts` `SCHEMA_VERSION` bumps 16 → 17 using idempotent `CREATE TABLE IF NOT EXISTS`; pre-v17 DBs auto-create the new tables; default behavior with no scan run is unchanged.
- **NFR-2 (Cost/Performance)** — Exactly one batched LLM call per scan over the capped set (never one call per signal); the client is injectable and stubbed in tests. `[ASSUMPTION]` The clustering call targets the cheaper model tier rather than deep-reasoning Opus, given operator cost-sensitivity.
- **NFR-3 (Security/Auditability)** — Every mutation endpoint is token-gated, and scanners, scoping, and dismiss each write audit rows.
- **NFR-4 (Testability)** — Every new web route is covered by a test that imports the actual `createApp` (not a hand-built express app), so an unmounted route fails loudly.
- **NFR-5 (Determinism)** — Scoring and ranking are deterministic *given fixed LLM output*; the determinism claim does not extend to the LLM-produced `impact`/`effort`/`confidence` inputs, which vary run to run.
- **NFR-6 (Concurrency)** — A single serial operator is assumed; no concurrent-scan locking is in scope.
- **NFR-7 (Hygiene)** — `docs/capabilities.md` is updated in this PR, and `npm run build` and `npm run test` pass green across all workspaces.

## Epics

This PRD is delivered as **one epic** (Epic C — Signal Scout). The web-wiring fix is a blocking prerequisite *within* this epic, not a separable shipping unit; discovery, scanners, the opportunity engine, scoping, governance, and surfaces are one cohesive piece of work built on the existing v2.0 governance surface.

## Out of Scope

- Any scheduler, daemon, or cron-driven discovery — scanning is always operator-invoked.
- Auto-approval or auto-scoping based on a score threshold — every proposal→work transition is an explicit operator action.
- Concurrent-scan locking or multi-operator coordination.
- Non-repo scanners (Slack, Jira, telemetry) — the `SignalScanner` interface must accommodate them, but none are built here.
- A similarity/merge step for near-duplicate opportunities arising from membership drift — current resolution is exact-set hashing; revisit only if churn proves noisy.
- Any fixtures in the live scan path — scanners read real repository state.
