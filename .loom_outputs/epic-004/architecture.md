# Signal Scout — System Architecture (Epic C / epic-004, v3.0)

## Architecture Philosophy

Four constraints drive every decision below. When a choice is contested, it is resolved in favor of the constraint, not the cleverness.

1. **The governance invariant is structural, not behavioral.** loom may *propose* but never self-scope or self-execute. This is not enforced by prompt or by reviewer judgment — it is enforced by the *absence* of code paths. There is no scheduler, no score-threshold auto-scope, no auto-approve branch. Every signal→opportunity→epic→execution transition that crosses from "proposal" to "work" is a synchronous operator action through the same `plan_approval` inbox gate that already governs v2.0 execution. We reuse the gate rather than building a parallel one — a second gate is a second thing to get wrong.

2. **Discovery reads real state; the live path has no fixtures.** Scanners read this repository's actual `audit_log`, tracked source, and `gh issue list` output. The seam that makes this testable is the *injectable LLM client* and the `ScanContext` dependency bundle — not fixture signals. A test stubs the model and the `gh` subprocess, never the scanners' reading of the DB.

3. **One batched LLM call per scan, on the cheap tier.** Cost-sensitivity is an architectural input, not an afterthought. The opportunity engine makes *exactly one* `LLMClient.complete()` call per scan over the capped open-signal set — never one call per signal. The clustering call targets the planning/cheaper tier via `modelFor(policy, ...)`, accepting coarser clusters than Opus would produce in exchange for a bounded, predictable per-scan cost.

4. **Independent stories must not collide.** Seven stories ship in parallel branches. The dependency spine (`002 → 003 → 004 → 005`, with `001` unblocking `006` and `007` gating everything) is real, but within it each story owns a disjoint set of files. The blocking web-wiring fix (story-004-001) is sequenced first because every surface depends on a healthy `createApp`; it is a prerequisite *within* this epic, not a separable shipping unit.

The design extends the system that exists — `createApp`, `EpicStore`, `BriefRefiner`, `Planner`, `AuditLog`, `LLMClient`, the `accessGuard` middleware, the `ProjectRegistry` federation pattern — rather than introducing a discovery subsystem that stands apart from it.

---

## Component Diagram

