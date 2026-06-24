# Standalone Story ID Derivation Audit

**Story:** story-059-001  
**Status:** Complete — gates stories 059-003 (migration) and 059-006 (shim removal)  
**Method:** Two independent searches (A: string-pattern grep; B: call-graph) confirmed against each other. Every hit from both passes is mapped below.

---

## Search A — String-pattern grep

Patterns: `replace.*epic-`, `replace.*story-`, `epicNumber`, `standaloneStoryId`, `resolveEpicRow`, `resolveToInternalEpicId`  
Scope: `packages/loom-core/src`, `packages/loom-web/src`, `packages/loom-cli/src` (non-test files)

## Search B — Call-graph

Callers of: `EpicStore.get` (standalone-specific paths), `createStandalone`, `isStandalone`, `resolveEpicRow`, `resolveToInternalEpicId`, `epicNumber`.

Both passes produced the same hit set. Gaps are noted explicitly.

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

Secondary: `Planner.ts:176` — `const startNum = epicNumber(runId)` — after -002, `runId` for standalone is `story-NNN`, so `epicNumber` returns 0. However, `startNum` is only consumed by `PMAgent` which is never called on the standalone path (early return at line 219). Dead code for standalone; harmless but worth noting.

---

### Site 3 — `intake/routing.ts` canonical derivation function (`routing.ts:40–42`)

**File:** `packages/loom-core/src/intake/routing.ts`  
**Lines:** 40–42  
**Owner:** NOT in ownership map — gap flagged  
**Code:**
```typescript
export function standaloneStoryId(containerEpicId: string): string {
  return containerEpicId.replace(/^epic-/, 'story-');
}
```
**Problem:** This is the documented canonical definition (comment: "called ONCE in Planner.runStandalone") and is re-exported by `@loom-ai/core` index. It is NOT called directly in `Planner.ts` (which uses its own physical-separation copy `_plannerStandaloneStoryId`). After story-059-002, both copies become obsolete.  
**Required change:** Delete (or mark deprecated) this function after story-059-002 removes `_plannerStandaloneStoryId`. Because it is re-exported from `@loom-ai/core`, external callers could depend on it — removal should be treated as a breaking API change.  
**⚠️ OWNERSHIP GAP:** `intake/routing.ts` is not in the epic-059 ownership map. Story-059-002 or a follow-up must own this deletion.

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

### Site 9 — `cli/commands/run.ts:217` — PR URL label (named site, part of standalone dispatch)

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
**Required change:** Replace with `const storyId = agents.length > 0 ? agents[0].story_id : epic.id`. The fallback becomes `epic.id` (already `story-NNN`). The `agents[0].story_id` branch is redundant post-migration (both values are `story-NNN`) but kept for clarity.

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
**Owner:** NOT in ownership map — gap flagged  
**Code:**
```typescript
const startNum = epics.length > 0 ? epicNumber(epics[0].epic_id) : 1;
```
**Context:** `epics[0].epic_id` comes from the planner's `EpicYaml.epic_id` field — this is the container run id. For regular evals this is always `epic-NNN`. For standalone evals this would be `story-NNN` after story-059-002, causing `epicNumber` to return 0.  
**Risk:** Low if evals never run standalone stories; medium if they do. `epicNumber` returning 0 causes `validateEpicSet` to use `startNum=1` which may produce false dependency-validation failures.  
**Required change:** Replace `epicNumber(epics[0].epic_id)` with `idNumber(epics[0].epic_id)` (from the new paths.ts function).  
**⚠️ OWNERSHIP GAP:** `EvalRunner.ts` is not in the ownership map. Story-059-002 (paths.ts owner) should also update this file, or a separate follow-up story is needed.

---

## Surfaces OUTSIDE the Named Set

The following surfaces derive the standalone story id but are NOT in the named set of sites from the architect's guidance. They must be addressed for the migration to be complete.

| Surface | File | Line | Owner | Notes |
|---|---|---|---|---|
| `routing.ts:standaloneStoryId` | `loom-core/src/intake/routing.ts` | 40 | **UNASSIGNED** | Exported from `@loom-ai/core`; becomes dead code after -002 removes the only caller (`_plannerStandaloneStoryId` in Planner.ts). Deletion is a breaking public API change. |
| `gate.ts:118` — "did you mean?" hint | `loom-cli/src/commands/gate.ts` | 118 | story-059-005 | `story-NNN → epic-NNN` translation for error hint; invalid post-migration. Already owned by -005 but not mentioned in guidance. |
| `run.ts:217` — PR URL list label | `loom-cli/src/commands/run.ts` | 217 | story-059-005 | Same as other `run.ts` sites; collapse to `e.id`. Already owned by -005. |
| `EvalRunner.ts:98` | `loom-core/src/eval/EvalRunner.ts` | 98 | **UNASSIGNED** | `epicNumber` doesn't match `story-NNN`; breaks dependency validation for standalone evals. |

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
- The `audit_log.command` column is split: epic-level entries carry `epic-NNN`; story-level entries (attempt_classified, worktree events) already carry `story-NNN`. The migration must use exact-match predicates against the set of migrated standalone epic ids to avoid touching story-level rows.

---

## Summary: Derivation Sites by Owner

| Owner | Sites | Files |
|---|---|---|
| story-059-002 | Counter fix (Site 1), inline derivation (Site 2) | `Planner.ts` |
| story-059-004 | Display rewrite (Site 4) | `status.ts` |
| story-059-005 | `resolveToInternalEpicId` collapse (Sites 5, 6), hint removal (Site 7), bulk approve (Site 8), PR label (Site 9), `toDisplayId` (Site 10), `resolveRunInputId` (Site 11), `prPrefix` (Site 16) | `gate.ts`, `run.ts`, `EpicFinalizer.ts` |
| story-059-006 | Shim deletion (Site 12), web detail (Site 13), rollupEpics (Site 14), mutations (Site 15) | `resolveEpicRow.ts` (DELETE), `index.ts`, `mutations.ts` |
| **UNASSIGNED** | `routing.ts:standaloneStoryId` (Site 3), `EvalRunner.ts:epicNumber` (Site 17) | `routing.ts`, `EvalRunner.ts` |

---

## Gating Verdict

Stories 059-003 (migration) and 059-006 (shim removal) may proceed.

**Preconditions for story-059-003:**
1. All sites in the "already story-framed" column list above are confirmed untouched by the migration.
2. The exact-match predicate on `audit_log.command` uses the migrated standalone ids only (not a wildcard).
3. `agents.epic_id` FK deferral (`PRAGMA defer_foreign_keys = ON`) is required during the transaction since `epics.id` is updated before the referencing tables.

**Preconditions for story-059-006:**
1. Story-059-003 migration has run (standalone rows have `story-NNN` PKs).
2. Story-059-002 has updated `EpicStore.get` and `isStandalone` to work with `story-NNN` PKs natively.

**Unresolved ownership gaps (must be assigned before final merge of epic-059):**
- `packages/loom-core/src/intake/routing.ts` — `standaloneStoryId` export
- `packages/loom-core/src/eval/EvalRunner.ts` — `epicNumber` usage
