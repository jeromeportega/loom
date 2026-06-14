# Architecture — Per-Story Signal Ledger (Observe-Only Cost-Control Harness)

## Architecture Philosophy

This feature is unusual: its entire value is in being *inert*. Loom already ships the decision machinery — `resolveCostTier` and `tierSteps` in `packages/loom-core/src/orchestrator/tier.ts`, the `StorySignals`/`HeuristicSignals` types in `packages/loom-core/src/types.ts`, and the `policy.agents.adaptive_cost` knob. None of it has been validated against real runs. The ledger is the instrument that records what those functions *would* decide, so an operator can audit the calls before any gating is wired to act on them. Four constraints drive every decision below:

1. **Observe-only is load-bearing (NFR-1).** No execution path — reviewer count, verify-phase spawn, skill generation — may read a ledger record or change because one exists. The design keeps the read path (the `EpicFinalizer` renderer) physically separate from every write path, and pins this with a regression test. This is the constraint we will most regret violating.
2. **Observation must never break delivery (FR-8).** A story completes and merges whether or not its signal record persists. Every write is best-effort and wrapped so a failure (unwritable `.loom/signals`, a SQLite error) is swallowed — the cost of a missing record is a gap in the ledger, never a failed story.
3. **Reuse the existing decision logic verbatim (FR-2).** We call `resolveCostTier`/`tierSteps` and record their output. We introduce zero new decision logic, so the ledger fully explains every tier call and the known `heavy`-bias shows up as data, not as a bug to paper over.
4. **No new data collection (NFR-4).** Every heuristic is derived from state loom already holds at story completion — the story branch diff, `minimatch` against `policy.agents.risky_paths`, and a first-try test result that today is structurally absent (so `tests_green_first_try` defaults to `null`). We surface that gap honestly rather than inventing a collection path to close it.

The trade-off the whole feature accepts: we ship a measurement harness with *no behavioral payoff this release*. The payoff is deferred — trustworthy calibration data is the precondition for ever gating on these signals, and gating without it would be guessing.

## Component Diagram

```mermaid
flowchart TB
    subgraph write["WRITE PATH — story completion (Supervisor)"]
        WC["Worker result applied<br/>Supervisor.applyResult seam<br/>(~Supervisor.ts:2005)"]
        CH["computeHeuristics()<br/>diff vs assignment.baseSha,<br/>minimatch risky_paths,<br/>tests_green_first_try=null"]
        TR["resolveCostTier() + tierSteps()<br/>orchestrator/tier.ts<br/>(UNCHANGED — called, not edited)"]
        BS["buildStorySignals()<br/>camelCase→snake_case map"]
        LED["SignalLedger.record(storyId, signals)<br/>best-effort, swallows all errors"]
        WC --> CH --> TR --> BS --> LED
    end

    subgraph sinks["TWO SINKS — identical computed values (FR-3)"]
        AL[("audit_log row<br/>action='story_signals'<br/>command=storyId<br/>detail=StorySignals JSON")]
        MD["`.loom/signals/<story-id>.md`<br/>gitignored run state (NFR-3)"]
        LED --> AL
        LED --> MD
    end

    subgraph read["READ PATH — end of epic (EpicFinalizer)"]
        EF["EpicFinalizer.finalize()<br/>EpicFinalizer.ts:279"]
        RB["SignalLedger.readEpic(stories)<br/>reads audit_log; NEVER writes"]
        OV["over-spend flag (FR-7)<br/>heavy + no findings + green gate"]
        RS["renderBuildSignalAnalysis()<br/>appends section to PR body<br/>beside renderGateSection()"]
        EF --> RB --> OV --> RS
        RS -.appends to.-> PR["Epic PR body"]
    end

    AL -.read back.-> RB

    classDef unchanged fill:#e8e8e8,stroke:#888,stroke-dasharray:4 4;
    class TR unchanged;
```

