# Honest Status Lifecycle and Observability — System Architecture

## Architecture Philosophy

This epic corrects six observability defects across loom's status surfaces without re-architecting them. Four constraints drive every decision below:

1. **Mirror the proven `planning`/`planning_phase` overlay; don't invent a new mechanism.** The `finalizing`/`finalize_phase` lifecycle is the same shape as the already-shipped planning overlay (`EpicStatusSchema` + a nullable phase column + `EpicStore` transition methods, read by the same surfaces). We are paying the cost of a second status overlay to get an interface the codebase — and the operator — already understands. The trade-off: two near-parallel overlays (`planning_phase`, `finalize_phase`) instead of one generalized "phase" column; we accept the mild duplication because a generic phase column would couple two unrelated lifecycles and break the existing `PlanningPhase` typing.

2. **The status surfaces are read models; the writers are `EpicFinalizer` and `Planner`.** `loom status` (CLI), `loom_get_status` (MCP), and `loom run`'s tail are pure readers of the `epics`/`agents` tables. The truth-telling fixes therefore split cleanly: writers (story-002 finalizer, story-004 planner/MCP) record honest state; readers (story-003) render it. This is what lets six defects be fixed by independent agents — the seam between writer and reader is the DB row shape, frozen by story-001.

3. **Additive schema only; `done` is gated on a recorded fact, not a status flip.** Every schema change is an additive `ALTER TABLE` in `Database.ts`'s existing per-column migration block (the v7–v14 pattern). The flagship invariant — never render `done` without a PR URL — is enforced by ordering the writes (`epic_pr_url` persisted *before* `status='done'`), not by a trigger or a read-time guard. The trade-off: a writer that crashes between the two writes leaves `finalizing`, not `done` — which is the *correct* honest state, so we accept it.

4. **Don't touch gate or step-ordering mechanics.** FR-1 is explicit: the finalizer edits are confined to status transitions + PR-URL recording wrapped *around* the existing steps in `EpicFinalizer.finalize()`. The `promoteArtifacts` call-site and `IntegrationGate` semantics belong to the sibling "resilient story execution" epic. The trade-off: the `finalize_phase` overlay must thread through a method that already has six early-return paths (lines 244–629) without moving any of them — more careful insertion, but zero blast radius into retry/gate behavior.

## Component Diagram

```mermaid
flowchart TB
    subgraph writers["Writers (record honest state)"]
        Planner["Planner.run()\nstory-004"]
        Finalizer["EpicFinalizer.finalize()\nstory-002"]
        Worker["BaseCliWorker.run()\nstory-005 (completion copy)"]
        Supervisor["Supervisor.run()\n(calls finalize, sets done)"]
    end

    subgraph state["State — loom-core/src/state (story-001 owns schema)"]
        EpicStore["EpicStore\n+ updateFinalizePhase\n+ recordPrUrl\n+ fail()"]
        AgentStore["AgentStore\n(listLatestByEpic — unchanged)"]
        DB[("epics table\n+finalize_phase\n+epic_pr_url\n+error\nSCHEMA_VERSION 15")]
        Types["types.ts\nEpicStatusSchema + finalizing/failed\nFinalizePhase type"]
    end

    subgraph readers["Readers (render the truth) — story-003"]
        CliStatus["loom status\ncommands/status.ts"]
        CliRun["loom run\ncommands/run.ts (PR-URL tail)"]
        McpStatus["loom_get_status\nmcp/tools/handlers.ts\n(+ current-project default — story-005)"]
    end

    Operator(["Operator / MCP caller"])

    Planner --> EpicStore
    Finalizer --> EpicStore
    Worker --> Supervisor
    Supervisor --> EpicStore
    Supervisor --> Finalizer
    EpicStore --> DB
    AgentStore --> DB
    Types -.validates.-> EpicStore
    DB --> CliStatus
    DB --> McpStatus
    Finalizer -.FinalizeResult.url.-> CliRun
    CliStatus --> Operator
    CliRun --> Operator
    McpStatus --> Operator
```

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| State store | `better-sqlite3` (existing) | Synchronous writes give us the ordering guarantee (`epic_pr_url` durable before `status='done'`) for free — no async race between the two statements. |
| Schema migration | Additive `ALTER TABLE` in `Database.ts` `runMigrations` (existing per-column idempotent pattern) | v7–v14 already use `PRAGMA table_info` → conditional `ADD COLUMN`. v15 is one more block; no migration framework needed for additive columns. |
| Status enums | `zod` `EpicStatusSchema` + a `FinalizePhase` string-union type (existing `PlanningPhase` pattern) | The codebase already validates status with zod and types phases as a bare union; we follow both. `failed` is DB-only — `EpicYamlSchema.status` (the plan-time enum) is deliberately *not* extended. |
| CLI rendering | `commander` command handlers + `console.log` tables (existing `status.ts`) | No new dependency; add icons/columns to the existing `STATUS_ICONS` map and the per-epic render loop. |
| MCP payload | `@modelcontextprotocol/sdk` tool handlers returning plain objects (existing `handlers.ts`) | The `renderEpic` closure already spreads optional fields conditionally; new fields slot in the same way. |
| Tests | co-located `__tests__/` per package (house rule) | Each touched module gets a test; migration + zod-parse test for v15, finalizer phase-transition test, reader-field tests. |