```mermaid
flowchart TB
  subgraph entry["Entry points (operator-invoked only)"]
    CLI["loom scan / loom opportunities\n(loom-cli)"]
    MCP["loom_scan_signals\n(loom-mcp)"]
    WEB["opportunities.js board\n(loom-web frontend)"]
  end

  subgraph pipeline["Scan pipeline (loom-core/src/signals)"]
    ORCH["runScan(ctx)\nscan orchestration"]
    subgraph scanners["SignalScanner[] (no fixtures)"]
      S1["audit-introspection"]
      S2["code-debt (TODO|FIXME|HACK)"]
      S3["github-issues (gh issue list)"]
    end
    STORE["SignalStore\n(upsert + reconcile→stale)"]
    ENGINE["OpportunityEngine\n1 batched LLM call + deterministic score/rank"]
    OPPSTORE["OpportunityStore\n(key = sha1(sorted member keys))"]
  end

  subgraph scoping["Gated scoping (explicit action)"]
    SCOPE["scopeOpportunity(id)"]
    REFINE["BriefRefiner.refine()"]
    GATE["evaluateBriefGate()\nmin_brief_quality_score"]
    PLAN["Planner.run()"]
  end

  subgraph governance["Existing v2.0 governance (reused, unchanged)"]
    EPICS[("epics\nstatus=planned\nautonomy=manual")]
    INBOX["GET /api/inbox\nplan_approval source"]
    SUP["Supervisor\n(never auto-approves)"]
  end

  subgraph data["State (better-sqlite3, schema v17)"]
    SIG[("signals")]
    OPP[("opportunities")]
    AUD[("audit_log")]
  end

  CLI --> ORCH
  MCP --> ORCH
  ORCH --> scanners --> STORE --> SIG
  STORE --> ENGINE --> OPPSTORE --> OPP
  ORCH -.audit row.-> AUD

  WEB -->|GET /api/opportunities| OPPSTORE
  WEB -->|POST .../scope| SCOPE
  WEB -->|POST .../dismiss| OPPSTORE
  SCOPE --> REFINE --> GATE
  GATE -->|pass| PLAN --> EPICS
  GATE -->|fail| OPPSTORE
  SCOPE -.scoped_epic_id, status=scoped.-> OPP
  EPICS --> INBOX --> SUP
  SUP -.reject.->|opportunity→open| OPP
```

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language / runtime | TypeScript, Node 20+ | Matches the entire monorepo; no new toolchain. |
| State | `better-sqlite3`, schema bumped 16 → 17 | Reuses the existing `Database.ts` connection and `CREATE TABLE IF NOT EXISTS` migration discipline. Synchronous API keeps the pipeline simple under the single-serial-operator assumption (NFR-6). |
| LLM access | `LLMClient` interface (`complete(req)`), routed via `modelFor(policy,'planning')` | The seam is already provider-agnostic and stubbable (`MockLLMClient`). One injectable client gives us the single-batched-call guarantee and the test stub for free. |
| Clustering model tier | Planning/cheaper tier (`claude-opus-4-7` planning slot, or a cheaper override) — **[ASSUMPTION]** not deep-reasoning per-signal | Operator cost-sensitivity; clustering is a coarse grouping task, not deep reasoning. |
| GitHub read | `gh issue list --json` via `child_process.spawn` (arg array, no shell) | `gh` is already a loom prerequisite (`loom doctor`). Arg-array spawn avoids command injection; graceful degradation handles missing `gh`/remote/auth. |
| Source scanning | Node `fs` walk over **git-tracked** files + `RegExp /TODO\|FIXME\|HACK/` | Boring, deterministic, dependency-free. `git ls-files` scopes the walk to tracked source, excluding `node_modules`/build output. |
| Web | Express `createApp` factory + `Router` modules + `accessGuard` | Mirrors the existing `registerFleetRoutes` / `registerInboxRoutes` registration and the centralized token guard. |
| Frontend | Vanilla JS board (`opportunities.js`), mirroring `fleet.js` | No framework churn; reuses the federated read-only fetch pattern. |
| CLI | `commander` command, mirroring `runEpic` | Same registration shape as `loom epic` / `loom status`. |
| MCP | `TOOL_DEFINITIONS` entry + handler, mirroring `loom_get_status` | Same registry/handler split. |
| Identity hashing | `crypto.createHash('sha1')` over sorted member keys | Stdlib; exact-set hashing is deterministic and cheap (see ADR-001). |

---

## Data Models

Two additive tables at **schema v17**. `Database.ts` `SCHEMA_VERSION` bumps `16 → 17`; both tables use `CREATE TABLE IF NOT EXISTS` so pre-v17 DBs auto-create them and default behavior with no scan run is unchanged (NFR-1). No existing table is altered.

```sql
-- v17: signals — one row per discrete observation a scanner produced.
-- `key` is the stable dedup identity; re-scans UPSERT on it.
CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,        -- stable identity, e.g. 'code-debt:src/foo.ts:42:FIXME'
  source      TEXT NOT NULL,               -- 'audit-introspection' | 'code-debt' | 'github-issues'
  kind        TEXT NOT NULL,               -- 'work_failure_cluster' | 'todo' | 'github_issue' | ...
  title       TEXT NOT NULL,               -- short human label
  detail      TEXT,                        -- longer description fed to the clustering LLM
  evidence_url TEXT,                        -- 'file:line', gh issue URL, or audit reference
  weight      REAL NOT NULL DEFAULT 1,     -- scanner-assigned salience (e.g. failure-cluster size)
  status      TEXT NOT NULL DEFAULT 'open',-- 'open' | 'stale'
  first_seen  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata    TEXT                         -- JSON blob, source-specific
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);

-- v17: opportunities — clustered, scored, ranked proposals.
-- `key` = sha1(sorted(member signal keys)); a materially-changed membership
-- yields a new key. scoped/dismissed keys are never resurfaced.
CREATE TABLE IF NOT EXISTS opportunities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  key            TEXT NOT NULL UNIQUE,     -- sha1(sorted(member_keys))
  title          TEXT NOT NULL,
  rationale      TEXT NOT NULL,            -- LLM-written justification (FR-3 goal)
  impact         REAL NOT NULL,            -- LLM-proposed ∈ [0,1]
  effort         REAL NOT NULL,            -- LLM-proposed ∈ [0,1]
  confidence     REAL NOT NULL,            -- LLM-proposed ∈ [0,1]
  score          REAL NOT NULL,            -- deterministic: impact*confidence/max(effort,0.1)
  rank           INTEGER NOT NULL,         -- 1 = highest score (descending)
  status         TEXT NOT NULL DEFAULT 'open', -- 'open' | 'scoped' | 'dismissed'
  signal_count   INTEGER NOT NULL,
  member_keys    TEXT NOT NULL,            -- JSON array of signal.key strings
  evidence       TEXT,                     -- JSON array of {title, url} for board links
  scoped_epic_id TEXT REFERENCES epics(id),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
```