The dashed grey box (`tier.ts`) is the one component this epic must *not* edit — it is called from the write path and never modified. The read path touches the ledger only through `audit_log`; the markdown sink is for humans, not for readback.

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Heuristic computation | `gitSafe(...)` (`orchestrator/git.ts`) + `git diff --numstat`/`--name-only baseSha..HEAD` | Same mechanism the worker's `changedFiles`/`workerDiff` already use (`BaseCliWorker.ts:909,938`). No new git plumbing; the worktree still exists at story-completion time. |
| Risky-path match | `minimatch` | Already a dependency and already used for `risky_paths`-style globbing in `EpicFinalizer.remoteAllowed` and the worker. Boring, proven, matches `resolveCostTier`'s own assumption. |
| Tier decision | `resolveCostTier` + `tierSteps` (`orchestrator/tier.ts`) | Existing, deterministic, already unit-tested (`__tests__/tier.test.ts`). Reusing them is the whole point — recording, not re-deciding. |
| Durable sink | `audit_log` via `AuditLog.record(...)` (`state/AuditLog.ts`) | CLAUDE.md invariant #5 mandates audit rows; `getByStory` already keys on `command`. No schema migration — `detail` is a JSON column. |
| Human sink | `fs.writeFileSync` to `.loom/signals/<id>.md` | `.loom/` is established gitignored run state. Plain markdown is greppable and reviewable without a tool. |
| Readback / render | `EpicFinalizer` + a pure render function | The finalizer already composes the PR body and appends `renderGateSection`; the signal section slots in at the same seam (`EpicFinalizer.ts:664`). |
| Types | Existing `StorySignals`, `HeuristicSignals` (`types.ts:219-236`) | Already defined for this exact purpose. We populate them; we don't redefine them. |

## Data Models

### `StorySignals` (already defined — `packages/loom-core/src/types.ts:229`)

```ts
interface HeuristicSignals {
  diff_lines: number;                  // sum of added+deleted from `git diff --numstat`
  diff_files: number;                  // count of changed files
  tests_green_first_try: boolean | null; // null = no first-try signal available (see ADR-3)
  risky_paths_touched: string[];       // changed files matching policy.agents.risky_paths
}

interface StorySignals {
  triage?: TriageSignal;               // absent this pass (no triage call wired)
  self_assessment?: SelfAssessment;    // absent this pass → resolver reads confidence='low'
  heuristics?: HeuristicSignals;
  tier: CostTier;                      // 'light' | 'standard' | 'heavy' — from resolveCostTier
  steps: { reviewers: number; verify_phase: boolean; skill_gen: boolean }; // snake_case
}
```

Note the casing seam: `tierSteps` returns **camelCase** (`{ reviewers, verifyPhase, skillGen }`, `tier.ts:55`) while `StorySignals.steps` is **snake_case** (`verify_phase`, `skill_gen`). The mapping is a single function (ADR-5), not scattered field assignments.

### `audit_log` row (no migration — `state/Database.ts:45`)

```
action     = 'story_signals'
command    = '<story-id>'          -- so AuditLog.getByStory() / WHERE command=? finds it
allowed    = 1
agent_id   = <attempt agent id, when known>
detail     = JSON.stringify(StorySignals)   -- the full computed record
timestamp  = CURRENT_TIMESTAMP     -- default
```

This is the **source of truth** for readback. `EpicFinalizer` reads `audit_log` rows with `action='story_signals'` for the epic's stories and parses `detail`.

### `.loom/signals/<story-id>.md` (human sink, gitignored)

```markdown
# Signal record — story-010-001

- **Tier (recommended):** heavy
- **Steps:** reviewers=3, verify_phase=true, skill_gen=true

## Heuristics
- diff_lines: 412
- diff_files: 9
- tests_green_first_try: null  _(no first-try test signal captured this release)_
- risky_paths_touched: packages/loom-core/src/auth/session.ts

## Confidence
- self_assessment: (none captured) → resolver defaults confidence=low
```

The markdown and the `audit_log` `detail` are serialized from **one** in-memory `StorySignals` object, so their computed values are identical by construction (FR-3, pinned by the cross-sink shape test in story-010-002).

## API / Interface Contracts

These are the seams every story must agree on. New code lives in a single module, `packages/loom-core/src/orchestrator/signalLedger.ts`.

```ts
// ── Heuristic computation (story-010-001) ────────────────────────────────────
interface HeuristicInput {
  worktreePath: string;     // assignment.worktreePath
  baseSha: string;          // assignment.baseSha — the story branch's base (see ADR-6)
  riskyPaths: string[];     // policy.agents.risky_paths
  testsGreenFirstTry: boolean | null; // null this release (ADR-3)
}
function computeHeuristics(input: HeuristicInput): HeuristicSignals;

// Assemble the full record — calls resolveCostTier + tierSteps and maps casing.
// This is the ONLY place camelCase tierSteps → snake_case StorySignals.steps happens.
function buildStorySignals(
  heuristics: HeuristicSignals,
  opts?: { triage?: TriageSignal; selfAssessment?: SelfAssessment }
): StorySignals;

// ── Persistence (story-010-002) ──────────────────────────────────────────────
class SignalLedger {
  constructor(opts: { db: Database.Database; projectRoot: string });

  // Writes BOTH sinks from one StorySignals object. Best-effort: every failure
  // is caught and swallowed (optionally recording a 'story_signals_skipped'
  // audit row), and the method NEVER throws (FR-8). audit_log row is written
  // before this returns (NFR-2 / CLAUDE.md #5).
  record(storyId: string, signals: StorySignals, agentId?: string): void;

  // Readback for the finalizer — reads audit_log only, never the markdown,
  // and never writes. Returns the latest record per story id.
  readEpic(storyIds: string[]): Map<string, StorySignals>;
}

// ── Render (story-010-003) ───────────────────────────────────────────────────
interface SignalRenderInput {
  records: Map<string, StorySignals>;
  // Story-level outcomes for the over-spend flag (FR-7). Degrades gracefully
  // when granularity is missing (gate is epic-level today — see ADR-6).
  outcomes: Map<string, { reviewFindings: number | null; gateGreen: boolean | null }>;
  storyOrder: string[];     // topo order from EpicFinalizer
}
// Pure function — no I/O. Returns the markdown section appended to the PR body
// beside renderGateSection (EpicFinalizer.ts:664).
function renderBuildSignalAnalysis(input: SignalRenderInput): string;
```

