# Standalone Story ID Derivation Audit

**Story:** story-059-001  
**Status:** Complete — gates stories 059-003 (migration) and 059-006 (shim removal)  
**Audit commit:** 85f91ce  
**Method:** Two independent searches (A: string-pattern grep; B: call-graph) confirmed against each other, plus a Search C pass for non-replace derivation forms. Every hit from all three passes is mapped below.

---

## Search A — String-pattern grep

Patterns: `replace.*epic-`, `replace.*story-`, `epicNumber`, `standaloneStoryId`, `resolveEpicRow`, `resolveToInternalEpicId`  
Scope: `packages/loom-core/src`, `packages/loom-web/src`, `packages/loom-cli/src` (non-test files)

## Search B — Call-graph

Callers of: `EpicStore.get` (standalone-specific paths), `createStandalone`, `isStandalone`, `resolveEpicRow`, `resolveToInternalEpicId`, `epicNumber`.

## Search C — Non-replace derivation forms

Patterns: `` `story-${`` (template literals), `'story-' +` (concatenation), `.slice(4)`, `.slice(5)`, `.slice(6)` near id variables.  
Scope: same as Search A (non-test files).  
Result: **Zero additional derivation sites.** The two `.slice(5)` hits found were: (a) `PMAgent.ts:106` — LLM prompt text constructing example story-id strings from `firstId` (an `epic-NNN` planning id, never a standalone id); (b) `ClaudeCodeWorker.ts:497` — MCP tool name parsing (`name.slice(5)` where `name` starts with `'mcp__'`, unrelated to epic/story ids). Neither is a derivation site.

All three passes produced the same derivation hit set. Gaps are noted explicitly.

---

## Derivation Site Map

### Site 1 — Planner counter (`Planner.ts:138`)

**File:** `packages/loom-core/src/planner/Planner.ts`  
**Line:** 138  
**Owner:** story-059-002  
**Code:**
```typescript
.reduce((max, e) => Math.max(max, epicNumber(e.id)), 0);
```
**Problem:** `epicNumber()` matches only `epic-NNN` → returns 0 for `story-NNN` rows. After migration, standalone rows have `story-NNN` PKs; `nextEpicId` would not see them in the max(), risking number collision.  
**Required change:** Replace `epicNumber(e.id)` with `idNumber(e.id)` (new function from paths.ts that matches both prefixes). This is the core counter fix.

---

### Site 2 — Planner inline derivation (`Planner.ts:34–35`)

**File:** `packages/loom-core/src/planner/Planner.ts`  
**Lines:** 34–35, 42, 293  
**Owner:** story-059-002  
**Code:**
```typescript
export function _plannerStandaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}
const standaloneStoryId = _plannerStandaloneStoryId;
// ... later:
const storyId = standaloneStoryId(runId);
```
**Problem:** After story-059-002, `runId` is allocated as `story-NNN` directly (via `storyId(num)`), so this derivation is unnecessary and would produce the wrong result if called on an already-`story-NNN` id.  
**Required change:** Remove `_plannerStandaloneStoryId`, its alias `standaloneStoryId`, and the derivation call. Replace `storyId = standaloneStoryId(runId)` with `storyId = runId` (since `runId` IS `story-NNN` for standalone runs).

**Site 1b — `Planner.ts:176` — `epicNumber(runId)` on standalone run id**  
**Owner:** story-059-002 (same file, same change set as Site 1)  
**Code:** `const startNum = epicNumber(runId)`  
After -002, `runId` for standalone is `story-NNN` and `epicNumber` returns 0. `startNum` is consumed only by PMAgent initialization, which is never reached on the standalone path (early return at line 219), so this is effectively dead code. However, leaving it invites future misreading: if the early-return guard is ever removed or bypassed, `startNum = 0` would produce silent dependency-validation failures. **Required change:** Replace `epicNumber(runId)` with `idNumber(runId)` in story-059-002's change set. Assign to story-059-002 since it already owns the counter fix at Site 1 in the same file.

---

### Site 3 — `intake/routing.ts` canonical derivation function (`routing.ts:40–42`)

**File:** `packages/loom-core/src/intake/routing.ts`  
**Lines:** 40–42  
**Owner:** story-059-002 (assigned — see Gating Verdict)  
**Code:**
```typescript
export function standaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}
```
**Problem:** Re-exported by `@loom-ai/core` (`src/index.ts:17`). **The code comment in `routing.ts:34` reads: `"Producer: called ONCE in Planner.runStandalone at planning time."` This is stale and incorrect.** `Planner.ts` imports only `type { EffectiveRouting }` from routing.ts (a type-only import, never a value import); the planner uses its own private alias `const standaloneStoryId = _plannerStandaloneStoryId` defined at `Planner.ts:42`. The comment's claim of "called ONCE" is what the zero-caller grep refutes. Grep (`grep -rn 'standaloneStoryId' packages/ --include='*.ts' | grep -v '_plannerStandaloneStoryId' | grep -v '\.test\.'`) returns **zero production callers** of the routing.ts function. It is already dead code in production; only tests import it (`physicalSeparation.test.ts`, `standaloneRouting.test.ts`, `StandaloneDispatch.test.ts`). After story-059-002 removes `_plannerStandaloneStoryId`, the routing.ts copy becomes the sole remaining definition and should be deleted in the same change set.  
**Required change:** Delete this function in story-059-002's change set (same owner as `_plannerStandaloneStoryId` removal). Update or delete the tests that import it directly.  
**Semver note:** Deletion of this export **requires a semver-major version bump on `@loom-ai/core`**. Verified: the package is at version `5.41.0` (released, non-pre-release). No `@internal` JSDoc annotation is present on the function or on the `export * from './intake/routing.js'` re-export in `src/index.ts`. This is a public breaking change. Story-059-002's acceptance criteria must include: bump `@loom-ai/core` to `v6.0.0`, update `CHANGELOG.md` with the breaking change note, and publish before any downstream consumer updates. Assigned to story-059-002 alongside `_plannerStandaloneStoryId` removal — see Gating Verdict for the merge-hold condition.

---

### Site 4 — `cli/commands/status.ts:275` (named site)

**File:** `packages/loom-cli/src/commands/status.ts`  
**Line:** 275  
**Owner:** story-059-004  
**Code:**
```typescript
const storyId = epic.id.replace(/^epic-/, 'story-');
```
**Context:** Pre-dispatch standalone container (no agent yet) — derives display id from container PK.  
**Required change:** After migration, `epic.id` IS `story-NNN`, so replace with `const storyId = epic.id`.

---

### Site 5 — `cli/commands/gate.ts:24` — `resolveToInternalEpicId` input translation (named site)

**File:** `packages/loom-cli/src/commands/gate.ts`  
**Line:** 24  
**Owner:** story-059-005  
**Code:**
```typescript
const containerEpicId = id.replace(/^story-/, 'epic-');
if (!store.isStandalone(containerEpicId)) return undefined;
return { internalId: containerEpicId, displayId: id };
```
**Problem:** Translates user-provided `story-NNN` to `epic-NNN` for DB lookup. After migration, `story-NNN` IS the PK — this translation produces wrong results.  
**Required change:** Collapse `resolveToInternalEpicId` to identity: `internalId = id`, `displayId = id`. Remove the `story-NNN → epic-NNN` translation branch entirely.

---

### Site 6 — `cli/commands/gate.ts:30` — display id derivation (named site)

**File:** `packages/loom-cli/src/commands/gate.ts`  
**Line:** 30  
**Owner:** story-059-005  
**Code:**
```typescript
return { internalId: id, displayId: id.replace(/^epic-/, 'story-') };
```
**Context:** When user passes `epic-NNN` directly and it's standalone, derives display form.  
**Required change:** After migration, `epic.id` IS `story-NNN` natively; this path for standalone is dead.

---

### Site 7 — `cli/commands/gate.ts:118` — "did you mean?" hint (NOT in named set)

**File:** `packages/loom-cli/src/commands/gate.ts`  
**Line:** 118  
**Owner:** story-059-005  
**Code:**
```typescript
const correspondingEpicId = epicId.replace(/^story-/, 'epic-');
const regularEpic = store.get(correspondingEpicId);
if (regularEpic && !store.isStandalone(correspondingEpicId)) {
  console.error(`Hint: a regular epic with id ${correspondingEpicId} exists; try \`loom approve ${correspondingEpicId}\`.`);
}
```
**Problem:** This hint tells users that `epic-NNN` exists when they passed `story-NNN`. After migration, no standalone row exists at `epic-NNN` — `correspondingEpicId` would either not exist or might collide with an unrelated regular epic.  
**Required change:** Remove this hint block. The `story-NNN → epic-NNN` derivation is invalid post-migration. If needed, any "not found" message should stand alone.

---

### Site 8 — `cli/commands/gate.ts:166` — bulk approve display (named site)

**File:** `packages/loom-cli/src/commands/gate.ts`  
**Line:** 166  
**Owner:** story-059-005  
**Code:**
```typescript
const itemDisplayId = epic.kind === STANDALONE_KIND ? epic.id.replace(/^epic-/, 'story-') : epic.id;
```
**Required change:** After migration, `epic.id` IS `story-NNN` for standalone rows. Drop the condition: `const itemDisplayId = epic.id`.

---

### Site 9 — `cli/commands/run.ts:217` — PR URL label (NOT in named set)

**File:** `packages/loom-cli/src/commands/run.ts`  
**Line:** 217  
**Owner:** story-059-005  
**Code:**
```typescript
const label = e.kind === STANDALONE_KIND ? e.id.replace(/^epic-/, 'story-') : e.id;
```
**Required change:** After migration, `e.id` IS `story-NNN` for standalone. Drop condition: `const label = e.id`.

---

### Site 10 — `cli/commands/run.ts:228` — `toDisplayId()` (named site, standalone dispatch)

**File:** `packages/loom-cli/src/commands/run.ts`  
**Lines:** 227–229  
**Owner:** story-059-005  
**Code:**
```typescript
function toDisplayId(store: EpicStore, id: string): string {
  return store.isStandalone(id) ? id.replace(/^epic-/, 'story-') : id;
}
```
**Required change:** After migration, `id` IS `story-NNN` natively. Function collapses to identity: `return id`. Or remove entirely and inline `id` at call sites.

---

### Site 11 — `cli/commands/run.ts:242–244` — `resolveRunInputId()` (named site, standalone dispatch)

**File:** `packages/loom-cli/src/commands/run.ts`  
**Lines:** 242–244  
**Owner:** story-059-005  
**Code:**
```typescript
function resolveRunInputId(id: string): string {
  if (/^story-\d+$/.test(id)) return id.replace(/^story-/, 'epic-');
  return id;
}
```
**Problem:** Translates user-provided `story-NNN` to `epic-NNN` for supervisor dispatch. After migration, `story-NNN` IS the PK — translation is wrong.  
**Required change:** Collapse to identity. Remove the `story-NNN → epic-NNN` translation. Also update the `isStandalone` validation at `:526` to check `story-NNN` PK directly.

---

### Site 12 — `web/server/resolveEpicRow.ts` — shim (named site)

**File:** `packages/loom-web/src/server/resolveEpicRow.ts`  
**Lines:** 24–35  
**Owner:** story-059-006  
**Code:**
```typescript
export function resolveEpicRow(store, id): T | undefined {
  const direct = store.get(id);
  if (direct) return direct;
  if (id.startsWith('story-')) {
    const container = store.get(id.replace(/^story-/, 'epic-'));
    if (container && container.kind === STANDALONE_KIND) return container;
  }
  return undefined;
}
```
**Problem:** This is the entire shim. After migration, `store.get('story-NNN')` resolves natively — the fallback is unnecessary.  
**Required change:** Delete this file. Replace all call sites (`index.ts:193, 256, 498, 522`; `routes/mutations.ts:52, 110, 233`) with direct `store.get(req.params.id)`.

---

### Site 13 — `web/server/index.ts:207` — web detail framedId (named site)

**File:** `packages/loom-web/src/server/index.ts`  
**Line:** 207  
**Owner:** story-059-006  
**Code:**
```typescript
const framedId = isStandalone
  ? (agents.length > 0 ? agents[0].story_id : epic.id.replace(/^epic-/, 'story-'))
  : epic.id;