## Data Models

The single schema change is three additive columns on `epics`. All are nullable so the v14→v15 migration is loss-free on existing rows.

```sql
-- v15 migration, added to Database.ts runMigrations() epicCols block.
-- Each guarded by:  if (!epicCols.some(c => c.name === '<col>')) db.exec(...)

ALTER TABLE epics ADD COLUMN finalize_phase TEXT;   -- merging|gate|review|pushing|opening_pr, NULL otherwise
ALTER TABLE epics ADD COLUMN epic_pr_url   TEXT;     -- epic PR URL of record; distinct from agents.pr_url (story-level)
ALTER TABLE epics ADD COLUMN error         TEXT;     -- runtime failure message; set when status='failed'

-- SCHEMA_VERSION constant in Database.ts: 14 -> 15
```

Types in `packages/loom-core/src/types.ts`:

```typescript
// EpicStatusSchema gains two members. Lifecycle-ordered; finalizing sits
// between in_progress and done; failed is a terminal sibling of rejected.
export const EpicStatusSchema = z.enum([
  'planning', 'planned', 'approved', 'rejected',
  'in_progress',
  'finalizing',   // NEW — merge → gate → review → push → open PR tail
  'failed',       // NEW — infra-killed run, distinct from human-declined 'rejected'
  'done',
]);

// Mirror of PlanningPhase. Which step of finalize() is live; null otherwise.
export type FinalizePhase =
  | 'merging' | 'gate' | 'review' | 'pushing' | 'opening_pr';

// EpicRecord gains three fields (mirror planning_phase's nullability).
export interface EpicRecord {
  // ...existing...
  finalize_phase: FinalizePhase | null;
  epic_pr_url: string | null;
  error: string | null;
}

// UNCHANGED (FR-5 assumption): EpicYamlSchema.status stays the plan-time enum.
// 'failed' is a runtime fact, never a planned status.
status: z.enum(['planned','approved','in_progress','done','rejected']).default('planned');
```

The MCP status payload (`StatusTree`-adjacent, the `renderEpic` return shape) gains:

```typescript
// Per-epic object returned by loom_get_status (handlers.ts renderEpic)
{
  id, title, status,
  finalize_phase?: FinalizePhase,   // present only when status='finalizing'
  planning_phase?: PlanningPhase,   // present only when status='planning' (surfaced, not new)
  epic_pr_url?: string,             // present once recorded
  error?: string,                   // present when status='failed'
  // ...existing project attribution, stories[], totals...
}
```

## API / Interface Contracts

These are the seams that cross story boundaries. The exact signatures are frozen by story-001 (types + store methods) so the writer stories (002, 004) and reader story (003) cannot diverge.

**`EpicStore` (state/EpicStore.ts) — new methods, mirroring `updatePlanningPhase`/`completePlanning`:**

```typescript
class EpicStore {
  // story-001 defines; story-002 (finalizer) calls.
  /** Set status='finalizing' and the live phase. status arg stays implicit. */
  beginFinalizing(id: string, phase: FinalizePhase): void;
  /** Advance the phase marker; status stays 'finalizing'. */
  updateFinalizePhase(id: string, phase: FinalizePhase): void;
  /** Persist the epic PR URL of record (NOT agents.pr_url). */
  recordPrUrl(id: string, url: string): void;
  /** Terminal infra failure: status='failed', store error, clear finalize_phase. */
  fail(id: string, error: string): void;
  // completePlanning(id, title?) ALREADY backfills the title — story-004 reuses it.
}
```

**`EpicFinalizer.finalize()` (orchestrator/EpicFinalizer.ts) — unchanged signature, new side-effects (story-002):**

```typescript
// Signature UNCHANGED. finalize() still returns FinalizeResult.
async finalize(epicId: string): Promise<FinalizeResult>;
// FinalizeResult.url + FinalizeResult.status ('skipped'|'merged'|'partial'|'failed'|'gated')
// are the EXISTING outputs story-002 maps to lifecycle writes (see ADR-2 table).
```