**Write-site contract (story-010-001/002).** `SignalLedger.record` is invoked from the Supervisor's story-completion seam — the same block that already writes the `code_review_pass` audit row (`Supervisor.ts:2011-2019`), where `assignment.baseSha`, `assignment.worktreePath`, and the review outcome are all in scope and the worktree is not yet pruned. It runs **regardless of `policy.agents.adaptive_cost`** (FR-5).

**Read-site contract (story-010-003).** `EpicFinalizer.finalize` calls `ledger.readEpic(...)` after `composeBody` and appends `renderBuildSignalAnalysis(...)` immediately after the existing `if (gateOutcome) body += renderGateSection(...)` (`EpicFinalizer.ts:664-666`). The finalizer **reads, never writes** the ledger.

## Security & Safety Model

This is an internal observability feature, not an external surface, so the "threats" are mostly safety and isolation rather than adversarial. The load-bearing ones:

| Threat | Control |
|---|---|
| Observation breaks delivery (a write throws and fails the story) | `SignalLedger.record` wraps both sinks in try/catch and never throws (FR-8); pinned by a forced-failure test (unwritable `.loom/signals`). |
| The ledger silently influences execution | The read path lives only in `EpicFinalizer`; no execution decision imports `SignalLedger`. A regression test asserts reviewer count / verify phase / skill-gen are unchanged whether or not records exist (NFR-1). |
| Path traversal via `story-id` in `.loom/signals/<id>.md` | Story ids are validated against the planner pattern (`story-NNN-NNN`); the ledger refuses to write a filename that escapes `.loom/signals/`. Defense-in-depth even though ids are loom-generated. |
| Ledger files committed to the repo | `.loom/signals/` is covered by the existing `.loom/` gitignore entry (NFR-3); story-010-004 documents it as run state. |
| Sink divergence (audit row says one thing, markdown another) | Both sinks serialize from one `StorySignals` object; the cross-sink shape test (story-010-002) pins identical values and the casing mapping (FR-4). |

There is no auth/PII dimension: the data is diff counts, file globs, and an enum tier — all already in the audit log and the diff.

## ADR Log

### ADR-1 — Compute and persist at the Supervisor story-completion seam, not inside the worker

- **Decision:** `computeHeuristics` + `SignalLedger.record` run in the Supervisor, in the block that applies a worker result and writes the `code_review_pass` audit row (`Supervisor.ts:~2005-2019`).
- **Context:** The signals could be computed inside `BaseCliWorker.run` (closest to the diff) or at finalize (closest to the PR). The worker returns a `WorkerResult` and the Supervisor owns the `db`/`AuditLog` and the story lifecycle; the worktree still exists here and `assignment.baseSha`/`worktreePath` are in scope.
- **Rationale:** This is the one place that has *both* the per-story git state (worktree not yet pruned) and the audit/db handles, and it is exactly where loom already records per-story outcomes — so the audit row lands before the result returns to the caller (NFR-2).
- **Trade-off:** Couples the ledger to the Supervisor rather than the worker, so a future worker-only execution mode would need the hook re-homed. Accepted: there is no such mode today, and designing for the system that exists beats a speculative seam.

### ADR-2 — Two sinks, with `audit_log` as the single source of truth for readback

- **Decision:** Persist to both `audit_log` (action `story_signals`) and `.loom/signals/<id>.md`; the `EpicFinalizer` reads back **only** from `audit_log`.
- **Context:** FR-3 requires both sinks with identical values. Readback needs a query interface; markdown does not offer one, and `.loom/` is ephemeral run state that may be absent on the machine that finalizes.
- **Rationale:** `audit_log` is durable, queryable (`getByStory`/`WHERE command=?`), and mandated by CLAUDE.md #5. Markdown is the human-readable convenience copy.
- **Trade-off:** Double-write risk (drift between sinks). Mitigated by serializing both from one `StorySignals` object and pinning equality with the cross-sink shape test.