```
**Problem:** Pre-dispatch standalone (no agent) derives display id from `epic.id`. After migration, `epic.id` IS `story-NNN`.  
**Required change:** Replace with `const framedId = epic.id` (no condition needed; the container row's id is always the correct display id for both standalone and epic).

---

### Site 14 — `web/server/index.ts:617` — `rollupEpics` storyId (named site)

**File:** `packages/loom-web/src/server/index.ts`  
**Lines:** 615–617  
**Owner:** story-059-006  
**Code:**
```typescript
const storyId = agents.length > 0
  ? agents[0].story_id
  : epic.id.replace(/^epic-/, 'story-');
```
**Problem:** Pre-dispatch standalone (no agent) derives story id from `epic.id`. After migration, `epic.id` IS `story-NNN`.  
**Required change:** Replace with `const storyId = epic.id` unconditionally. Post-migration both `agents[0].story_id` and `epic.id` are `story-NNN`, so retaining the ternary is dead code. A conditional that can never diverge misleads future readers into thinking the two values can differ. Remove the `agents[0].story_id` branch entirely.

---

### Site 15 — `web/server/routes/mutations.ts` — `resolveEpicRow` callers (named site)

**File:** `packages/loom-web/src/server/routes/mutations.ts`  
**Lines:** 52, 110, 233  
**Owner:** story-059-006  
**Code:**
```typescript
const epic = resolveEpicRow(resolved.epicStore, req.params.id);
```
**Required change:** Replace with `const epic = resolved.epicStore.get(req.params.id)`. Direct PK lookup works after migration.

---

### Site 16 — `orchestrator/EpicFinalizer.ts:713` — `prPrefix` swap (named site)

**File:** `packages/loom-core/src/orchestrator/EpicFinalizer.ts`  
**Line:** 713  
**Owner:** story-059-005  
**Code:**
```typescript
const prPrefix = epic.kind === STANDALONE_KIND ? epicId.replace(/^epic-/, 'story-') : epicId;
```
**Required change:** After migration, `epicId` (from the `epics` row) IS `story-NNN` for standalone. Drop the condition: `const prPrefix = epicId`.

---

### Site 17 — `eval/EvalRunner.ts:98` — `epicNumber` on `epic_id` (NOT in named set)

**File:** `packages/loom-core/src/eval/EvalRunner.ts`  
**Line:** 98  
**Owner:** story-059-002 (assigned — see Gating Verdict)  
**Code:**
```typescript
const startNum = epics.length > 0 ? epicNumber(epics[0].epic_id) : 1;
```
**Context:** `epics[0].epic_id` comes from the planner's `EpicYaml.epic_id` field — this is the container run id. For regular evals this is always `epic-NNN`. For standalone evals this would be `story-NNN` after story-059-002, causing `epicNumber` to return 0.  
**Risk: CONFIRMED LOW.** EvalRunner.run() always calls `Planner.run()` (full epic planning), which exclusively produces `epic-NNN` container ids. The eval harness never invokes standalone planning. Verified by call-graph: `EvalRunner` has no callers outside its own module and test files; `Planner.runStandalone()` is never invoked by EvalRunner. Evals cannot receive `story-NNN` ids through the current code paths. The fix is still required for forward correctness (if standalone eval support is added later), but it is NOT a hard merge precondition for story-059-003.  
**Required change:** Replace `epicNumber(epics[0].epic_id)` with `idNumber(epics[0].epic_id)` (from the new paths.ts function). Assigned to story-059-002 (co-located with `idNumber()` introduction).

---

### CLI Surfaces Checked — Confirmed Clean

The acceptance criteria require explicit inventory of `cli/commands/artifacts.ts`, `traces.ts`, and `audit.ts`. These were searched with all derivation patterns (`.replace`, `epicNumber`, `standaloneStoryId`, `resolveEpicRow`, `resolveToInternalEpicId`) and contain **no id transformation logic**:

| File | Result | Evidence |
|---|---|---|
| `packages/loom-cli/src/commands/artifacts.ts` | **Clean** | No hits on any derivation pattern. Example strings in help text mention `epic-001` but perform no transformation. |
| `packages/loom-cli/src/commands/traces.ts` | **Clean** | Sole `.replace` call is `t.rationale.replace(/\n/g, '\n      ')` — string formatting for display output, not an id derivation. |
| `packages/loom-cli/src/commands/audit.ts` | **Clean** | No hits on any derivation pattern. |

These three surfaces require **no changes** for epic-059. Confirmed by grep:  
`grep -n '\.replace|epicNumber|standaloneStoryId|resolveEpicRow|resolveToInternalEpicId' packages/loom-cli/src/commands/artifacts.ts packages/loom-cli/src/commands/traces.ts packages/loom-cli/src/commands/audit.ts`

---

## Surfaces OUTSIDE the Named Set

The following surfaces derive the standalone story id but are NOT in the named set of sites from the architect's guidance. They must be addressed for the migration to be complete.

| Surface | File | Line | Owner | Notes |
|---|---|---|---|---|
| `routing.ts:standaloneStoryId` | `loom-core/src/intake/routing.ts` | 40 | story-059-002 | Zero production callers (confirmed by grep); only tests import it. Re-exported from `@loom-ai/core` — deletion requires semver-major bump. Delete alongside `_plannerStandaloneStoryId` removal in -002. |
| `gate.ts:118` — "did you mean?" hint | `loom-cli/src/commands/gate.ts` | 118 | story-059-005 | `story-NNN → epic-NNN` translation for error hint; invalid post-migration. Already owned by -005 but not mentioned in guidance. |
| `run.ts:217` — PR URL list label | `loom-cli/src/commands/run.ts` | 217 | story-059-005 | Same as other `run.ts` sites; collapse to `e.id`. Already owned by -005. |
| `EvalRunner.ts:98` | `loom-core/src/eval/EvalRunner.ts` | 98 | story-059-002 | `epicNumber` returns 0 for `story-NNN`; breaks dependency validation for standalone evals. Fix: replace with `idNumber()`. Assign to -002 alongside `idNumber()` introduction. |

---

## Column Inventory Confirmation (ADR-006)

### Columns carrying the container `epic-NNN` id (must be migrated)

| Table | Column | Carries `epic-NNN` for standalone? | Proof |
|---|---|---|---|
| `epics` | `id` (PK) | YES — `createStandalone('epic-NNN', ...)` sets this | `EpicStore.createStandalone:36–43` |
| `agents` | `epic_id` (FK → `epics.id`) | YES — `AgentStore.create(epicId, storyId, ...)` where `epicId = runId = 'epic-NNN'` | `AgentStore.create:25–31`; `Planner.runStandalone:332` |
| `decision_traces` | `epic_id` | YES — `Supervisor.onTrace:1774` writes `epic_id: task.epicId` where `task.epicId = 'epic-NNN'` | `Supervisor.ts:1774` |
| `audit_log` | `command` | YES for epic-level entries — `Supervisor.ts:549,597,783,795,1115,1128,1141` all write `command: epicId` for standalone epics | `Supervisor.ts` grep; `AuditLog.latestActionByCommand:127` |

### Columns already story-framed (must NOT be touched by migration)

| Table | Column | Value | Proof |
|---|---|---|---|
| `agents` | `story_id` | `story-NNN` — set by `Planner.runStandalone:332` via `standaloneStoryId(runId)` | `AgentStore.create:26` builds `agent-${storyId}-hex` using this |
| `decision_traces` | `story_id` | `story-NNN` — set by `Supervisor.onTrace:1775` as `task.story.id` which is the YAML story id | `StandaloneStoryAgent` sets story id to `storyId = 'story-NNN'` |
| `agents` | `id` (PK) | `agent-story-NNN-<hex>` — already story-framed | `AgentStore.create:26`: `agent-${storyId}-${hex}` |
| `audit_log` | `command` (story-level) | `story-NNN` — `AuditLog.recordAttemptClassified:62` writes `command: storyId` (story-level entries use story_id from the agent) | `AuditLog.ts:62`; `AuditLog.getByStory:90` matches `command = storyId` |

### Column inventory verdict

ADR-006's claim is **confirmed correct** with one clarification:

- `epics.id`, `agents.epic_id`, `decision_traces.epic_id`, and `audit_log.command` (epic-level entries only) carry the container `epic-NNN`.
- `agents.story_id`, `decision_traces.story_id`, and `agent-story-NNN-<hex>` ids are already story-framed and must not be touched.
- The `audit_log.command` column is split: epic-level entries carry `epic-NNN`; story-level entries (attempt_classified, worktree events) already carry `story-NNN`. The migration must use an **exact-match IN predicate** against the set of migrated standalone epic ids — **never a LIKE pattern or prefix match** — to avoid touching story-level rows. The set of old ids must be captured in a temp table **before** any row is rewritten (see precondition 0 below).

---

## Summary: Derivation Sites by Owner

| Owner | Sites | Files |
|---|---|---|
| story-059-002 | Counter fix (Site 1), dead-code runId counter (Site 1b), inline derivation (Site 2), routing.ts deletion (Site 3), EvalRunner fix (Site 17) | `Planner.ts`, `routing.ts`, `EvalRunner.ts` |
| story-059-004 | Display rewrite (Site 4) | `status.ts` |
| story-059-005 | `resolveToInternalEpicId` collapse (Sites 5, 6), hint removal (Site 7), bulk approve (Site 8), PR label (Site 9), `toDisplayId` (Site 10), `resolveRunInputId` (Site 11), `prPrefix` (Site 16) | `gate.ts`, `run.ts`, `EpicFinalizer.ts` |
| story-059-006 | Shim deletion (Site 12), web detail (Site 13), rollupEpics (Site 14), mutations (Site 15) | `resolveEpicRow.ts` (DELETE), `index.ts`, `mutations.ts` |

---

## Gating Verdict

Story-059-003 may proceed to implementation. Story-059-006 may be drafted but must not merge until story-059-002 is merged and deployed.

> **Conditional hold on merge:** Story-059-003 must not merge until the `routing.ts:standaloneStoryId` and `EvalRunner.ts:98` ownership gaps are assigned and their fixes are included in epic-059. `routing.ts` exports a public symbol from `@loom-ai/core` (semver-breaking deletion requiring a v6.0.0 bump); this must be resolved before the epic closes. `EvalRunner.ts:98` is assigned to story-059-002 as a forward-correctness fix (risk: confirmed low — see Site 17); it is NOT a hard merge gate for 059-003 but must ship within 059-002's change set.
>
> Story-059-006 must not merge until: (a) story-059-002 is merged and deployed with `EpicStore.get` and `isStandalone` updated to resolve `story-NNN` PKs natively; (b) story-059-003 migration has run and all standalone rows carry `story-NNN` PKs; and (c) the ownership gaps above (`routing.ts`, `EvalRunner.ts:98`) are resolved. The dependency chain is -002 → -003 → -006; skipping any step causes live queries against `story-NNN` ids to return 404.
>
> Assign `routing.ts:standaloneStoryId` deletion and `EvalRunner.ts:98` fix both to story-059-002 (co-located with `_plannerStandaloneStoryId` removal and `idNumber()` introduction respectively).

**Preconditions for story-059-003:**

0. **Capture migrated id set first** — at transaction start, before any UPDATE, create a temp table:
   ```sql
   DROP TABLE IF EXISTS _migrated_standalone_ids;
   CREATE TEMP TABLE _migrated_standalone_ids AS
     SELECT id FROM epics WHERE kind = 'standalone' AND id LIKE 'epic-%';
   ```
   The `DROP TABLE IF EXISTS` is required for idempotency: SQLite TEMP tables are connection-scoped, not transaction-scoped — a rollback does not drop them. If the migration is retried on the same connection (e.g., after a caught error), the bare `CREATE` would fail with "table already exists". Prepending the `DROP TABLE IF EXISTS` makes the sequence safe to re-run. All subsequent WHERE clauses reference this table. If this step is skipped and `epics.id` is updated first, the source list is gone and `audit_log.command` rows cannot be safely identified.

1. All sites in the "already story-framed" column list above are confirmed untouched by the migration.

2. The UPDATE on `audit_log.command` MUST use the exact-match form:
   ```sql
   UPDATE audit_log SET command = 'story-' || substr(command, 6)
     WHERE command IN (SELECT id FROM _migrated_standalone_ids);
   ```
   Do NOT use `LIKE` or any prefix pattern on `audit_log.command` (unlike the `epics` capture in precondition 0, `audit_log` has no `kind` column to narrow scope — a LIKE match could incorrectly touch story-level rows). Story-level `audit_log` rows carry `story-NNN` and are safe only because the IN predicate guards against them. A bulk prefix match would be harmless in practice (no `story-NNN` entry starts with `epic-`), but the explicit IN guard is required for correctness auditability.

3. `PRAGMA foreign_keys = ON` must be set on the connection **before** `PRAGMA defer_foreign_keys = ON`. SQLite disables FK constraint enforcement by default per-connection — without `foreign_keys = ON` first, `defer_foreign_keys` has no effect and the interim FK violation during the `epics.id` rename goes undetected rather than being deferred to commit-time. Both pragmas must be issued on the **same `better-sqlite3` Database instance**, inside the **same `db.transaction()` callback**, before any UPDATE that temporarily violates the `epics.id → agents.epic_id` FK. In better-sqlite3, these pragmas apply per-connection and only for the active transaction — opening a second connection or committing in batches voids the deferral for the remaining rows.

**Preconditions for story-059-006:**
0. **Story-059-003 migration has run and all standalone rows carry `story-NNN` PKs.** Story-059-006 must not merge until story-059-003 is merged and the migration has executed. Deleting the `resolveEpicRow` shim before the data migration runs means `store.get('story-NNN')` returns `undefined` for all pre-migration standalone rows — every web route touching standalone epics returns 404. This is the primary hard gate.
1. **Story-059-002 is merged and deployed** with `EpicStore.get` and `isStandalone` updated to resolve `story-NNN` PKs natively. Story-059-006 must not merge until this ships. The dependency chain is -002 → -003 → -006; all three must land in order.

**Ownership assignments needed before epic-059 can close:**

| Gap | Recommended owner | Rationale |
|---|---|---|
| `routing.ts:standaloneStoryId` (deletion + semver bump) | story-059-002 | Same change set as `_plannerStandaloneStoryId` removal |
| `EvalRunner.ts:98` (`epicNumber` → `idNumber`) | story-059-002 | Co-located with `idNumber()` introduction in `paths.ts` |
| `Planner.ts:176` (`epicNumber(runId)` → `idNumber(runId)`) | story-059-002 | Same file as Site 1 counter fix |
