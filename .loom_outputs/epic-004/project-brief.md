# Signal Scout — On-Demand Work Discovery and Gated Scoping for loom (Epic C, v3.0)

## The Problem

loom can *execute* engineering work autonomously and, since v2.0 (Fleet Commander), *govern* it through an autonomy dial, decision inbox, and fleet board. But the work itself still originates from a human writing a brief. The operator is the bottleneck and the sole source of direction: nothing in the system notices that a TODO has festered for months, that a story keeps failing its integration gate, or that an open GitHub issue maps cleanly onto a deliverable epic.

The missing layer is **discovery**: a way for loom to read its own real signals, propose where attention is warranted, and route those proposals through the *same* approval gate that already governs execution. Without it, the operator must both find work and authorize it. The goal is to shift them from "write briefs" to "approve direction" — while preserving the hard governance line: loom may *propose*, but it must never self-scope or self-execute.

A secondary, blocking problem: epic-003 left web routes orphaned. `createApp()` mounts only autonomy and fleet routes; `registerInboxRoutes` and `registerMutationRoutes` are never mounted, so `GET /api/inbox` returns 404 and cross-project inbox actions are dead. Signal Scout's surfaces depend on a healthy web layer, so this must be fixed first.

## Target Users

- **Primary — the loom operator (Jerome / a solo, serial operator).** Runs `loom scan` on demand, reviews a ranked opportunity board, and decides what becomes real work. Wants high-signal proposals with evidence, not noise, and wants final say at the gate.
- **Secondary — the PM/planning agents (John, Winston) downstream.** A scoped opportunity becomes a real `planned` epic that flows into the existing planning pipeline; the brief they receive must be well-formed enough to pass the brief gate.
- **Secondary — future integrators.** The `SignalScanner` interface must accommodate later connectors (Slack, Jira, telemetry) without redesign.
- **Anti-persona — the "autonomous initiative-taker."** This epic explicitly does *not* serve any actor (human or agent) wanting loom to auto-approve, auto-scope on a score threshold, or run discovery on a schedule/daemon. Every transition from proposal to work is an explicit operator action.

## Proposed Solution

Add an on-demand discovery pipeline that sits on top of the v2.0 governance surface and reuses it rather than reinventing it:

1. **Scan** real repository signals via pluggable scanners.
2. **Cluster + score** signals into ranked opportunities using one batched LLM-assisted call per scan, with a *deterministic* scoring formula.
3. **Scope** a selected opportunity — only on explicit operator action — through the existing `BriefRefiner` → `Planner` path into a real `planned` + `manual` epic.
4. **Gate** every scoped epic through the existing inbox `plan_approval` source; the Supervisor never auto-approves it.

The pipeline is exposed through a CLI (`loom scan`), an MCP tool (`loom_scan_signals`), and a read-only federated opportunity board with "Scope this" / "Dismiss" actions.

## Key Capabilities

1. **Fix orphaned web wiring.** Mount `inbox.ts` and `mutations.ts` before any leftover inline route for the same path (Express runs first-registered); delete the now-duplicate inline approve/reject/retry/stop/kill handlers (locate by route path + body, not line number — line numbers will drift); **keep** the inline archive handler (mutations.ts has no archive).
2. **≥3 real signal scanners** under `loom-core/src/signals/` implementing `SignalScanner`: **audit-introspection** (recurring `work_failure`, retry clusters, `review_status='errored'`, `epic_integration_gate` failures), **code-debt** (regex `TODO|FIXME|HACK` over tracked source, capped at 200 deterministic matches/scan, drops logged), and **github-issues** (`gh issue list`, one signal per open issue, degrades gracefully when `gh` or remote is absent — never throws). Read this repo's real state; no fixtures in the live path.
3. **Signal persistence with reconciliation.** `SignalStore` → `signals` table (schema v17), UNIQUE on a stable `key`. Re-running a scan UPSERTs (`last_seen`); any previously-open signal not re-observed is marked `stale`. Each scan writes an audit row.
4. **Opportunity engine.** One batched LLM clustering+scoring call per scan over the capped open-signal set (injectable/stubbable). LLM proposes `impact`/`effort`/`confidence` ∈ [0,1] + written `rationale`; a pure deterministic function computes `score = impact * confidence / max(effort, 0.1)` and descending `rank`. Stable opportunity `key = sha1(sorted(member signal keys))`; `scoped`/`dismissed` keys are never resurfaced, `open` keys are refreshed, materially-changed membership yields a new key. Robust cluster-output validation: drop unknown signal_ids, skip empty clusters, one repair re-prompt on malformed JSON then skip opportunity-generation (never fail the whole scan).
5. **Explicit-only scoping.** `scopeOpportunity(opportunityId)` feeds `description` + `evidence_summary` through `BriefRefiner` (honoring `min_brief_quality_score`); on pass, runs `Planner` to produce a `planned` epic and links `scoped_epic_id` + `status='scoped'`. On gate failure: record critique, leave opportunity `open`. No threshold trigger, no scheduler/daemon.
6. **Governance invariant.** Scoped epics are `planned` + `autonomy_level='manual'` and surface in the inbox via the existing `plan_approval` source (no new inbox tagging). A later-rejected scoped epic returns its opportunity to `open`.
7. **Surfaces.** `GET /api/opportunities` (read-only federated, like fleet) + an `opportunities.js` board view (ranked, with rationale, evidence links, signal counts, Scope/Dismiss buttons, empty state); `POST /api/opportunities/:id/scope` and `…/dismiss` (token-gated, audit-logged); CLI `loom scan` and optional `loom opportunities`; `loom_scan_signals` MCP tool.