**Reconciliation semantics (FR-6, FR-9):**

- **signals UPSERT:** `INSERT ... ON CONFLICT(key) DO UPDATE SET last_seen=excluded.last_seen, status='open', detail=excluded.detail, weight=excluded.weight, metadata=excluded.metadata`. After all scanners run, `reconcile(observedKeys)` flips any `status='open'` signal *not* in this scan's observed set to `'stale'`.
- **opportunities UPSERT:** by `key`. An existing **`open`** opportunity is refreshed (new `score`/`rank`/`rationale`/`evidence`). An existing **`scoped`** or **`dismissed`** opportunity is left untouched — it is never resurfaced. A new `key` (materially-changed membership) inserts as `open`.

Every scan writes one `audit_log` row (`action='signal_scan'`, `detail` = JSON of per-scanner counts and dropped-match counts). Scope and dismiss each write their own audit rows (`action='opportunity_scoped'` / `'opportunity_dismissed'`).

---

## API / Interface Contracts

### Scanner seam — `loom-core/src/signals/SignalScanner.ts`

```ts
export type SignalSource = 'audit-introspection' | 'code-debt' | 'github-issues';

export interface Signal {
  key: string;                 // stable dedup identity (scanner-deterministic)
  source: SignalSource;
  kind: string;
  title: string;
  detail?: string;
  evidenceUrl?: string;
  weight?: number;             // default 1
  metadata?: Record<string, unknown>;
}

export interface ScanContext {
  db: Database.Database;       // real repo state — no fixtures in the live path
  projectRoot: string;
  auditLog: AuditLog;          // for per-scanner audit notes (e.g. gh degradation)
}

export interface SignalScanner {
  readonly source: SignalSource;
  /** MUST NOT throw on environmental failure (e.g. missing `gh`):
   *  return [] and write an audit note instead. */
  scan(ctx: ScanContext): Promise<Signal[]>;
}
```

The three v3.0 implementations: `AuditIntrospectionScanner`, `CodeDebtScanner` (caps at **200 deterministic matches**, ordered by tracked-file path then line; drops beyond the cap and logs the dropped count — FR-4), `GithubIssuesScanner` (one signal per open `gh issue`, degrades to `[]` + audit note on missing `gh`/remote/auth/rate-limit/timeout — FR-5).

### Persistence — `loom-core/src/signals/SignalStore.ts`

```ts
export interface SignalRecord extends Signal { id: number; status: 'open'|'stale'; first_seen: string; last_seen: string; }

export class SignalStore {
  constructor(db: Database.Database);
  upsertMany(signals: Signal[]): { inserted: number; refreshed: number };
  reconcile(observedKeys: string[]): number;     // open & not-observed → stale; returns count
  listOpen(limit?: number): SignalRecord[];        // capped set for the engine
  getByKeys(keys: string[]): SignalRecord[];
}
```

### Orchestration — `loom-core/src/signals/runScan.ts`