**`Supervisor.run()` (orchestrator/Supervisor.ts ~line 452–464) — the `done` gate (story-002 coordinates):**

```typescript
// EXISTING:  this.epics.updateStatus(epicId, allSucceeded ? 'done' : 'in_progress');
//            ...then finalize(epicId).
// CONTRACT:  the unconditional 'done' write moves to AFTER finalize() and is
//            gated on a recorded PR URL. finalize() owns 'finalizing' + phase +
//            recordPrUrl(); the supervisor flips 'done' only when epic_pr_url is set,
//            else leaves the finalizer's terminal status (merged-no-remote, gated, etc.).
```

**`WorkerResult` → completion copy (orchestrator/BaseCliWorker.ts ~line 374–389, story-005):**

```typescript
// WorkerResult.commitCount ALREADY exists (WorkerRunner.ts:174). DAG position
// (terminal vs has-dependents) is NOT on the worker — only the Supervisor holds
// the epic's full story set. Contract: BaseCliWorker.run() consumes a DAG flag
// passed via WorkerAssignment (new optional field) rather than re-deriving it.
interface WorkerAssignment {
  // ...existing (story: Story carries this story's own dependencies[])...
  hasDependents?: boolean; // NEW (story-005): set by Supervisor from the epic DAG.
}
// Completion summary becomes conditional on { commitCount, hasDependents }.
```

**`loom_get_status` (mcp/tools/handlers.ts) — scope default flip (story-005):**

```typescript
// EXISTING: federates across ALL projects by default; `project` narrows.
// CONTRACT: default scope = current project only. Federation opt-in via a NEW
//           explicit boolean arg, e.g. `all_projects: true` (registry.ts tool def
//           gains the param; handler's default branch scans current only).
```

## Security Model

This epic is observability-only and introduces no new trust boundary, network surface, or command execution. The relevant risk is **information disclosure via the default scope change**, and it cuts the right way:

| Threat | Control |
|---|---|
| `loom_get_status` leaks fleet-wide state to an MCP caller scoped to one repo | FR-6 / story-005 flips the default to current-project; federation becomes explicit opt-in. This *reduces* default disclosure. |
| `epic_pr_url` exposes an internal PR link | Same trust level as the existing `agents.pr_url` already surfaced; no new boundary. |
| `error` column leaks an infra stack trace to status surfaces | Store the `(err as Error).message` (already the planner's convention at `Planner.ts:153`), not the full stack; renderers print it verbatim, so keep it a message string. |

No changes to the policy engine, git push gating (`allowed_remotes`), or worktree isolation — all explicitly out of scope.

## ADR Log

### ADR-1 — `finalize_phase` is a second status overlay, not a generalized phase column
- **Decision.** Add a dedicated nullable `finalize_phase TEXT` column and a `FinalizePhase` union type, parallel to the existing `planning_phase`/`PlanningPhase`.
- **Context.** Both `planning` and `finalizing` are "a status with a sub-phase the operator wants to see." A generic `phase` column could serve both.
- **Rationale.** The planning overlay is already shipped and understood; a second one of identical shape is the lowest-surprise path and lets story-003's renderer treat the two symmetrically (`status==='planning' ? planning_phase : status==='finalizing' ? finalize_phase`). A generic column would force a discriminated union and risk a planning value leaking into a finalize render.
- **Trade-off.** Two near-duplicate columns + transition method sets. Accepted: the lifecycles are independent and the duplication is shallow.

### ADR-2 — `FinalizeResult.status` maps to lifecycle, but `done` is gated on `epic_pr_url`, not on status alone
- **Decision.** Keep `finalize()`'s existing `FinalizeResult` return (`skipped|merged|partial|failed|gated`) and map each to a terminal epic status; render `done` only when `epic_pr_url` is non-null.
- **Context.** `finalize()` has six early-return paths (per-story skip, no succeeded stories, all-conflict, gate-block, push-gate confirm, no-remote, remote-not-allowed) plus the happy PR path. Several are *legitimately PR-less successes* (push-gate confirm, no remote configured, remote not allowed).
- **Rationale.** Mapping table the implementer must honor:

  | FinalizeResult | finalize_phase progression | terminal epic status |
  |---|---|---|
  | happy path (PR opened) | merging→gate→review→pushing→opening_pr | `done` (after `recordPrUrl`) |
  | `merged`/`partial`, push-gate `confirm` | merging→gate→review | `done` *without* PR URL is wrong → land terminal-but-not-done (keep `in_progress` or a defined "merged-local" reason) |
  | `merged`/`partial`, no remote / remote-not-allowed | merging→gate→review→pushing | terminal non-`done` (PR-less success: do NOT strand) |
  | `gated` (block mode) | merging→gate | `in_progress` (existing behavior — unchanged) |
  | `skipped` | none | unchanged (no stories / per-story) |
  | `failed` (push failed, PR create failed) | up to pushing/opening_pr | `failed` with `error` |

- **Trade-off.** The PR-less-but-successful paths don't reach `done`. We accept that `done` now strictly means "PR exists" — the whole point of FR-1 — and surface the PR-less success via the finalizer's `note`/`reason` rather than a misleading `done`.

### ADR-3 — Enforce the no-false-done invariant by write ordering, not a DB trigger
- **Decision.** Persist `epic_pr_url` *before* writing `status='done'`, both via synchronous `better-sqlite3` statements.
- **Context.** The invariant is "zero `done` readings precede a recorded PR URL."
- **Rationale.** Synchronous SQLite writes give a total order for free; a crash between the two leaves `finalizing`/terminal-non-done, which is the honest state. A CHECK constraint or trigger would couple schema to lifecycle and complicate the additive migration.
- **Trade-off.** The invariant lives in code (story-002), not the schema, so a future writer could violate it. Mitigated by the co-located finalizer test asserting `done ⇒ epic_pr_url != null`.

### ADR-4 — `failed` is DB-only; the plan-time `EpicYamlSchema.status` enum is not extended
- **Decision.** Add `failed` to the runtime `EpicStatusSchema` only; leave `EpicYamlSchema.status` as `planned|approved|in_progress|done|rejected`.
- **Context.** `Planner.run()` currently records an infra-killed run as `rejected` (Planner.ts:153) — conflating a crash with a human decline (FR-5).
- **Rationale.** Infra failure is a runtime fact, never something a planner would write into an epic YAML. Keeping the two enums distinct preserves the YAML as a pure plan artifact and matches the existing `[ASSUMPTION]`.
- **Trade-off.** Two status enums to keep mentally separated. Accepted: they describe different lifecycles (plan-time vs runtime).

### ADR-5 — DAG-accurate completion copy is computed by the Supervisor and passed to the worker, not derived in the worker
- **Decision.** The Supervisor (which holds the epic's full story set) computes `hasDependents` and passes it on `WorkerAssignment`; `BaseCliWorker.run()` only *consumes* `{ commitCount, hasDependents }` to phrase the summary.
- **Context.** `BaseCliWorker` sees only its own `assignment.story` (with that story's own `dependencies[]`), not who depends on *it*. "Terminal vs has-dependents" is a property of the DAG, which only the Supervisor has.
- **Rationale.** Putting the DAG lookup in the worker would force every worker backend (claude-code, cursor-cli, mock) to re-load and topo-analyze the epic YAML — duplicated logic, three places to get wrong. The Supervisor already topo-sorts (`topoSort` in EpicFinalizer; the supervisor builds the task graph).
- **Trade-off.** One new optional field on the `WorkerAssignment` contract (a cross-cutting interface). Accepted: it's additive and optional, so the mock worker and bench path are unaffected when unset.

### ADR-6 — `loom_get_status` default flips to current-project; federation becomes explicit
- **Decision.** Change the default scope from federate-all to current-project; add an explicit opt-in arg for federation.
- **Context.** The handler currently scans the current project *then every registered peer* by default (handlers.ts:430–438), and the tool description advertises fleet-wide federation as the headline behavior.
- **Rationale.** An automation polling for "this project's status" gets one clean row per story and never accidentally pulls fleet-wide state (FR-6). This is a behavior change to a shipped tool, hence an ADR.
- **Trade-off.** Breaking change for any caller relying on the federate-by-default behavior. Mitigated: the opt-in arg restores it, and `registry.ts`'s tool description + `docs/capabilities.md` (story-006) must document the new default in the same epic.

### ADR-7 — `loom run` reads the PR URL from `FinalizeResult.url`, not from a re-query
- **Decision.** `run.ts` prints the epic PR URL from the value the finalizer already returns (`FinalizeResult.url`), replacing the "Run `loom status` for PR links" fallback (run.ts:469).
- **Context.** `runRun` calls `supervisor.run()`, which calls `finalize()` internally; the URL is captured at `EpicFinalizer.finalize()` (line 593) but not currently threaded back to the CLI tail.
- **Rationale.** The URL of record is `epics.epic_pr_url` once story-002 persists it; the cleanest reader path for `loom run` is to query the epic row after `supervisor.run()` returns (single source of truth) rather than thread a new field through `SupervisorRunResult`. This keeps the run-result contract stable and makes the CLI a pure reader (Constraint 2).
- **Trade-off.** One extra `EpicStore.get()` per processed epic at run end. Negligible cost; avoids widening the supervisor↔CLI result contract.