## Constraints

- **Additive, backward-compatible schema.** Bump `Database.ts` `SCHEMA_VERSION` 16 → 17 with idempotent `CREATE TABLE IF NOT EXISTS`; pre-v17 DBs auto-create the new tables. Default behavior with no scan run is unchanged.
- **Reuse, do not reinvent** (all verified on `main`): `Planner`, `BriefRefiner`, `EpicStore` lifecycle, `audit_log`/`agents` introspection, `gh` via `execFileSync`, and epic-003's fleet routing/DTO/`ProjectRegistry` patterns. Follow the `EpicStore` ctor / ISO-timestamp / JSON-blob conventions.
- **Governance is non-negotiable.** No auto-approval; no auto-scoping via score threshold; no scheduler/daemon. Scoped epics must be `planned` + `manual` (proven by test). Scoping is always an explicit operator action.
- **One batched LLM call per scan** over the capped set — never one call per signal; injectable and stubbed in tests.
- **Every mutation endpoint token-gated + audit-logged.** Scanners, scoping, and dismiss all write audit rows.
- **Every new web route covered by a real-`createApp` test** (import the actual `createApp`, not a hand-built express app) so an unmounted route fails loudly.
- **`docs/capabilities.md` updated** in this PR (add discovery surfaces; relocate any "what loom does NOT do" discovery entry if present).
- **`npm run build` and `npm run test` green across all packages.**
- **Single serial operator assumed** — no concurrent-scan locking this epic.

## Risks and Open Questions

- **LLM clustering quality and cost.** A single batched call must cluster the full capped open-signal set coherently. [ASSUMPTION] The capped set (≤200 code-debt matches plus audit/issue signals) fits within one reasonable context window; if not, the cap or batching strategy may need revisiting. Cost-sensitivity is a known operator concern — [ASSUMPTION] this clustering call is a candidate for the cheaper model tier rather than deep-reasoning Opus.
- **Opportunity identity churn.** Because a materially-changed cluster yields a new `key`, the board could surface near-duplicate opportunities as signal membership drifts between scans. Open question: is "materially changed" purely the sorted-key-set hash (any membership delta = new key), and is that churn acceptable to the operator, or is a similarity/merge step needed later? Current resolution: exact-set hash; revisit if churn is noisy.
- **Determinism boundary.** Scoring is deterministic given the LLM's `impact`/`effort`/`confidence`, but those inputs are LLM-produced and will vary run to run. "Deterministically-ranked" therefore means *deterministic given fixed LLM output* — worth stating plainly so the determinism claim isn't over-read.
- **Stale vs. dismissed semantics.** A signal can go `stale` while its opportunity is `dismissed` (permanent per key). [ASSUMPTION] A dismissed opportunity whose underlying signals later re-appear in a *different* cluster (new key) legitimately resurfaces as new work — this is intended, not a leak of dismissed state.
- **gh degradation breadth.** github-issues must degrade gracefully on missing `gh`, missing remote, and auth failure. Open question: are rate-limit / network-timeout failures also treated as "zero signals + audit note," or surfaced differently? Current resolution: never throw; treat all as graceful zero-signal with an audit note.
- **Orphaned-route deletion risk.** Inline handlers must be located by route path + body, not line number (≈443/473/532/582/593 will drift). Mis-identifying the archive handler (which must be *kept*) would silently break archive — the real-`createApp` tests are the guard.

## Success Criteria

- **Scanners:** ≥3 scanners produce real signals from this repo, persisted, UPSERT-deduped on re-run with stale-marking — one test per scanner.
- **Opportunities:** signals clustered and scored via the deterministic formula with written rationale + evidence links, persisted, ranked, served by `GET /api/opportunities` (real-`createApp` test), and rendered in the board with an empty state. A re-scan does not duplicate or resurface `scoped`/`dismissed` opportunities (test keyed on the opportunity `key`).
- **Scoping:** `scopeOpportunity` produces a real `planned` + `manual` epic that passes the brief gate, linked via `scoped_epic_id` — tested with stubbed planner + LLM. A failed brief gate records the critique and leaves the opportunity `open`.
- **Governance:** the scoped epic appears in `GET /api/inbox` as a pending `plan_approval` and stays `planned` until an explicit approve (test); a rejected scoped epic returns its opportunity to `open` (test).
- **Wiring fix:** orphaned routes mounted in real `createApp`; inline approve/reject/retry/stop/kill removed; archive kept; `POST /api/epics/:id/resume` newly served; approve now returns `{status:'dispatching'}` — all proven by a real-`createApp` route test.
- **Hygiene:** `docs/capabilities.md` updated; `npm run build` and `npm run test` green across all workspaces.