```ts
export interface ScanResult {
  signalsObserved: number;
  signalsStaled: number;
  opportunities: OpportunityRecord[];
}
// One LLM call total; writes a single audit row for the scan.
export async function runScan(deps: {
  db: Database.Database;
  projectRoot: string;
  llm: LLMClient;            // injectable → stubbable in tests
  model: string;            // modelFor(policy, 'planning')
  auditLog: AuditLog;
  scanners?: SignalScanner[]; // default: the three real scanners
}): Promise<ScanResult>;
```

### Opportunity engine — `loom-core/src/signals/OpportunityEngine.ts`

```ts
// Pure, deterministic — the determinism guarantee (NFR-5) covers THIS, not the LLM inputs.
export function scoreOf(impact: number, confidence: number, effort: number): number {
  return (impact * confidence) / Math.max(effort, 0.1);
}
export function opportunityKey(memberKeys: string[]): string;  // sha1(sorted(memberKeys))

interface ClusterProposal {          // shape the LLM is asked to return
  title: string;
  signal_ids: number[];              // batch-local SignalRecord.id values
  impact: number; effort: number; confidence: number;  // each ∈ [0,1]
  rationale: string;
}

export class OpportunityEngine {
  constructor(opts: { db: Database.Database; llm: LLMClient; model: string; auditLog: AuditLog });
  // Exactly one complete() call. Validates output: drops unknown signal_ids,
  // skips empty clusters, on malformed JSON re-prompts ONCE then skips
  // opportunity generation without failing the scan (FR-10).
  async generate(openSignals: SignalRecord[]): Promise<OpportunityRecord[]>;
}
```

### Scoping — `loom-core/src/signals/scopeOpportunity.ts`

```ts
export type ScopeResult =
  | { ok: true;  epicId: string }                  // planned + manual epic created
  | { ok: false; critique: string };               // brief gate failed; opportunity stays open

// Runs ONLY on explicit operator action. No score-threshold caller exists.
export async function scopeOpportunity(deps: {
  db: Database.Database; projectRoot: string;
  llm: LLMClient; refineModel: string; planModel: string;
  minBriefQualityScore: number;                    // policy.planning.min_brief_quality_score
  auditLog: AuditLog;
}, opportunityId: number): Promise<ScopeResult>;
// On pass: Planner.run() → planned epic; epics.autonomy_level='manual';
//          opportunities.scoped_epic_id set, status='scoped'.
// On fail: records critique (audit row), opportunity remains 'open'.
```

### Web routes — `loom-web/src/server/routes/opportunities.ts`

```ts
// Registered in createApp() alongside registerFleetRoutes / registerInboxRoutes.
export function registerOpportunityRoutes(app: Express, deps: OpportunityDeps): void;

// GET  /api/opportunities                 → read-only federated list (mirrors GET /api/fleet)
//        200: OpportunityCard[]  (ranked; rationale, evidence[], signal_count, status)
// POST /api/opportunities/:id/scope        → token-gated, audit-logged → { ok, epicId? , critique? }
// POST /api/opportunities/:id/dismiss      → token-gated, audit-logged → { status: 'dismissed' }
```

### Web-wiring fix seam (story-004-001, FR-1/FR-2)

`createApp()` (`loom-web/src/server/index.ts:67`) today mounts only `registerAutonomyRoutes` and `registerFleetRoutes` (lines 96–97); `inbox.ts` and `mutations.ts` are **orphaned**. The fix:

```ts
// loom-web/src/server/index.ts — mount BEFORE any leftover inline route for the
// same path (Express runs first-registered → mounted router wins).
registerInboxRoutes(app, { /* InboxDeps */ });        // serves GET /api/inbox (was 404)
registerMutationRoutes(app, { /* MutationDeps */ });  // approve→{status:'dispatching'},
                                                      // reject/retry/stop/kill + NEW resume
// Then DELETE the now-duplicate inline approve/reject/retry/stop/kill handlers,
// located by route path + body (not line number). KEEP the inline archive
// handler — mutations.ts has no archive.
```

### CLI & MCP