### ADR-3 — `tests_green_first_try` defaults to `null`; the `heavy`-bias is expected, not a defect

- **Decision:** This release captures no first-try test result and no worker self-assessment; `tests_green_first_try` is `null` and `resolveCostTier` reads `confidence='low'` by default.
- **Context:** NFR-4 forbids new data-collection paths. The worker has a verify phase but does not surface a structured first-try boolean on `WorkerResult`. `resolveCostTier` fails safe: `confidence='low'` → `heavy` (`tier.ts:40-41`).
- **Rationale:** With confidence pinned low and no triage signal, most stories resolve to `heavy`. That bias *is the measurement* — the ledger exists to show operators how far the resolver leans before any real signal feeds it.
- **Trade-off:** The first ledger will be dominated by `heavy` and look uninformative. Accepted and documented (story-010-004): surfacing the bias plainly is the goal; correcting it (capturing self-assessment/triage) is explicitly out of scope and later work.

### ADR-4 — Best-effort persistence: swallow every write error

- **Decision:** `SignalLedger.record` catches and swallows all errors from both sinks and never throws; optionally it records a `story_signals_skipped` audit row when it can.
- **Context:** FR-8/NFR — observation must never block or fail story completion. Disk can be unwritable; SQLite can error.
- **Rationale:** A missing ledger record is a tolerable gap; a failed story is not. The swallowed-error audit row keeps the failure visible without propagating it.
- **Trade-off:** Silent data loss — a run can complete with holes in the ledger. Accepted: the whole feature is subordinate to delivery, and the gap is observable via the skip row.

### ADR-5 — Centralize the camelCase→snake_case mapping in `buildStorySignals`

- **Decision:** The single translation from `tierSteps`' `{verifyPhase, skillGen}` to `StorySignals.steps`' `{verify_phase, skill_gen}` happens in `buildStorySignals`, nowhere else.
- **Context:** FR-4 calls out the casing mismatch explicitly and asks for a test that pins the mapping.
- **Rationale:** One mapping site means one place to get it right and one place the cross-sink shape test asserts against. Scattering the rename across the write and render paths invites a silent field drop.
- **Trade-off:** A tiny indirection layer over what looks like a trivial rename. Cheap insurance against a field-name bug that would be invisible until someone reads the ledger.

### ADR-6 — Diff against the story branch base; derive the over-spend flag at finalize; never flag under-spend

- **Decision:** Heuristics diff `assignment.baseSha..HEAD` (the story's own commits, the same range `BaseCliWorker.changedFiles` uses). The over-spend flag (FR-7) is computed at finalize from story-level review findings + gate result, degrading gracefully when granularity is missing. The under-spend direction is never flagged.
- **Context:** The PRD flags three assumptions: the epic base ref, finalize-time access to per-story findings, and the gate being epic-level today. `assignment.baseSha` is captured per story by the Supervisor (`storyBaseSha`, `Supervisor.ts:1361`) and in rolling mode is the `epic/<id>` tip — so `baseSha..HEAD` is exactly the story's contribution, resolving the "wrong base skews the diff" risk.
- **Rationale:** Using the established per-story range reuses a proven seam and avoids an ambiguous merge-base computation. The over-spend flag belongs at finalize because that is the only place review outcomes and the gate result coexist; under-spend is untrustworthy while confidence is pinned low (ADR-3), so flagging it would be noise.
- **Trade-off:** The integration gate is epic-level, so `gateGreen` may be the same value for every story — the over-spend flag is therefore approximate, and the renderer must degrade (emit the heuristics + tier without the flag) rather than assert false precision. Accepted: an honest "couldn't determine" beats a confident wrong flag.

### ADR-7 — Reuse `audit_log` rather than add a `story_signals` table

- **Decision:** Persist records as `audit_log` rows (`action='story_signals'`, `command=storyId`, `detail=JSON`) instead of a new table + migration.
- **Context:** `audit_log` has a JSON `detail` column and a story-keyed `command` lookup; CLAUDE.md #5 already requires an audit row for the action.
- **Rationale:** No schema migration, no new store class, and the row that satisfies the logging invariant *is* the record — one write, not two.
- **Trade-off:** Querying requires JSON parsing of `detail` and an `action` filter rather than typed columns; the ledger is not independently indexable. Acceptable at this scale (one row per story per epic) and consistent with how `recordAttemptClassified` already stows structured data in `detail`.