```ts
// loom-cli: mirrors runEpic(brief, opts). Registered via program.command('scan').
export async function runScan(opts?: { llm?: LLMClient; json?: boolean }): Promise<void>;
// optional: program.command('opportunities') → prints the ranked board.

// loom-mcp/src/tools/registry.ts — new TOOL_DEFINITIONS entry:
{ name: 'loom_scan_signals',
  description: 'Run signal scanners and produce a ranked opportunity board (operator-invoked).',
  inputSchema: { type: 'object', properties: { project: { type: 'string' } } } }
```

---

## Security Model

| Threat | Surface | Control |
|---|---|---|
| **Self-execution / governance bypass** — discovery silently schedules or runs work | Whole pipeline | *Structural absence* of any scheduler, score-threshold scope, or auto-approve path (proven by test, FR-12/Goal 2). Scoped epics are `planned`+`manual` and gate through the existing `plan_approval` inbox; the Supervisor never auto-approves them. |
| **Unauthorized mutation** — non-operator triggers scope/dismiss | `POST /api/opportunities/:id/{scope,dismiss}` | `accessGuard({ token, readOnly })` (`loom-web/src/server/auth.ts`) requires the write token on every non-GET/HEAD request even in read-only mode; comparison is `crypto.timingSafeEqual`. `GET /api/opportunities` is read-only federated, like `/api/fleet`. |
| **Command injection** — issue titles / branch names flow into a shell | `GithubIssuesScanner` | `child_process.spawn('gh', [...args])` with an arg array and **no shell**; issue text is data, never interpolated into a command string. |
| **Path traversal** — `?project=` opens an arbitrary DB | Federated `GET /api/opportunities` | Reuse `makeResolveProjectDb` / `ProjectRegistry` validation already guarding `/api/status` and `/api/fleet` — the param is checked against the registry before any file is opened. |
| **Untrusted LLM output** — malformed/hostile cluster JSON crashes the scan or injects bogus signal ids | `OpportunityEngine.generate` | Robust validation (FR-10): drop unknown `signal_id`s, skip empty clusters, exactly one JSON-repair re-prompt, then skip opportunity generation without failing the scan. `impact/effort/confidence` clamped to `[0,1]`. |
| **Resource exhaustion** — a debt-heavy tree produces unbounded matches or an oversized LLM payload | `CodeDebtScanner`, engine batch | 200-match deterministic cap with dropped-count logged (FR-4); the engine operates over the *capped* `listOpen()` set, guaranteeing one bounded call (NFR-2). |
| **Silent failure** — a degraded scanner looks like "no work" | `GithubIssuesScanner` | Degradation never throws but **always** writes an audit note (FR-5) so the operator can distinguish "no issues" from "gh unavailable." |

Auditability (NFR-3): each scan, scope, and dismiss writes an `audit_log` row via the existing `AuditLog.record({ action, detail })`.

---

## ADR Log

### ADR-001 — Opportunity identity is an exact-set sha1 over member signal keys
- **Decision:** `opportunity.key = sha1(sorted(member signal keys))`. Any change to the member set produces a new key.
- **Context:** Re-scans must refresh live opportunities, never resurface `scoped`/`dismissed` ones (FR-9), and remain testable by a single keyed assertion.
- **Rationale:** Exact-set hashing is deterministic, dependency-free (`crypto`), and trivially testable. A `scoped`/`dismissed` key simply will not match again unless the exact membership recurs.
- **Trade-off:** Membership drift (one signal added/removed) mints a *new* opportunity rather than updating the old one — potential near-duplicate churn. We accept this; a similarity/merge step is explicitly out of scope and revisited only if churn proves noisy.

### ADR-002 — One batched clustering call per scan on the cheaper model tier
- **Decision:** `OpportunityEngine.generate` makes exactly one `LLMClient.complete()` call over the capped open-signal set, routed through `modelFor(policy,'planning')` (cheaper tier), never one call per signal.
- **Context:** Operator cost-sensitivity (NFR-2); clustering+scoring of a bounded signal set.
- **Rationale:** A single batched call has predictable, bounded cost and is stubbable via the injected `LLMClient` for deterministic tests. Clustering is coarse grouping, not deep reasoning, so the cheaper tier suffices.
- **Trade-off:** Coarser clusters than per-signal or Opus-tier reasoning would produce, and a hard dependency on the cap to keep the payload in budget. Acceptable given cost is a first-order constraint.

### ADR-003 — Mount the orphaned route modules first, then delete inline duplicates by body
- **Decision:** In `createApp`, register `registerInboxRoutes` / `registerMutationRoutes` *before* the leftover inline handlers, then delete the now-duplicate inline approve/reject/retry/stop/kill handlers; keep the inline archive handler.
- **Context:** `inbox.ts`/`mutations.ts` exist but are never mounted, so `GET /api/inbox` 404s; Express dispatches the first-registered matching route.
- **Rationale:** First-registered-wins means mounting the routers ahead of the inline handlers makes them authoritative immediately, de-risking the deletion. Locating duplicates by route path + body (not line number) survives unrelated edits to the file.
- **Trade-off:** Requires careful body-based identification rather than a mechanical line delete, and a transient window where both a router and an inline handler exist for the same path (router wins). Mitigated by NFR-4 real-`createApp` route tests that fail loudly if an endpoint regresses.

### ADR-004 — Reconcile by stale-marking, not deletion; signals and opportunities are append-and-update
- **Decision:** Unobserved `open` signals are flipped to `stale`; `scoped`/`dismissed` opportunities are retained untouched. Nothing is deleted on re-scan.
- **Context:** FR-6/FR-9 require dedup, stale-marking, and non-resurfacing — all keyed and test-provable.
- **Rationale:** Retaining rows preserves audit history and makes "did this signal disappear?" answerable. UPSERT-on-key gives idempotent re-scans without duplicate rows.
- **Trade-off:** Table growth over time (no GC in v3.0). Acceptable under the single-serial-operator, on-demand-scan assumptions (NFR-6); a retention sweep is a later concern.

### ADR-005 — The LLM clusters by batch-local signal id, but opportunities are keyed by signal key
- **Decision:** The clustering prompt presents signals with batch-local integer ids (`SignalRecord.id`) and returns `signal_ids[]`; the engine resolves those to durable `signal.key` strings before hashing the opportunity key.
- **Context:** The LLM needs compact, unambiguous references within one call; opportunity identity must be stable across scans (ADR-001).
- **Rationale:** Short batch-local ids keep the prompt compact and validation simple (unknown ids are dropped). Resolving to keys before hashing decouples opportunity identity from row ids, which are not stable across DBs.
- **Trade-off:** An extra indirection (id → key) and a validation step. Worth it to keep the identity contract clean and the prompt cheap.

### ADR-006 — Discovery is on-demand only and scoping is explicit-only — enforced by code absence
- **Decision:** No scheduler/daemon/cron; `scopeOpportunity` has exactly one class of caller — an operator action (CLI/MCP/web POST). There is no threshold-triggered or batch auto-scope path.
- **Context:** Goal 2 / FR-12 require the governance invariant to hold *under discovery*, proven by test.
- **Rationale:** The invariant is only trustworthy if it is structural. A test that greps for and asserts the absence of an auto-scope/auto-approve code path is the enforcement mechanism, alongside the inbox-gate assertion.
- **Trade-off:** The operator remains the trigger for every scan and every scope — discovery surfaces work but cannot act on it autonomously. That bottleneck is the point: loom proposes, the operator disposes.

### ADR-007 — `code-debt` caps at 200 deterministic matches with dropped-count logged
- **Decision:** `CodeDebtScanner` scans git-tracked source in a deterministic order (path, then line), emits at most 200 matches, and logs the dropped count to the scan audit row.
- **Context:** FR-4; a debt-heavy tree could otherwise flood the signal set and the LLM payload.
- **Rationale:** A deterministic cap keeps the batched LLM call bounded (NFR-2) and makes re-scans reproducible. Logging the drop keeps truncation honest rather than silent.
- **Trade-off:** Genuine debt beyond the 200th match is invisible until higher-ranked items are resolved. Acceptable: the board surfaces the highest-signal debt first, and the dropped count tells the operator more exists.
