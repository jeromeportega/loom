import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type Database from 'better-sqlite3';
import {
  EpicStore,
  AgentStore,
  AuditLog,
  SkillUsageStore,
  ControlStore,
  DecisionTraceStore,
  LeaseStore,
  WorkerLogStore,
  RecoveryStore,
  MetricsStore,
} from '../state/index.js';
import { FindingStore } from '../state/FindingStore.js';
import type { GlobalLimiter, LimiterSlot } from '../state/index.js';
import { withRunMetrics } from '../metrics/withRunMetrics.js';
import { activeCollector } from '../metrics/activeCollector.js';
import { startPhase, endPhase } from '../metrics/timing.js';
import { toLLMUsage } from '../metrics/workerUsage.js';
import { buildRunAttribution } from '../metrics/runAttribution.js';
import type { RunScope, RunOutcome } from '../metrics/types.js';
import { EpicYamlSchema, StorySchema, type Story, type AgentStatus } from '../types.js';
import { approveAndDispatch } from './actions/approveAndDispatch.js';
import {
  SkillStore,
  SkillSelector,
  SkillGenerator,
  SkillLifecycle,
} from '../skills/index.js';
import type { SkillEventCallback } from '../skills/SkillEvent.js';
import { PolicyEngine } from '../guardrails/index.js';
import {
  McpRegistry,
  materializeWorktreeMcpConfig,
} from '../mcp/index.js';
import { materializeWorktreeReadScope } from './WorktreeReadScope.js';
import { enforceCursorMcpAllowlist } from './CursorMcpEnforcer.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeJanitor } from './WorktreeJanitor.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';
import { resolvePrimaryRepo } from '../home/primaryRepo.js';
import { resolveStoryRepo } from './resolveStoryRepo.js';
import { IntegrationBranch } from './IntegrationBranch.js';
import { IntegrationGate } from './IntegrationGate.js';
import type {
  WorkerRunner,
  WorkerAssignment,
  WorkerResult,
  WorkerEventCallback,
} from './WorkerRunner.js';
import type { EpicFinalizer } from './EpicFinalizer.js';
import { WorkerWatchdog } from './WorkerWatchdog.js';
import { StoryHandoff } from './StoryHandoff.js';
import { StoryContext } from './StoryContext.js';
import { EpicBuildup } from './EpicBuildup.js';
import { parseConventions } from './conventionsMarker.js';
import { gitSafe } from './git.js';
import type { WorkerInputChannel } from './WorkerInputChannel.js';
import { SpawnStagger } from './resilience/SpawnStagger.js';
import { SystemRetryClock, Mulberry32 } from './resilience/RetryClock.js';
import {
  assembleWorkerContext,
  type PlanningArtifacts,
} from '../worker/contextAssembler.js';
import { investigateAndRoute } from '../failure/investigateAndRoute.js';
import { computeHeuristics, buildStorySignals } from './signalLedger.js';
import { SignalLedger } from './signalStore.js';
import { redactSecrets } from '../util/redact.js';
import { StoryRetryService } from './StoryRetryService.js';
import { recordStallKill, recordAutoRecovery } from './StallKillAudit.js';
import { classifyWorkerExit } from './classifyWorkerExit.js';

// ─── Reroute imports (epic-095 story-095-005) ─────────────────────────────────
import {
  handleReroute,
  injectSubStories,
  validateSubStories,
  RerouteBudgetExhaustedError,
  RerouteValidationError,
  type ReroutePayload,
  type DownstreamOverride,
  type DownstreamRequiresOverride,
} from './rerouteHandler.js';
import { LOOM_TOO_BIG_SIGNAL, matchTooBigSignal } from './constants.js';

// ─── LOOM_PROVIDES helpers (epic-095 story-095-004) ──────────────────────────
// Exported at module level so unit tests can exercise them directly.

/**
 * Thrown by `parseLoomProvides` when a LOOM_PROVIDES line is found but its
 * JSON payload is malformed or not a plain object.
 */
export class LoomProvidesParseError extends Error {
  constructor(public readonly raw: string) {
    super(`LOOM_PROVIDES trailer is malformed: ${raw.slice(0, 100)}`);
    this.name = 'LoomProvidesParseError';
  }
}

/**
 * Checks whether every `requires` entry on `story` is satisfied by the
 * `completedProvides` map (story-id → parsed provides object).
 * Returns `{ ok: true, unmet: [] }` when all keys are present, or
 * `{ ok: false, unmet: [key, ...] }` listing every missing key.
 */
export function checkRequires(
  story: Story,
  completedProvides: Map<string, Record<string, unknown>>
): { ok: boolean; unmet: string[] } {
  if (!story.requires || Object.keys(story.requires).length === 0) {
    return { ok: true, unmet: [] };
  }
  const unmet: string[] = [];
  for (const [key, sourceStoryId] of Object.entries(story.requires)) {
    const storyProvides = completedProvides.get(sourceStoryId);
    if (!storyProvides || !(key in storyProvides)) {
      unmet.push(key);
    }
  }
  return { ok: unmet.length === 0, unmet };
}

/**
 * Builds the `## Upstream Provides` Markdown block content for stories that
 * have `requires` entries. Returns an empty string when no entries are available
 * (story has no requires, or none of the required keys are in the provides map).
 *
 * Newlines inside JSON-serialized values are escaped so they do not break the
 * Markdown bullet-list boundary.
 */
function buildProvidesBlock(
  story: Story,
  provides: Map<string, Record<string, unknown>>
): string {
  if (!story.requires || Object.keys(story.requires).length === 0) return '';
  const entries: Array<[string, unknown]> = [];
  for (const [key, sourceStoryId] of Object.entries(story.requires)) {
    const storyProvides = provides.get(sourceStoryId);
    if (storyProvides !== undefined && key in storyProvides) {
      entries.push([key, storyProvides[key]]);
    }
  }
  if (entries.length === 0) return '';
  return [
    '',
    '## Upstream Provides',
    '',
    'The following values were produced by upstream stories and are available for use:',
    '',
    ...entries.map(([key, value]) => {
      const serialized = JSON.stringify(value).replace(/\n/g, '\\n');
      return `- **${key}**: ${serialized}`;
    }),
  ].join('\n');
}

/**
 * Appends a `## Upstream Provides` block to `basePrompt` listing every
 * key/value pair from `provides` that this story's `requires` map references.
 * No-op (returns `basePrompt` unchanged) when `story.requires` is absent or empty.
 */
export function injectProvidesSection(
  basePrompt: string,
  story: Story,
  provides: Map<string, Record<string, unknown>>
): string {
  const block = buildProvidesBlock(story, provides);
  return block ? basePrompt + block : basePrompt;
}

/**
 * Scans `rawOutput` for the last line that starts with `LOOM_PROVIDES ` (own
 * line, trimmed) and parses the JSON payload.
 *
 * - Returns `null` when no matching line is found (no trailer present).
 * - Returns the parsed `Record<string, unknown>` on a valid JSON-object trailer.
 * - Throws `LoomProvidesParseError` when a matching line is found but the JSON
 *   is malformed or not a plain object (array, null, primitive).
 */
export function parseLoomProvides(rawOutput: string): Record<string, unknown> | null {
  const MARKER = 'LOOM_PROVIDES ';
  let lastMatch: string | null = null;
  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MARKER)) {
      lastMatch = trimmed;
    }
  }
  if (lastMatch === null) return null;

  const jsonStr = lastMatch.slice(MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new LoomProvidesParseError(lastMatch);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LoomProvidesParseError(lastMatch);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Scans a log tail string for a LOOM_TOO_BIG_SIGNAL line. Returns the
 * fan-out payload (the text after the signal keyword, trimmed) when found,
 * or `undefined` when the signal is absent. "Last occurrence wins" so a
 * worker that emits the signal multiple times uses the final payload.
 *
 * Used as the logTail fallback in applyResult (mirrors LOOM_PROVIDES's
 * logTail fallback so test runners that bypass onOutput still trigger reroutes).
 */
function scanLogTailForTooBigSignal(logTail: string): string | undefined {
  let result: string | undefined;
  for (const line of logTail.split('\n')) {
    const payload = matchTooBigSignal(line);
    if (payload !== undefined) result = payload; // last occurrence wins
  }
  return result;
}

export interface SupervisorOptions {
  projectRoot: string;
  db: Database.Database;
  worker: WorkerRunner;
  /** Max worker agents running concurrently (policy.agents.max_concurrent). */
  maxConcurrent: number;
  /**
   * PM persona for story re-split (epic-095 story-095-005). When set, the
   * Supervisor invokes this agent whenever a worker emits `LOOM_TOO_BIG` or
   * is killed by absoluteCapMs. When unset, those triggers surface as normal
   * failed stories (backward-compat: no reroute path active).
   */
  pmAgent?: import('./rerouteHandler.js').PMAgent;
  /** When set, relevant skills are injected into each worker assignment. */
  skillStore?: SkillStore;
  /** When set, runs post-story skill extraction after each successful story. */
  skillGenerator?: SkillGenerator;
  /** When set, promotes/demotes generated skills after the run (anti-degradation). */
  skillLifecycle?: SkillLifecycle;
  /**
   * When set, every worker dispatch first acquires a slot from this shared,
   * machine-level limiter — so several loom runs do not collectively exceed
   * the developer's Claude session capacity. Unset = bounded only by
   * `maxConcurrent`.
   */
  globalLimiter?: GlobalLimiter;
  /** Poll interval (ms) when waiting for a global slot. Defaults to 1500. */
  globalPollMs?: number;
  /**
   * Lifecycle sink for the run — `dispatched` / `output` / `completed` events
   * stream out as workers progress. Used by the CLI for live feedback and to
   * write a rolling log_tail to the DB so other processes (pi) can see it.
   */
  onWorkerEvent?: WorkerEventCallback;
  /**
   * Lifecycle sink for the self-learning loop — `injected` / `generated` /
   * `promoted` / `demoted`. The events run silently otherwise; surfacing them
   * is the only way the operator can see candidate promotions and demotions
   * happening (issue #4).
   */
  onSkillEvent?: SkillEventCallback;
  /**
   * Controls when SkillGenerator runs after a successful story:
   *   'on'      — every successful story
   *   'off'     — never
   *   'sampled' — every Nth successful story (see skillGenerationSampleN)
   * Sourced from SKILL_GENERATION; defaults to 'on'.
   */
  skillGenerationMode?: 'on' | 'off' | 'sampled';
  /** N for skill_generation: 'sampled' — generate on every Nth success. */
  skillGenerationSampleN?: number;
  /**
   * When set, this finalizer runs at end-of-epic for any epic that
   * transitioned to 'done' — it merges the succeeded story branches into a
   * single `epic/<id>` branch and opens one PR.
   */
  epicFinalizer?: EpicFinalizer;
  /**
   * INTEGRATION_BRANCH. When 'rolling', the supervisor creates a
   * live `epic/<id>` branch up front, branches every worker from its tip, and
   * merges each story back as it completes (rolling integration). 'off'
   * (default) keeps the legacy topology: workers branch from their first
   * dependency and the EpicFinalizer big-bang-merges at the end. The caller
   * passes 'rolling' only under pr_strategy='per-epic'.
   */
  integrationBranch?: 'off' | 'rolling';
  /**
   * INTEGRATOR. When 'on' (and INTEGRATION_BRANCH='rolling'), a
   * story whose merge-back conflicts is handed to a bounded integrator agent
   * that resolves the conflict in the integration worktree; loom commits the
   * merge and re-runs the gate. Only on a green result is the story integrated.
   * Exhausting the attempts (or any failure) falls back to the loud-block path —
   * the conflict is never silently dropped. 'off' (default) keeps the 3a
   * behavior: a merge conflict blocks the story immediately.
   */
  integrator?: 'off' | 'on';
  /** Resolve+gate rounds before giving up (default 1). */
  integratorMaxAttempts?: number;
  /** policy.agents.test_command — the gate command the integrator re-runs after a resolution. */
  testCommand?: string;
  /** Integration gate timeout (ms) — bound for the integrator's gate run. */
  integrationGateTimeoutMs?: number;
  /** Injectable gate for the integrator (tests). Defaults to one built from the fields above. */
  integratorGate?: IntegrationGate;
  /**
   * Late-bound policy refresh for the bounded integrator's gate. The EpicFinalizer
   * has its own `refreshPolicy` for finalize-time fields; this one is invoked at
   * the entry of every integrator attempt so a `test_command` edit made
   * mid-run (the postmortem scenario) actually changes which command the
   * integrator re-runs to validate its resolution. Unset = no rebind (today's
   * behavior preserved for tests). Emits an `integrator_gate_rebound` audit
   * row when the live value differs from the running effective value.
   */
  refreshIntegratorPolicy?: () => { testCommand?: string };
  /**
   * CONTEXT_NOTES. When 'on', a "what I built" note is written to
   * .loom/context/<story-id>.md when a story succeeds (and, in rolling mode,
   * integrates) so dependent workers can be primed with its decisions + surface
   * area. 'off' (default) writes nothing and keeps the worker prompt
   * byte-identical to the bench baseline.
   */
  contextNotes?: 'off' | 'on';
  /**
   * EPIC_BUILDUP. When 'on', a concise entry (summary, files
   * touched, key decisions) is appended to the epic-cumulative build-up doc at
   * <projectRoot>/.loom/buildup/<epic-id>.json on each successful story. No
   * extra model calls — all written from the supervisor's single process.
   * 'off' (default) writes nothing and keeps the worker prompt byte-identical
   * to the bench baseline (gates appendStoryEntry on success).
   */
  epicBuildup?: 'off' | 'on';
  /**
   * policy.agents.distill_context. When 'on', the supervisor runs the
   * doc-distiller over each story's planning artifacts (PRD, epic, architecture,
   * story) once at dispatch — recording the standard skill_usage row and a
   * `context.distilled` audit row, and warning when the ~55% compression target
   * is missed. 'off' (default) skips it entirely, so a run that does not opt in
   * is byte-identical to the bench baseline. Best-effort: a distillation error
   * never blocks the worker spawn.
   */
  distillWorkerContext?: 'off' | 'on';
  /**
   * Checkpoint mode — stop cleanly at a boundary instead of completing everything:
   *  'story' — run one story, then stop;  'epic' — run one epic, then stop.
   * Undefined = complete all approved epics.
   */
  checkpoint?: 'story' | 'epic';
  /**
   * Per-story worker watchdog config (ANALYSIS_ONLY_WATCHDOG).
   * When `enabled` is true, the supervisor instantiates a WorkerWatchdog
   * for each dispatched story and feeds it the trace stream. After
   * `warnSec` with zero edit-class calls the watchdog emits a warning
   * audit row; after `killSec` it SIGTERMs the worker subprocess.
   *
   * Default disabled — bench baseline preservation.
   */
  watchdog?: {
    enabled: boolean;
    /** Defaults to 600s — engineering tuning, not an operator knob. */
    warnSec?: number;
    /** Defaults to 1200s — engineering tuning, not an operator knob. */
    killSec?: number;
  };
  /**
   * Per-story handoff mode (policy.agents.handoff). On a failed/blocked story
   * the supervisor materializes `.loom/handoff/<story-id>.md` so a later retry
   * can resume from it. 'off' disables; defaults to 'telemetry' (zero tokens).
   */
  handoffMode?: 'off' | 'telemetry' | 'summarized';
  /**
   * Workspace manifest for multi-repo dispatch. When set, each story's worktree
   * is created in the repo its `story.repo` field resolves to (falling back to
   * `primarySlug`). When absent, a synthetic single-entry manifest is derived
   * from `projectRoot` so single-repo behavior is byte-identical to pre-change.
   */
  manifest?: WorkspaceManifest;
  /**
   * Primary repo slug — required when `manifest` is provided and contains
   * multiple entries without a `primary: true` flag. Stories that don't declare
   * a `repo` field resolve to this slug. Ignored when `manifest` is absent.
   */
  primarySlug?: string;
  /**
   * Per-epic dispatch lease. ON by default: each epic is leased for the
   * duration of its dispatch so a second supervisor (a concurrent `loom run`,
   * an MCP retry racing a live run) cannot double-dispatch the same story into
   * its idempotent worktree. Set `false` only in tests that intentionally run
   * overlapping supervisors on one DB.
   */
  lease?: boolean;
  /**
   * Auto-prune orphaned worktrees at the end of a run (policy.agents.
   * prune_orphan_worktrees). ON by default: after finalizers run, any
   * `.loom/worktrees/<id>` whose story is `done` (merged) or has no agent
   * record is removed. Failed/blocked worktrees are always KEPT for resume
   * retry. Set `false` to disable (e.g. when debugging a completed worktree).
   */
  pruneOrphans?: boolean;
  /**
   * Spawn stagger for concurrent cursor-agent workers (story-006-004). When the
   * cursor-cli backend fans out several workers at once they each rewrite
   * `~/.cursor/cli-config.json` simultaneously (the "rename herd"), tripping the
   * `cli_config_rename` infra fault. The supervisor awaits a 1–2s jittered slot
   * from this stagger before each cursor-cli spawn so the spawns are spaced out.
   * Unset = the supervisor builds a production stagger (real clock + a
   * process-seeded PRNG) lazily for the cursor-cli backend only; tests inject a
   * deterministic one (fake clock + fixed seed) to assert spacing with no real
   * sleeps. Has no effect for the claude-code backend.
   */
  spawnStagger?: SpawnStagger;
  /**
   * The requested model id for worker agents. Written to agents.model at
   * dispatch time so every row is populated from the start. The ClaudeCodeWorker
   * upgrades this to the executed model via WorkerResult.model once the
   * system/init event arrives; backends that don't emit system/init (cursor-cli)
   * keep the requested value as the final record.
   */
  workerModel?: string;
  /**
   * Absolute path to the loom CLI entry-point script (process.argv[1] from the CLI).
   * When set, the supervisor writes a per-worker `.claude/settings.json` with a
   * PreToolUse hook that enforces read-scope boundaries via `loom guard hook`.
   * Omit to skip read-scope settings materialization (e.g. in library tests).
   */
  loomScriptPath?: string;
  /**
   * @deprecated No longer consumed. The stall-recovery path was replaced by the
   * durable clean-retry budget (`stallRecoveryBudget` / `STALL_RECOVERY_BUDGET`).
   * Setting this value has no effect — use `stallRecoveryBudget: 0` to disable
   * auto-recovery entirely. Kept for API compatibility; will be removed in a future release.
   */
  autoResumeAttempts?: number;
  /**
   * @deprecated No longer consumed. The stall recovery path now uses `cleanRetryService`
   * (a clean=true StoryRetryService). This field is retained for backwards-compatible
   * call sites but has no effect.
   */
  retryService?: StoryRetryService;
  /**
   * Per-story clean-retry budget on stall (STALL_RECOVERY_BUDGET).
   * When a worker stalls, the supervisor auto-retries with a fresh worktree +
   * branch up to this many times (durable, survives restarts). 0 disables.
   * Default 2 when unset.
   */
  stallRecoveryBudget?: number;
  /**
   * Injectable clean StoryRetryService for tests. Defaults to a clean-mode
   * (clean=true) instance built from projectRoot + db.
   */
  cleanRetryService?: StoryRetryService;
}

export interface SupervisorResult {
  epicsProcessed: string[];
  epicsSkipped: string[];
  storiesTotal: number;
  storiesDone: number;
  storiesFailed: number;
  storiesBlocked: number;
  storiesPending: number;
  /** True if the run stopped early — a `loom stop` or a checkpoint boundary. */
  halted: boolean;
}

interface StoryTask {
  epicId: string;
  story: Story;
  agentId: string;
  status: AgentStatus;
  /** Cached result of resolveStoryRepo — populated during the repoFilter pass to avoid a second resolution at dispatch time. */
  resolvedRepo?: { slug: string; root: string };
}

const SUCCESS: ReadonlySet<AgentStatus> = new Set(['done', 'pr_open']);
const FAILURE: ReadonlySet<AgentStatus> = new Set(['failed', 'blocked']);

/** How long to wait before retrying when the machine-wide worker cap is full. */
const GLOBAL_POLL_MS = 1500;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads approved epics, dependency-orders their stories, and dispatches up to
 * `maxConcurrent` worker agents — each in its own git worktree. Tracks every
 * status transition in the DB; the SQLite agents table is the source of truth.
 *
 * `run()` is resumable: stories already completed in a prior run are skipped.
 */
export class Supervisor {
  /** One WorktreeManager per resolved repo slug — lazily populated at dispatch. */
  private wtByRepo: Map<string, WorktreeManager>;
  /** Expected repo root per slug — guards against a slug being registered with two different roots. */
  private rootBySlug: Map<string, string>;
  /** Cached manifest context (manifest + primary slug) — resolved once on first use. */
  private _manifestCtx?: { manifest: WorkspaceManifest; primarySlug: string };
  private integration: IntegrationBranch;
  /** Gate the integrator re-runs after resolving a conflict; built only when on. */
  private integratorGate?: IntegrationGate;
  /**
   * Effective `test_command` used by the integrator's gate right now. Starts
   * from `opts.testCommand` and is updated by `rebindIntegratorGateIfChanged`
   * when the live policy changes — used to detect drift and rebuild the gate.
   */
  private effectiveIntegratorTestCommand?: string;
  private epics: EpicStore;
  private agents: AgentStore;
  private audit: AuditLog;
  private skillUsage: SkillUsageStore;
  private control: ControlStore;
  private decisionTraces: DecisionTraceStore;
  private lease: LeaseStore;
  private signalLedger: SignalLedger;
  /** Epics this run currently holds the dispatch lease for — heartbeated in
      the dispatch loop, released when run() returns. */
  private leasedEpics = new Set<string>();
  /** Post-story skill-generation promises, awaited before run() returns. */
  private skillGenPromises: Promise<unknown>[] = [];
  /** Counter of successful stories — drives `skill_generation: 'sampled'`. */
  private successCount = 0;
  /** Per-story branch base SHA captured at dispatch — used to scope the
      handoff doc's commit list to the worker's own commits. */
  private storyBaseSha = new Map<string, string>();
  /** Story ids that at least one OTHER story in the run depends on. Computed
      from the full epic DAG when tasks are built (only the Supervisor holds
      the whole story set); read at dispatch to set
      WorkerAssignment.hasDependents so the worker's completion copy never
      invents a downstream story. */
  private storiesWithDependents = new Set<string>();
  /** Lazily-resolved worker-MCP context (backend + registry) from policy.
      Cached after the first dispatch; the registry object re-reads its
      server.json files on every list() so `loom mcp add` mid-run is still
      picked up by later workers. */
  private mcpCtx?: {
    backend: 'claude-code' | 'cursor-cli';
    registry: McpRegistry | null;
  };
  /**
   * Spawn stagger for the cursor-cli backend (story-006-004). Resolved once on
   * first dispatch: an injected `opts.spawnStagger` (tests) wins; otherwise a
   * production stagger is built lazily for the cursor-cli backend and left
   * `null` for claude-code (no rename herd there, so no stagger). `undefined`
   * means "not yet resolved".
   */
  private spawnStagger?: SpawnStagger | null;
  /** Per-agent rolling output tails, flushed periodically to agents.log_tail. */
  private outputTails = new Map<string, { buffer: string; dirty: boolean }>();
  private tailFlushTimer: ReturnType<typeof setInterval> | null = null;
  /** Durable per-story log file writer. Rooted at <projectRoot>/.loom/logs/. */
  private workerLogs: WorkerLogStore;
  /** Cumulative post-redaction byte length per story, updated by onOutput. */
  private logBytes = new Map<string, number>();
  /**
   * Last LOOM_PROVIDES line seen in each story's streaming stdout, captured
   * by dispatch's onOutput before logTail truncation. Null = stream finished
   * with no LOOM_PROVIDES line found. Consumed and deleted by applyResult.
   */
  private capturedProvidesLines = new Map<string, string | null>();
  /** Maps agentId → storyId so flushTails can look up the log_bytes offset. */
  private agentToStory = new Map<string, string>();
  /** Durable per-story clean-retry budget store (story-061-001). */
  private recoveryStore!: RecoveryStore;
  /** Clean-retry service (clean=true) for stall auto-recovery (story-061-003). */
  private cleanRetryService!: StoryRetryService;
  /** Count of stall auto-recoveries within the current run. Reset at run entry. */
  private runAutoRecoveryCount = 0;
  /** Count of clean-worktree auto-recoveries within the current run. Reset at run entry. */
  private runCleanRetryCount = 0;
  /** Persists structured review findings per agent attempt (story-076-002). */
  private findings: FindingStore;

  // ─── Reroute state (epic-095 story-095-005) ───────────────────────────────
  /**
   * Streaming LOOM_TOO_BIG signal capture: storyId → fan-out payload string
   * seen in the most recent stdout line containing LOOM_TOO_BIG. Populated
   * during the dispatch's onOutput handler; consumed and cleared by
   * applyResult (injection point A). An empty string means the signal was
   * present but carried no payload (plain "LOOM_TOO_BIG" line).
   */
  private capturedTooBigSignals = new Map<string, string>();
  /**
   * Pending reroute descriptors: storyId → { trigger, fanOutPayload }.
   * Set by applyResult (injection points A and B) when a reroute is needed;
   * consumed and cleared by dispatchLoop's post-applyResult reroute sweep.
   */
  private pendingReroutes = new Map<
    string,
    { trigger: 'LOOM_TOO_BIG' | 'cap'; fanOutPayload: string }
  >();

  // ─── Operator-guidance file-watch state ───────────────────────────────
  // The Supervisor watches `.loom/guidance/<story-id>.md` and pushes
  // appended deltas into each live worker's stdin via the per-spawn
  // WorkerInputChannel. See docs/research/live-agent-guidance.md.
  /** Active per-story input channels — populated from WorkerAssignment.onChannel. */
  private channelsByStory = new Map<string, WorkerInputChannel>();
  /** Last byte offset we pushed for each story's guidance file. */
  private guidanceOffsets = new Map<string, number>();
  /** Pids of subprocesses this Supervisor owns — guards against pushing
      to a worker spawned by a different supervisor (Winston review S1). */
  private childPids = new Set<number>();
  /** Coalesces fs.watch events on macOS (multiple change events per
      logical write). */
  private guidanceDebounce = new Map<string, ReturnType<typeof setTimeout>>();
  /** The shared fs.watch handle for the guidance directory. */
  private guidanceWatcher: fs.FSWatcher | null = null;
  /** 100ms — enough to coalesce the multi-syscall `appendFileSync` storm
      without making operator-typed guidance feel sluggish. */
  private static readonly GUIDANCE_DEBOUNCE_MS = 100;

  /** Class-level registry of live Supervisors. Used by the single
      process-exit hook below to fan out cleanup. A static set + a single
      listener avoids EventEmitter MaxListeners warnings across many
      Supervisor instances (notably the test suite). */
  private static liveInstances = new Set<Supervisor>();
  private static exitHookInstalled = false;

  /** Max characters retained in a live tail before truncation. */
  static readonly LIVE_TAIL_CHARS = 4096;
  /** How often the live tails are flushed to the DB. */
  private static readonly TAIL_FLUSH_MS = 1000;

  /** True when this run uses the rolling integration branch (PR 3a). */
  private get rolling(): boolean {
    return this.opts.integrationBranch === 'rolling';
  }

  /**
   * True when the bounded integrator (PR 3b) should attempt to auto-resolve a
   * merge-back conflict. Only meaningful under the rolling branch — that is the
   * sole place a story merge happens mid-run — and only if the worker backend
   * actually exposes the resolveConflicts capability.
   */
  private get integratorEnabled(): boolean {
    return (
      this.rolling &&
      this.opts.integrator === 'on' &&
      typeof this.opts.worker.resolveConflicts === 'function'
    );
  }

  /** Resolve+gate attempts before the integrator gives up and the story blocks.
      Default bumped from 1→2 after the multi-epic shared-client run: a single
      transient gate failure (often caused by an over-broad auto-detected gate
      command before that fix landed) guaranteed a block; one extra round
      gives the bounded integrator real room to self-heal. */
  private get integratorMaxAttempts(): number {
    return Math.max(1, this.opts.integratorMaxAttempts ?? 2);
  }

  constructor(private opts: SupervisorOptions) {
    this.wtByRepo = new Map();
    this.rootBySlug = new Map();
    this.workerLogs = new WorkerLogStore(path.join(opts.projectRoot, '.loom'));
    this.integration = new IntegrationBranch(opts.projectRoot);
    if (opts.integrationBranch === 'rolling' && opts.integrator === 'on') {
      this.integratorGate =
        opts.integratorGate ??
        new IntegrationGate({
          testCommand: opts.testCommand,
          timeoutMs: opts.integrationGateTimeoutMs ?? 15 * 60_000,
        });
      this.effectiveIntegratorTestCommand = opts.testCommand;
    }
    this.epics = new EpicStore(opts.db);
    this.agents = new AgentStore(opts.db);
    this.audit = new AuditLog(opts.db);
    this.skillUsage = new SkillUsageStore(opts.db);
    this.control = new ControlStore(opts.db);
    this.decisionTraces = new DecisionTraceStore(opts.db);
    this.lease = new LeaseStore(opts.db);
    this.signalLedger = new SignalLedger({ db: opts.db, projectRoot: opts.projectRoot });
    this.recoveryStore = new RecoveryStore(opts.db);
    this.findings = new FindingStore(opts.db);
    this.cleanRetryService = opts.cleanRetryService ?? new StoryRetryService({
      projectRoot: opts.projectRoot,
      db: opts.db,
      clean: true,
      leaseStore: this.lease,
    });
  }

  /**
   * Dispatches approved epics. Accepts either:
   *  - `string[]` (legacy): list of epic IDs, or undefined for all approved epics.
   *  - `{ epicIds?, epicId?, repoFilter? }` (new seam for per-repo partitioning):
   *    optionally scope to a single epicId/array and filter dispatched stories to
   *    those resolving to `repoFilter` slug so one supervisor handles one repo
   *    partition of a cross-repo epic. Planned consumer: CrossRepoCoordinator.
   */
  async run(
    epicIdsOrOpts?: string[] | { epicId?: string; epicIds?: string[]; repoFilter?: string }
  ): Promise<SupervisorResult> {
    // Normalize the two call forms into epicIds + optional repoFilter BEFORE
    // entering withRunMetrics so scope can be determined structurally.
    let epicIds: string[] | undefined;
    let repoFilter: string | undefined;
    if (Array.isArray(epicIdsOrOpts) || epicIdsOrOpts === undefined) {
      epicIds = epicIdsOrOpts;
    } else {
      if (epicIdsOrOpts.epicId !== undefined && epicIdsOrOpts.epicIds !== undefined) {
        throw new Error('run(): pass either epicId or epicIds, not both');
      }
      const singleId = epicIdsOrOpts.epicId;
      epicIds = singleId !== undefined ? [singleId] : epicIdsOrOpts.epicIds;
      repoFilter = epicIdsOrOpts.repoFilter;
    }
    // Determine scope structurally from the resolved input — a single story-prefixed
    // ID is a standalone-story dispatch; everything else is an epic dispatch.
    const initialScope: RunScope = (epicIds?.length === 1 && epicIds[0]?.startsWith('story-'))
      ? 'standalone_story'
      : 'epic';
    return withRunMetrics(
      { scope: initialScope, store: new MetricsStore(this.opts.db) },
      async () => {
    // Capture run start time before any work begins.
    const runStartedAt = new Date().toISOString();

    this.skillGenPromises = [];
    this.outputTails.clear();
    this.logBytes.clear();
    this.agentToStory.clear();
    this.successCount = 0;
    this.runAutoRecoveryCount = 0;
    this.runCleanRetryCount = 0;
    // Clear any stale stop signal from a previous run.
    this.control.setState('running');

    // Seam 1: auto-approve planned epics with non-manual autonomy so they
    // flow straight into dispatch without waiting for a human approval call.
    // manual → leave 'planned' (current behavior, unchanged).
    // checkpoint | full-auto → approveAndDispatch({actor:'full-auto'}) then
    // fall through into the normal dispatch loop below.
    const loomDir = path.join(this.opts.projectRoot, '.loom');
    const planningCandidates = epicIds
      ? epicIds.map((id) => this.epics.get(id)).filter((e) => e?.status === 'planned')
      : this.epics.listByStatus('planned');
    for (const epic of planningCandidates) {
      if (!epic) continue;
      const autonomy = this.epics.getAutonomy(epic.id);
      if (autonomy !== 'manual') {
        let policy: ReturnType<typeof PolicyEngine.defaultPolicy>;
        try {
          policy = PolicyEngine.load(loomDir).policyData;
        } catch {
          // Never let a policy load failure crash dispatch — use safe defaults.
          policy = PolicyEngine.defaultPolicy();
        }
        await approveAndDispatch(
          { epicStore: this.epics, auditLog: this.audit, policy },
          epic.id,
          { actor: 'full-auto' }
        );
      }
    }

    const { selected, skipped, recoverable } = this.selectEpics(epicIds);

    // Per-epic dispatch lease. Acquire each selected epic; an epic another
    // live supervisor already holds is deferred (reported as skipped) rather
    // than double-dispatched into its idempotent worktrees. ON unless a test
    // disables it.
    const leaseOn = this.opts.lease !== false;
    const leased: string[] = [];
    const deferred: string[] = [];
    for (const epicId of selected) {
      if (!leaseOn || this.lease.acquire(epicId)) {
        leased.push(epicId);
        if (leaseOn) this.leasedEpics.add(epicId);
      } else {
        deferred.push(epicId);
        const h = this.lease.holder(epicId);
        this.audit.record({
          agent_id: undefined,
          action: 'dispatch_deferred',
          command: epicId,
          allowed: false,
          detail: {
            reason: 'another active supervisor holds the dispatch lease',
            holder_pid: h?.pid,
            holder_host: h?.hostname,
          },
        });
      }
    }
    const allSkipped = [...skipped, ...deferred];

    // Build the story pool across every leased epic. In rolling mode each epic
    // gets its live `epic/<id>` branch + integration worktree created up front
    // (before any worker branches from its tip). An epic whose setup fails is
    // left for a later retry and excluded from dispatch + finalize.
    const tasks = new Map<string, StoryTask>();
    const setupFailed = new Set<string>();
    for (const epicId of leased) {
      this.epics.updateStatus(epicId, 'in_progress');
      if (this.rolling && !this.ensureIntegrationBranch(epicId)) {
        setupFailed.add(epicId);
        continue;
      }
      // Resume-time reconciliation: agents left in the transient 'integrating'
      // status (a crash between `integrateStory`'s entry and its terminal
      // restore) must be resolved BEFORE taskFor decides what to do, or
      // taskFor would treat them as not-SUCCESS and dispatch a fresh worker
      // — duplicating work whose merge may already be on epic/<id>.
      if (this.rolling) this.reconcileIntegratingAgents(epicId);
      const { manifest: mf, primarySlug: ps } = this.manifestContext();
      // Restart-recovery snapshot (epic-095 reroute rework). Capture each story's
      // latest agent row BEFORE the taskFor loop below runs — taskFor mints a fresh
      // 'pending' row (with superseded_by / dep_overrides / requires_overrides all
      // NULL) for any non-SUCCESS story, which would MASK the reroute markers if we
      // read them post-loop. Snapshotting first is what makes the reroute durable
      // across a `loom run` restart. Only the simple (non-repoFilter) path can carry
      // reroute state — cross-repo partitioning never split-and-reroutes.
      const rerouteSnapshot =
        repoFilter === undefined ? this.agents.listLatestByEpic(epicId) : [];
      const supersededIds = new Set<string>(
        rerouteSnapshot.filter((r) => r.superseded_by != null).map((r) => r.story_id)
      );

      for (const story of this.loadStories(epicId)) {
        // Superseded original: a prior run rerouted this YAML story into sub-stories.
        // Skip it entirely — no task, no taskFor row — so it is neither re-dispatched
        // nor re-split, and so its stale 'failed' row never masks the supersede marker.
        if (repoFilter === undefined && supersededIds.has(story.id)) {
          continue;
        }
        // When repoFilter is set, skip stories that belong to a different repo.
        // This is the seam consumed by CrossRepoCoordinator (story-058-005) to
        // dispatch one repo partition at a time.
        if (repoFilter !== undefined) {
          let resolved: { slug: string; root: string };
          try {
            resolved = resolveStoryRepo(story, mf, ps);
          } catch (e) {
            // Resolution failure: write an audit record so the drop is visible
            // via `loom status`, then skip from this partition. Including an
            // unresolvable story in every partition would cause it to fail in
            // each one, multiplying failures and corrupting per-story state if
            // the store is shared. Logging here makes zero-partition coverage
            // observable rather than a silent vanish.
            this.audit.record({
              action: 'story_skipped',
              command: epicId,
              detail: {
                storyId: story.id,
                reason: 'repo_unresolvable',
                repoFilter,
                error: e instanceof Error ? e.message : String(e),
              },
            });
            continue;
          }
          if (resolved.slug !== repoFilter) continue;
          const task = this.taskFor(epicId, story);
          task.resolvedRepo = resolved;
          tasks.set(story.id, task);
        } else {
          tasks.set(story.id, this.taskFor(epicId, story));
        }
      }
      // Restart recovery: re-hydrate injected sub-stories + re-apply downstream
      // dep/requires overrides from the PRE-taskFor snapshot (post-loop rows are
      // masked — see the snapshot comment above). Only the non-repoFilter path.
      if (repoFilter === undefined) {
        for (const row of rerouteSnapshot) {
          // Superseded originals were already skipped in the loop above, so their
          // masking row was never created; nothing to do here.
          if (row.superseded_by != null) continue;
          // Sub-story recovery: rows with story_json were injected by injectSubStories.
          if (row.story_json != null && !tasks.has(row.story_id)) {
            try {
              const parsed = StorySchema.parse(JSON.parse(row.story_json));
              if (FAILURE.has(row.status)) {
                // A transiently-failed injected sub-story must be retried on the next
                // run — mirroring taskFor's "failed YAML story ⇒ fresh pending attempt"
                // semantics. Injected sub-stories never pass through taskFor (they are
                // not in the YAML), so without this a failed sub-story would hydrate as
                // terminal 'failed' and strand the epic forever. Mint a fresh pending
                // row that carries story_json forward so future restarts still see it.
                const retry = this.agents.create(epicId, parsed.id, parsed.title, row.story_json);
                tasks.set(parsed.id, { epicId, story: parsed, agentId: retry.id, status: 'pending' });
              } else {
                tasks.set(parsed.id, {
                  epicId,
                  story:   parsed,
                  agentId: row.id,
                  status:  row.status,
                });
              }
            } catch {
              this.audit.record({
                action: 'sub_story_json_corrupt',
                command: row.story_id,
                allowed: false,
                detail: { epicId, agentId: row.id },
              });
            }
          }
          // dep_overrides recovery: re-point downstream YAML stories re-directed
          // by a prior reroute (dep_overrides survives in the DB across restarts).
          if (row.dep_overrides != null) {
            const t = tasks.get(row.story_id);
            if (t) {
              try {
                const newDeps = JSON.parse(row.dep_overrides) as string[];
                t.story = { ...t.story, dependencies: newDeps };
              } catch { /* corrupt dep_overrides: leave YAML deps unchanged */ }
            }
          }
          // requires_overrides recovery (epic-095 reroute rework): re-point a
          // downstream story's `requires` map exactly as dep_overrides re-points
          // its dependencies, so checkRequires / buildProvidesMapForStory resolve
          // to the sub-story that now provides the required key instead of the
          // superseded original (whose provides_output is NULL).
          if (row.requires_overrides != null) {
            const t = tasks.get(row.story_id);
            if (t) {
              try {
                const newReq = JSON.parse(row.requires_overrides) as Record<string, string>;
                t.story = { ...t.story, requires: newReq };
              } catch { /* corrupt requires_overrides: leave YAML requires unchanged */ }
            }
          }
        }
      }
    }
    // Build the dependents index from the full DAG up front — only the
    // Supervisor sees every story, so the worker must NOT topo-derive this.
    // A story "has dependents" iff some other story names it in dependencies[].
    this.storiesWithDependents.clear();
    for (const task of tasks.values()) {
      for (const dep of task.story.dependencies) {
        this.storiesWithDependents.add(dep);
      }
    }
    const activeEpics = leased.filter((e) => !setupFailed.has(e));

    let result: SupervisorResult;
    try {
      // Start the live-tail flush so pi (and any other reader of the DB) sees
      // running workers' stdout/stderr as it arrives, not only at completion.
      this.startTailFlush();
      // Start watching for operator guidance so live workers can be steered
      // mid-spawn (no-op for backends with NO_OP_CHANNEL — file simply isn't
      // pushed anywhere, but the existing per-revision pickup still works).
      this.startGuidanceWatcher();
      let halted: boolean;
      try {
        halted = await this.dispatchLoop(tasks, activeEpics);
      } finally {
        this.stopTailFlush();
        this.stopGuidanceWatcher();
      }

      // Let post-story skill generation finish before reporting completion.
      await Promise.allSettled(this.skillGenPromises);

      // Anti-degradation: promote proven candidate skills, demote failing ones.
      // Surface every change as a SkillEvent and audit-log row so the operator
      // can see why a skill moved between candidate / active / disabled.
      const changes = this.opts.skillLifecycle?.evaluate() ?? [];
      for (const change of changes) {
        this.audit.record({
          action: 'skill_lifecycle_change',
          command: change.skill,
          detail: { from: change.from, to: change.to, reason: change.reason },
        });
        this.opts.onSkillEvent?.({
          type: change.to === 'disabled' ? 'demoted' : 'promoted',
          skillName: change.skill,
          from: change.from,
          to: change.to,
          reason: change.reason,
        });
      }

      // An epic is 'done' only when every story succeeded. If any story failed
      // or was blocked, leave it 'in_progress' so a later `loom run` retries it
      // (the supervisor is resumable — completed stories are skipped). Epics
      // whose rolling setup failed are skipped here — already left in_progress.
      for (const epicId of activeEpics) {
        const epicTasks = [...tasks.values()].filter((t) => t.epicId === epicId);
        const allSucceeded = epicTasks.every((t) => SUCCESS.has(t.status));
        if (!allSucceeded) {
          // A failed/blocked story leaves the epic in_progress for a retry.
          this.epics.updateStatus(epicId, 'in_progress');
          continue;
        }
        // Per-epic PR: only finalize when the whole epic succeeded; partial
        // runs leave the work on story branches for the user to inspect.
        if (this.opts.epicFinalizer) {
          await this.finalizeAndGateDone(epicId);
        } else {
          // No finalizer wired: there is no per-epic PR flow, so the epic-PR
          // gate doesn't apply — preserve the legacy "all stories done ⇒ done".
          this.epics.updateStatus(epicId, 'done');
        }
      }

      // Auto-prune orphaned worktrees. Restricted to `no-agent` dirs (a
      // worktree with no DB record at all): `completed` worktrees are left to
      // the EpicFinalizer, which deletes them only after a successful merge —
      // pruning them here would discard work when a per-epic merge conflicts.
      // Failed/blocked worktrees are preserved by the janitor for resume retry.
      // Best effort — never let cleanup crash a completed run.
      if (this.opts.pruneOrphans !== false) {
        try {
          // Ensure the primary repo's WorktreeManager is always in wtByRepo so
          // WorktreeJanitor can prune orphans from prior crashed runs even when
          // no stories were dispatched this run (e.g. all stories already
          // completed on a resume). wtByRepo is only populated by dispatch, so
          // we seed it here if still empty. Guarded inside pruneOrphans so a
          // non-existent primary path never aborts a completed run.
          const { manifest: mf, primarySlug: ps } = this.manifestContext();
          const primaryEntry = mf.repos.find((r) => r.slug === ps);
          if (primaryEntry && !this.wtByRepo.has(ps)) {
            this.worktreeFor(ps, primaryEntry.path);
          }
          // Prune orphans across every repo whose worktrees this run touched.
          const allPruned: Array<{ storyId: string; reason: string }> = [];
          for (const [, mgr] of this.wtByRepo) {
            const pruned = new WorktreeJanitor(mgr, this.agents).prune({ reasons: ['no-agent'] });
            for (const p of pruned) allPruned.push({ storyId: p.storyId, reason: p.reason });
          }
          if (allPruned.length > 0) {
            this.audit.record({
              action: 'worktrees_pruned',
              command: leased.join(','),
              detail: {
                count: allPruned.length,
                worktrees: allPruned.map((p) => ({ story: p.storyId, reason: p.reason })),
              },
            });
          }
        } catch {
          // Pruning is housekeeping; a failure must not fail the run.
        }
      }

      // FR-6: Resume stranded finalizing/publish_pending epics. resume() owns
      // the done write and acquires the per-epic lease internally (NFR-1), so no
      // run-local lock is needed here. Best-effort — a resume error never fails
      // the run; the epic lands in epicsSkipped so FR-9 can print the recovery hint.
      const recoveredEpics: string[] = [];
      const recoverableSkipped: string[] = [];
      if (this.opts.epicFinalizer && recoverable.length > 0) {
        for (const epicId of recoverable) {
          try {
            const fin = await this.opts.epicFinalizer.resume(epicId);
            if (fin.status === 'merged') {
              recoveredEpics.push(epicId);
            } else {
              // Not landed — skipped (noop/lease), publish_pending, failed, gated,
              // or partial. Route to skipped so it counts as unprocessed and FR-9
              // prints the recovery hint, instead of falsely reporting "processed".
              recoverableSkipped.push(epicId);
            }
          } catch (err) {
            this.audit.record({
              agent_id: undefined,
              action: 'epic_finalize_resume_error',
              command: epicId,
              allowed: false,
              detail: { error: (err as Error).message },
            });
            recoverableSkipped.push(epicId);
          }
        }
      } else {
        recoverableSkipped.push(...recoverable);
      }

      const all = [...tasks.values()];
      result = {
        epicsProcessed: [...leased, ...recoveredEpics],
        epicsSkipped: [...allSkipped, ...recoverableSkipped],
        storiesTotal: all.length,
        storiesDone: all.filter((t) => SUCCESS.has(t.status)).length,
        storiesFailed: all.filter((t) => t.status === 'failed').length,
        storiesBlocked: all.filter((t) => t.status === 'blocked').length,
        storiesPending: all.filter((t) => t.status === 'pending').length,
        halted,
      };
    } finally {
      // Always release our dispatch leases so the next run (or a retry) can
      // proceed — even if dispatch threw.
      for (const epicId of this.leasedEpics) this.lease.release(epicId);
      this.leasedEpics.clear();
    }
    // Terminal region (story-065-004): set attribution strictly after fn settles,
    // never inside per-story/retry/auto-recovery loops. Fail-open (ADR-006).
    try {
      const primaryEpicId = leased[0];
      // Use initialScope (set structurally before withRunMetrics) rather than
      // re-inferring scope from the ID string at the terminal region.
      const isStandaloneDispatch = initialScope === 'standalone_story';
      const outcome: RunOutcome =
        result.storiesTotal > 0 &&
        result.storiesDone === result.storiesTotal &&
        !result.halted
          ? 'done'
          : 'failed';
      const priorRunCount = primaryEpicId
        ? isStandaloneDispatch
          ? ((this.opts.db
              .prepare('SELECT COUNT(*) AS n FROM run_metrics WHERE story_id = ?')
              .get(primaryEpicId) as { n: number } | undefined)?.n ?? 0)
          : ((this.opts.db
              .prepare('SELECT COUNT(*) AS n FROM run_metrics WHERE epic_id = ?')
              .get(primaryEpicId) as { n: number } | undefined)?.n ?? 0)
        : 0;
      activeCollector()?.setAttribution(buildRunAttribution({
        scope: initialScope,
        epicId: isStandaloneDispatch ? undefined : primaryEpicId,
        storyId: isStandaloneDispatch ? primaryEpicId : undefined,
        intakeVerdict: isStandaloneDispatch ? 'story' : 'epic',
        storyCount: result.storiesTotal,
        retryCount: priorRunCount,
        cleanRetryCount: this.runCleanRetryCount,
        autoRecoveryCount: this.runAutoRecoveryCount,
        outcome,
        startedAt: runStartedAt,
        endedAt: new Date().toISOString(),
      }));
    } catch {
      // fail-open — attribution must never propagate into the run
    }
    return result;
    }
  );
  }

  /**
   * Runs the EpicFinalizer for a fully-succeeded epic and applies the ADR-3
   * write-ordering `done`-gate: `done` is written ONLY after the finalizer has
   * persisted the epic PR URL (`recordPrUrl`). The finalizer itself never
   * writes `done` — it leaves a defined terminal status:
   *   - happy PR path → `epic_pr_url` set → we flip to `done` here.
   *   - PR-less success (push-gate confirm, no remote, remote-not-allowed) →
   *     `epic_pr_url` stays null → we LEAVE the finalizer's terminal
   *     `finalizing`+phase state (a defined, not-stranded, not-`done` state).
   *   - `gated` (block) → the finalizer already flipped the epic back to
   *     `in_progress` → we leave it.
   *   - `publish_pending` → recoverable push/PR failure → the finalizer already
   *     wrote the state (status + finalize_ref + publish_note); do NOT call
   *     `fail()` or flip to `done`. Leave it for `loom publish`.
   *   - `failed` → terminal infra failure → `fail(id, message)` records the
   *     error and clears `finalize_phase`.
   *   - `skipped` → no PR flow → leave the prior status untouched.
   *
   * The done-gate reads `epic_pr_url` straight from the DB rather than trusting
   * `FinalizeResult.url`, so a crash between `recordPrUrl` and this read can
   * never produce a `done` with a null PR URL (the invariant `done ⇒
   * epic_pr_url != null`).
   */
  private async finalizeAndGateDone(epicId: string): Promise<void> {
    startPhase('finalize');
    let fin;
    try {
      fin = await this.opts.epicFinalizer!.finalize(epicId);
    } catch (err) {
      endPhase('finalize');
      // Never let a finalizer error crash the run — record it as a terminal
      // infra failure so the epic doesn't masquerade as still-finalizing, and
      // continue with the next epic.
      this.audit.record({
        agent_id: undefined,
        action: 'epic_finalize_error',
        command: epicId,
        allowed: false,
        detail: { error: (err as Error).message },
      });
      this.epics.fail(epicId, `finalize threw: ${(err as Error).message}`.slice(0, 500));
      return;
    }
    endPhase('finalize');

    if (fin.status === 'publish_pending') {
      this.audit.record({
        agent_id: undefined,
        action: 'epic_publish_pending',
        command: epicId,
        allowed: true,
        detail: { note: fin.note },
      });
      return; // finalizer already wrote state — do NOT fail() or done()
    }

    if (fin.status === 'failed') {
      // ADR-2: a finalize failure is a terminal infra failure. Record the
      // message + clear the live phase via fail(); never reaches `done`.
      this.epics.fail(epicId, fin.note.slice(0, 500));
      return;
    }

    // ADR-3 done-gate: flip to `done` ONLY when the epic PR URL is durably
    // recorded. Read it from the DB (not FinalizeResult.url) so the invariant
    // holds even across a crash between recordPrUrl and this read.
    const row = this.epics.get(epicId);
    if (row?.epic_pr_url) {
      this.epics.updateStatus(epicId, 'done');
    }
    // else: leave the finalizer's terminal status — `gated`→in_progress,
    // PR-less success→finalizing+phase, `skipped`→unchanged. None are `done`.

    // Rolling: the integration worktree is plumbing. Tear it down once the
    // epic reaches a terminal-success status (the epic/<id> branch is
    // preserved). On 'gated'/'failed' the epic is NOT a terminal success, so
    // KEEP the worktree for a clean resume.
    if (this.rolling && (fin.status === 'merged' || fin.status === 'partial')) {
      this.integration.remove(epicId);
    }
  }

  // ─── Setup ─────────────────────────────────────────────────────────────────

  private selectEpics(epicIds?: string[]): { selected: string[]; skipped: string[]; recoverable: string[] } {
    const selected: string[] = [];
    const skipped: string[] = [];
    const recoverable: string[] = [];

    // 'in_progress' is runnable too — it is an epic a prior run started but did
    // not finish (a halt, a checkpoint, or a failure). That is what resume needs.
    const RUNNABLE = new Set(['approved', 'in_progress']);
    // FR-6: finalizing/publish_pending epics are stranded finalize-phase epics
    // that EpicFinalizer.resume() can complete. Route them to recoverable so run()
    // calls resume() rather than leaving them stuck and unhelpfully reporting them
    // as skipped.
    const RECOVERABLE_STATUSES = new Set(['finalizing', 'publish_pending']);
    const candidates = epicIds
      ? epicIds.map((id) => this.epics.get(id)).filter((e) => e !== undefined)
      : [
          ...this.epics.listByStatus('approved'),
          ...this.epics.listByStatus('in_progress'),
          ...this.epics.listByStatus('finalizing'),
          ...this.epics.listByStatus('publish_pending'),
        ];

    for (const epic of candidates) {
      if (RUNNABLE.has(epic!.status)) selected.push(epic!.id);
      else if (RECOVERABLE_STATUSES.has(epic!.status)) recoverable.push(epic!.id);
      else skipped.push(epic!.id);
    }
    // Explicitly-named epics that do not exist at all are reported as skipped.
    if (epicIds) {
      for (const id of epicIds) {
        if (!this.epics.get(id)) skipped.push(id);
      }
    }
    // Process epics in id order (epic-001, epic-002, ...) — dependencies flow
    // forward and checkpoint=epic should advance in sequence.
    selected.sort();
    recoverable.sort();
    return { selected, skipped, recoverable };
  }

  private loadStories(epicId: string): Story[] {
    const epic = this.epics.get(epicId);
    if (!epic?.yaml_path) {
      throw new Error(`Epic ${epicId} has no yaml_path recorded — cannot load stories.`);
    }
    const file = path.join(this.opts.projectRoot, epic.yaml_path);
    if (!fs.existsSync(file)) {
      throw new Error(`Epic ${epicId} YAML not found at ${file}.`);
    }
    const parsed = EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
    return parsed.stories;
  }

  /** Reuses a completed agent (resumability) or creates a fresh one. */
  private taskFor(epicId: string, story: Story): StoryTask {
    const existing = this.agents.getByStory(story.id);
    if (existing && SUCCESS.has(existing.status)) {
      return { epicId, story, agentId: existing.id, status: existing.status };
    }
    const agent = this.agents.create(epicId, story.id, story.title);
    return { epicId, story, agentId: agent.id, status: 'pending' };
  }

  // ─── Dispatch loop ─────────────────────────────────────────────────────────

  /** Returns true if the run halted early (a `loom stop` or a checkpoint). */
  private async dispatchLoop(
    tasks: Map<string, StoryTask>,
    selected: string[]
  ): Promise<boolean> {
    const inFlight = new Map<string, Promise<{ storyId: string; result: WorkerResult }>>();
    const checkpoint = this.opts.checkpoint;
    const cap = checkpoint === 'story' ? 1 : this.opts.maxConcurrent;

    const depDone = (depId: string): boolean => {
      const t = tasks.get(depId);
      if (t) return SUCCESS.has(t.status);
      const agent = this.agents.getByStory(depId);
      return agent ? SUCCESS.has(agent.status) : false;
    };
    const depFailed = (depId: string): boolean => {
      const t = tasks.get(depId);
      if (t) return FAILURE.has(t.status);
      const agent = this.agents.getByStory(depId);
      // A dependency that exists nowhere can never be satisfied → treat as failed.
      return agent ? FAILURE.has(agent.status) : true;
    };
    const isTerminal = (t: StoryTask): boolean =>
      SUCCESS.has(t.status) || FAILURE.has(t.status);

    // checkpoint='epic': work only the first unfinished epic, then stop before the next.
    const firstActiveEpic =
      checkpoint === 'epic'
        ? selected.find((eid) =>
            [...tasks.values()].some((t) => t.epicId === eid && !isTerminal(t))
          )
        : undefined;

    let completedThisRun = 0;
    let stopped = false;
    const limiter = this.opts.globalLimiter;
    const heldSlots = new Map<string, LimiterSlot>();
    // Stories whose requires have already been audit-logged as unmet this run.
    // Hoisted outside the tick loop so a story that stays unmet across multiple
    // ticks only produces one audit entry rather than one per tick.
    const requiresAuditedOnce = new Set<string>();

    for (;;) {
      // Keep held slots fresh so a long-running worker is not reclaimed.
      if (limiter && heldSlots.size > 0) {
        limiter.heartbeat([...heldSlots.values()]);
      }
      // Keep our per-epic dispatch leases fresh so a sibling supervisor does
      // not reclaim them as stale while a long story is in flight.
      for (const epicId of this.leasedEpics) this.lease.heartbeat(epicId);

      // Block any pending story whose dependency has failed.
      for (const task of tasks.values()) {
        if (task.status === 'pending' && task.story.dependencies.some(depFailed)) {
          this.transition(task, 'blocked', 'a dependency failed or is unreachable');
        }
      }

      // Decide whether to stop dispatching new stories.
      const stopRequested = this.control.getState() === 'stopping';
      if (stopRequested) stopped = true;
      const storyCheckpointHit = checkpoint === 'story' && completedThisRun >= 1;
      const haltDispatch = stopRequested || storyCheckpointHit || stopped;

      // Fill the worker pool with ready stories — each gated by the local cap
      // and, when configured, a machine-level concurrency slot.
      let globalBlocked = false;
      // Stories whose requires are unmet this tick are soft-skipped (status
      // stays 'pending') so they can be re-evaluated after an in-flight
      // upstream story completes and writes its provides_output. If the run
      // ends with nothing in-flight and the upstream can never satisfy the
      // requires (e.g. upstream completed without provides_output), the
      // post-loop sweep transitions them to 'blocked'.
      const requiresSkipped = new Set<string>();
      while (!haltDispatch && inFlight.size < cap) {
        const ready = [...tasks.values()].find(
          (t) =>
            t.status === 'pending' &&
            !requiresSkipped.has(t.story.id) &&
            t.story.dependencies.every(depDone) &&
            (firstActiveEpic === undefined || t.epicId === firstActiveEpic)
        );
        if (!ready) break;

        // Check typed requires before acquiring a slot or spawning a worker.
        // Soft-skip (stay pending) when unmet so an in-flight upstream story
        // can still satisfy the requires before the run ends. audit_log the
        // unmet keys for observability; the post-loop sweep handles the final
        // status transition if the run ends without satisfying them.
        let gateMap: Map<string, Record<string, unknown>> | undefined;
        if (ready.story.requires && Object.keys(ready.story.requires).length > 0) {
          gateMap = this.buildProvidesMapForStory(ready.story);
          const check = checkRequires(ready.story, gateMap);
          if (!check.ok) {
            requiresSkipped.add(ready.story.id);
            // Audit once per run, not once per tick — upstream satisfying the
            // requires on a later tick would otherwise cause duplicate entries.
            if (!requiresAuditedOnce.has(ready.story.id)) {
              requiresAuditedOnce.add(ready.story.id);
              this.audit.record({
                agent_id: ready.agentId,
                action: 'requires_unmet',
                command: ready.story.id,
                allowed: false,
                detail: { unmet: check.unmet },
              });
            }
            continue;
          }
        }

        if (limiter) {
          const slot = limiter.acquire(
            `${path.basename(this.opts.projectRoot)}:${ready.story.id}`
          );
          if (!slot) {
            // The machine is at its global worker cap — wait for a slot.
            globalBlocked = true;
            break;
          }
          heldSlots.set(ready.story.id, slot);
        }
        inFlight.set(ready.story.id, this.dispatch(ready, gateMap));
      }

      if (inFlight.size === 0) {
        // Idle but blocked only by the global cap: another run holds the
        // slots and will free one — wait and retry rather than ending here.
        if (globalBlocked) {
          await delay(this.opts.globalPollMs ?? GLOBAL_POLL_MS);
          continue;
        }
        break;
      }

      const { storyId, result } = await Promise.race(inFlight.values());
      inFlight.delete(storyId);
      const slot = heldSlots.get(storyId);
      if (limiter && slot) {
        limiter.release(slot);
        heldSlots.delete(storyId);
      }
      const task = tasks.get(storyId)!;
      this.applyResult(task, result);
      // Reroute sweep (epic-095-005): if applyResult queued a reroute, handle it
      // before rolling integration or checkpoint checks. `continue` skips
      // completedThisRun++ so a rerouted story does not count as a completed unit.
      if (this.pendingReroutes.has(storyId)) {
        const pending = this.pendingReroutes.get(storyId)!;
        this.pendingReroutes.delete(storyId);
        try {
          await this.doReroute(task, pending, tasks);
        } catch (err) {
          // Graceful failure: a single un-splittable story (budget exhausted,
          // invalid PM sub-graph, or internal error) fails ALONE. Never rethrow
          // out of the dispatch loop — that would abort the whole run and orphan
          // in-flight workers (their inFlight promises abandoned, slots/worktrees
          // leaked). doReroute already set task.status='failed'; the DB row is
          // 'failed' from applyResult. Record and move on.
          this.audit.record({
            action:  'reroute_failed',
            command: storyId,
            allowed: false,
            detail: {
              epicId: task.epicId,
              reason: err instanceof RerouteBudgetExhaustedError ? 'budget_exhausted'
                    : err instanceof RerouteValidationError ? 'invalid_sub_graph'
                    : 'internal_error',
              error:  err instanceof Error ? err.message : String(err),
            },
          });
        }
        continue;
      }
      // Rolling integration: fold a just-succeeded story into the live epic
      // branch NOW, so the next worker dispatched branches from a tip that
      // includes it. A distinct step (not inside applyResult) so the worker-
      // outcome bookkeeping stays clean and a merge conflict can downgrade the
      // story to 'blocked' with its own event. Naturally serialized — one
      // completion is processed per loop turn.
      if (this.rolling && SUCCESS.has(task.status)) {
        await this.integrateStory(task, result);
      }
      // Seam 2: checkpoint-autonomy pause. After each successful story, if the
      // epic is in checkpoint mode and more stories remain, pause so the
      // operator can review before continuing. resumeEpic() clears the pause
      // and the next supervisor.run() dispatches remaining stories.
      if (SUCCESS.has(task.status) && this.epics.getAutonomy(task.epicId) === 'checkpoint') {
        const anyPending = [...tasks.values()].some(
          (t) => t.epicId === task.epicId && t.status === 'pending'
        );
        if (anyPending) {
          this.epics.pauseAfterStory(task.epicId, task.story.id);
          stopped = true;
        }
      }
      completedThisRun++;
    }

    const pendingRemain = [...tasks.values()].some((t) => t.status === 'pending');
    const halted = stopped || (checkpoint !== undefined && pendingRemain);

    // Pending stories: a halt leaves them for a later run (resumable); otherwise
    // they could not be ordered (e.g. an unreachable dependency) → blocked.
    for (const task of tasks.values()) {
      if (task.status === 'pending' || task.status === 'running') {
        if (!halted) {
          this.transition(task, 'blocked', 'could not be scheduled');
        }
      }
    }
    return halted;
  }

  /**
   * Resolves any agent left in the transient 'integrating' status by a prior
   * run that crashed mid-merge-back. `integrateStory` sets 'integrating' BEFORE
   * it attempts the merge and restores the prior terminal status AFTER; a
   * crash in that window leaves the row stuck.
   *
   * The row is reconciled against the live git state of `epic/<id>`:
   *  - If `story/<id>` is an ancestor of the integration branch, the merge
   *    completed — restore the agent to its terminal status. We can't know
   *    whether the worker had opened a PR; infer `pr_open` from `pr_url` and
   *    fall back to `done`. This is the (most important) duplicate-dispatch
   *    fix: post-merge crashes used to silently re-dispatch.
   *  - Otherwise the merge did not complete. Mark the agent 'blocked' so the
   *    operator notices in `loom_get_status` and runs `loom_retry_story`
   *    (resume retry preserves the story branch + feeds the handoff back).
   *
   * Honest caveat: a plain `loom run` after this reconcile WILL still create
   * a fresh agent for the blocked row (`taskFor` treats every non-SUCCESS
   * status as "retry from scratch") and the worker's prior handoff was
   * already cleared by `refreshHandoff` when applyResult ran. So `loom run`
   * alone re-dispatches without prior-work context; `loom_retry_story` is
   * the clean recovery. The audit row `integrating_reconciled` flags this
   * so it isn't silent.
   *
   * Idempotent: a non-rolling run, no live integration branch, or no
   * 'integrating' rows is a no-op.
   */
  private reconcileIntegratingAgents(epicId: string): void {
    const candidates = this.agents
      .listByEpic(epicId)
      .filter((a) => a.status === 'integrating');
    if (candidates.length === 0) return;
    for (const agent of candidates) {
      // Only reconcile the latest attempt per story_id (a historical
      // 'integrating' row from before a successful retry must NOT be flipped).
      const latest = this.agents.getByStory(agent.story_id);
      if (!latest || latest.id !== agent.id) continue;
      const merged = this.integration.isStoryMerged(epicId, agent.story_id);
      if (merged) {
        // pr_url present = the worker had transitioned to pr_open before the
        // integrate step; absent = 'done' is the right restored status.
        const restored: AgentStatus = agent.pr_url ? 'pr_open' : 'done';
        this.agents.updateStatus(agent.id, restored);
        this.audit.record({
          agent_id: agent.id,
          action: 'integrating_reconciled',
          command: agent.story_id,
          allowed: true,
          detail: { resolved: 'merged', restored, epicId },
        });
      } else {
        this.agents.updateStatus(agent.id, 'blocked');
        this.audit.record({
          agent_id: agent.id,
          action: 'integrating_reconciled',
          command: agent.story_id,
          allowed: false,
          detail: {
            resolved: 'blocked',
            epicId,
            reason:
              'crashed during rolling integration before the merge completed; ' +
              'use loom_retry_story (resume retry) to preserve the story branch ' +
              'and re-attempt the merge-back. A plain `loom run` will re-dispatch ' +
              "without the prior worker's handoff.",
          },
        });
      }
    }
  }

  /**
   * Rolling mode: create `epic/<id>` + its integration worktree up front so the
   * first worker can branch from the tip. Captures base_sha (the main checkout
   * HEAD) if the epic doesn't have one yet. Returns false — leaving the epic
   * in_progress for a retry — if git setup fails, so the run never half-creates
   * an epic that workers then branch from incorrectly.
   */
  private ensureIntegrationBranch(epicId: string): boolean {
    const epic = this.epics.get(epicId);
    let baseSha = epic?.base_sha ?? undefined;
    if (!baseSha) {
      const head = gitSafe(this.opts.projectRoot, ['rev-parse', 'HEAD']);
      if (!head.ok) {
        this.audit.record({
          action: 'epic_integration_branch_error',
          command: epicId,
          allowed: false,
          detail: { error: `cannot resolve HEAD: ${head.output}` },
        });
        return false;
      }
      baseSha = head.output;
      this.epics.updateBaseSha(epicId, baseSha);
    }
    try {
      const info = this.integration.ensure(epicId, baseSha);
      this.audit.record({
        action: 'epic_integration_branch_created',
        command: epicId,
        allowed: true,
        detail: { branch: info.branch, path: info.path, base: baseSha },
      });
      return true;
    } catch (err) {
      this.epics.updateStatus(
        epicId,
        'in_progress',
        `integration branch setup failed: ${(err as Error).message}`.slice(0, 500)
      );
      this.audit.record({
        action: 'epic_integration_branch_error',
        command: epicId,
        allowed: false,
        detail: { error: (err as Error).message },
      });
      return false;
    }
  }

  /**
   * Rolling mode: fold a just-succeeded story's branch into the live epic
   * branch, then emit the story's single `completed` event with its FINAL
   * status (applyResult deferred it for us). On a clean merge the story is
   * integrated (status `done`/`pr_open`) and later workers see it. On a
   * conflict the bounded integrator (PR 3b) gets a chance to auto-resolve it
   * when enabled; if it can't (or it's off), the merge is aborted (work stays
   * on `story/<id>`), the story is downgraded to `blocked` — which cascades to
   * its dependents via the FAILURE set — its skill-usage outcome is corrected
   * from the optimistic `done` applyResult stamped, and a handoff is written for
   * a resume. The epic then finishes partial rather than silently dropping the
   * story at finalize.
   */
  private async integrateStory(task: StoryTask, result: WorkerResult): Promise<void> {
    // Mark the agent 'integrating' so `loom_get_status` distinguishes "worker
    // done, merge-back in flight" from "truly done." The status is restored
    // to the prior terminal value (done/pr_open) on a successful integration,
    // or transitioned to 'blocked' on hard failure below. Captures the prior
    // status to restore after — applyResult already stamped it to done/pr_open.
    const priorStatus = task.status;
    this.agents.updateStatus(task.agentId, 'integrating');
    // When the integrator is on, leave a conflicted merge in place so the
    // bounded recovery agent can work on it; otherwise abort immediately (3a).
    const outcome = this.integration.mergeStory(task.epicId, task.story.id, task.story.title, {
      leaveConflict: this.integratorEnabled,
    });
    if (outcome.ok) {
      // Restore the worker's terminal status now that integration is complete.
      this.agents.updateStatus(task.agentId, priorStatus);
      this.audit.record({
        agent_id: task.agentId,
        action: 'epic_rolling_merge',
        command: task.story.id,
        allowed: true,
        detail: { epicId: task.epicId, alreadyMerged: outcome.alreadyMerged },
      });
      // Now integrated and visible to dependents — emit its context note.
      this.writeContextNote(task, result.summary);
      this.appendBuildupEntry(task, result.summary, new Date().toISOString(), result.logTail);
      this.opts.onWorkerEvent?.({
        type: 'completed',
        storyId: task.story.id,
        status: task.status,
        summary: result.summary,
        commitCount: result.commitCount,
        ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      });
      return;
    }

    // Bounded auto-recovery (PR 3b). On success the story is integrated for
    // real — emit its `completed` event as done and return. The merge is left
    // in place for the recovery agent; attemptIntegratorRecovery aborts it on
    // failure so the loud-block path below starts from a clean worktree.
    if (this.integratorEnabled) {
      const recovered = await this.attemptIntegratorRecovery(task, outcome.conflictedFiles);
      if (recovered) {
        // Restore the worker's terminal status after a successful integrator
        // resolution — the transient 'integrating' marker has done its job.
        this.agents.updateStatus(task.agentId, priorStatus);
        this.writeContextNote(task, result.summary);
        this.appendBuildupEntry(task, result.summary, new Date().toISOString(), result.logTail);
        this.opts.onWorkerEvent?.({
          type: 'completed',
          storyId: task.story.id,
          status: task.status,
          summary: `${result.summary} (integrator resolved a merge conflict into ${task.epicId})`,
          commitCount: result.commitCount,
          ...(result.prUrl ? { prUrl: result.prUrl } : {}),
        });
        return;
      }
      this.integration.abortMerge(task.epicId);
    }
    this.audit.record({
      agent_id: task.agentId,
      action: 'epic_rolling_merge_conflict',
      command: task.story.id,
      allowed: false,
      detail: { epicId: task.epicId, output: outcome.output },
    });
    this.transition(task, 'blocked', 'rolling integration merge conflict');
    // The worker succeeded, so applyResult stamped skill_usage rows 'done' and
    // transition()'s `WHERE outcome IS NULL` update no-ops — force the blocked
    // outcome so anti-degradation stats reflect reality.
    this.skillUsage.overrideOutcome(task.agentId, 'blocked');
    this.writeHandoffDoc(task, 'blocked', result.summary, result.logTail);
    this.opts.onWorkerEvent?.({
      type: 'completed',
      storyId: task.story.id,
      status: 'blocked',
      summary: `done, but blocked integrating into ${task.epicId}: merge conflict — work kept on story/${task.story.id}`,
      commitCount: result.commitCount,
    });
  }

  /**
   * Bounded integrator (PR 3b). The story's merge into `epic/<id>` is paused
   * mid-conflict in the integration worktree. Up to `integratorMaxAttempts`
   * times: run the resolver agent, reject if it left conflict markers, commit
   * the merge, then re-run the FULL integration gate (build/tests) on the
   * integrated tree. Only a green gate counts as resolved — that is the whole
   * point, the result is known-good before later workers branch from it. A red
   * gate (or a marker-leaving / failed agent) rolls the merge back to the epic
   * tip and feeds the reason into the next attempt's prompt (block-and-revise).
   * Returns true iff the story is now cleanly integrated; the caller blocks on
   * false. Never silently drops work.
   */
  private async attemptIntegratorRecovery(
    task: StoryTask,
    initialConflictedFiles: string[]
  ): Promise<boolean> {
    const resolveConflicts = this.opts.worker.resolveConflicts;
    if (!resolveConflicts || !this.integratorGate) return false;
    // Late-bound policy refresh for the integrator's gate. The EpicFinalizer
    // rebinds its own copy at finalize entry; we mirror that here so a
    // mid-run `test_command` edit (the postmortem scenario where the operator
    // hardens the auto-detected over-broad command) actually changes which
    // command the bounded integrator re-runs to validate its resolution.
    this.rebindIntegratorGateIfChanged(task);

    const epicId = task.epicId;
    const storyId = task.story.id;
    const wtPath = this.integration.path(epicId);
    // The epic tip BEFORE this merge — where we roll back to on a red gate.
    const tipBefore = this.integration.tip(epicId);
    if (!tipBefore) return false;

    let conflicted = initialConflictedFiles;
    let previousFailure: string | undefined;

    for (let attempt = 1; attempt <= this.integratorMaxAttempts; attempt++) {
      // Attempt 1 uses the merge already left in place by integrateStory.
      // Later attempts re-create it (the prior attempt reset the worktree).
      if (attempt > 1) {
        const m = this.integration.mergeStory(epicId, storyId, task.story.title, {
          leaveConflict: true,
        });
        if (m.ok) return true; // became a clean merge (e.g. tip advanced) — done
        if (!m.conflict) return false;
        conflicted = m.conflictedFiles;
      }

      const res = await resolveConflicts.call(this.opts.worker, {
        cwd: wtPath,
        epicId,
        storyId,
        storyTitle: task.story.title,
        conflictedFiles: conflicted,
        previousFailure,
        onOutput: (chunk, stream) =>
          this.opts.onWorkerEvent?.({ type: 'output', storyId, stream, chunk }),
        onPid: (pid) => {
          this.agents.updateWorkerPid(task.agentId, pid);
          if (pid != null) this.childPids.add(pid);
        },
      });

      // Resolution outcomes split into two shapes:
      //  - the merge is still IN PROGRESS (agent timed out / died / left markers
      //    / commit failed) → abort it to get back to a clean tip; or
      //  - the merge was COMMITTED but the gate is red → reset off the bad
      //    commit. Each path records exactly one epic_integration_attempt.
      let rejected: string;
      if (res.timedOut) {
        rejected = 'the resolver agent timed out before finishing.';
      } else if (!res.ok) {
        rejected = 'the resolver agent exited abnormally.';
      } else if (this.integration.hasConflictMarkers(epicId, conflicted)) {
        rejected = 'conflict markers were left unresolved in one or more files.';
      } else {
        const committed = this.integration.commitResolved(
          epicId,
          `Merge ${storyId}: ${task.story.title} (integrator-resolved)`
        );
        if (!committed.ok) {
          rejected = `staging/committing the resolved merge failed: ${committed.output}`;
        } else {
          startPhase('gate');
          const gate = await this.integratorGate.run({ projectRoot: wtPath });
          endPhase('gate');
          if (gate.ok) {
            this.recordIntegratorAttempt(task, {
              epicId,
              attempt,
              allowed: true,
              ran: gate.ran,
              summary: gate.summary,
            });
            this.audit.record({
              agent_id: task.agentId,
              action: 'epic_integration_resolved',
              command: storyId,
              allowed: true,
              detail: { epicId, attempts: attempt },
            });
            return true;
          }
          // Merge is committed (no MERGE_HEAD) — roll it off the branch here,
          // then record. The in-progress-merge cleanup below is for the other
          // paths only, so skip it.
          this.integration.reset(epicId, tipBefore);
          this.recordIntegratorAttempt(task, {
            epicId,
            attempt,
            allowed: false,
            rejected: `the integrated build/tests failed: ${gate.summary}`,
          });
          // Deterministic failure router (story-001-004): grade the red gate and
          // route. `strong` feeds the investigator's hint into the next attempt
          // (bounded by integratorMaxAttempts — no new ceiling); `weak` /
          // `contradictory` stop retrying and fall through to the loud-block
          // path. Each routing decision writes its own distinguishable audit row.
          const decision = await investigateAndRoute(
            {
              failing_test_or_gate: this.effectiveIntegratorTestCommand ?? 'integration-gate',
              stderr_tail: gate.summary,
              diff: '',
              story_id: storyId,
            },
            { db: this.opts.db, epic_id: epicId, agent_id: task.agentId }
          );
          if (decision.kind === 'retry-with-hint') {
            previousFailure = decision.hint;
            continue;
          }
          return false;
        }
      }

      // In-progress-merge failure: abort it so the next attempt (or the
      // loud-block fallback) starts from a clean tip, then record + retry.
      this.integration.abortMerge(epicId);
      this.recordIntegratorAttempt(task, { epicId, attempt, allowed: false, rejected });
      previousFailure = rejected;
    }
    return false;
  }

  /**
   * Re-reads `policy.agents.test_command` from disk (via `refreshIntegratorPolicy`)
   * and rebuilds `this.integratorGate` when the value changes. Idempotent —
   * a no-op when no refresher is wired, when the call throws, or when the
   * live value matches the effective one. Records `integrator_gate_rebound`
   * so operators see exactly which mid-run edit took effect, and at which
   * story.
   */
  private rebindIntegratorGateIfChanged(task: StoryTask): void {
    if (!this.opts.refreshIntegratorPolicy) return;
    let live: { testCommand?: string };
    try {
      live = this.opts.refreshIntegratorPolicy();
    } catch {
      return;
    }
    // Strict equality on testCommand: same → no rebind. Clearing the policy
    // value (defined → undefined) DOES rebind and falls back to auto-detect
    // (an intentional operator action). Wiring contract: the caller must let
    // a `PolicyEngine.load` failure THROW rather than return `{}`; the
    // try/catch above turns a transient load failure into a no-op (preserve
    // the current command) instead of silently clearing it.
    if (live.testCommand === this.effectiveIntegratorTestCommand) return;
    const from = this.effectiveIntegratorTestCommand;
    const to = live.testCommand;
    this.effectiveIntegratorTestCommand = to;
    this.integratorGate = new IntegrationGate({
      testCommand: to,
      timeoutMs: this.opts.integrationGateTimeoutMs ?? 15 * 60_000,
    });
    this.audit.record({
      agent_id: task.agentId,
      action: 'integrator_gate_rebound',
      command: task.story.id,
      allowed: true,
      detail: {
        epicId: task.epicId,
        test_command: { from: from ?? null, to: to ?? null },
      },
    });
  }

  /** Single writer for the per-attempt integrator audit row (one per attempt). */
  private recordIntegratorAttempt(
    task: StoryTask,
    detail: {
      epicId: string;
      attempt: number;
      allowed: boolean;
      ran?: boolean;
      summary?: string;
      rejected?: string;
    }
  ): void {
    const { allowed, ...rest } = detail;
    this.audit.record({
      agent_id: task.agentId,
      action: 'epic_integration_attempt',
      command: task.story.id,
      allowed,
      detail: rest,
    });
  }

  /**
   * Lazily returns (and caches) the WorktreeManager for a given repo slug,
   * creating a new one rooted at `root` on the first call. Subsequent calls
   * with the same slug return the cached instance so worktrees in the same
   * repo share a single manager — exactly one manager per repo per run.
   *
   * Invariant: callers must guarantee that the same slug always maps to the
   * same root. A mismatch indicates that `resolveStoryRepo` returned
   * inconsistent roots for the same slug (e.g. before vs. after a
   * symlink-normalization fix), which would silently root later stories in
   * the wrong location. We detect and throw rather than silently ignoring.
   */
  private worktreeFor(slug: string, root: string): WorktreeManager {
    const existing = this.wtByRepo.get(slug);
    if (existing) {
      const registeredRoot = this.rootBySlug.get(slug);
      // wtByRepo and rootBySlug are always set atomically — if existing is
      // truthy, registeredRoot must be defined. Assert to catch any future
      // refactor that breaks this invariant rather than silently skipping the
      // mismatch check.
      if (registeredRoot === undefined) {
        throw new Error(
          `Supervisor invariant violated: slug "${slug}" present in wtByRepo but absent from rootBySlug`
        );
      }
      if (registeredRoot !== root) {
        throw new Error(
          `Supervisor: slug "${slug}" was registered with root "${registeredRoot}" ` +
          `but now called with root "${root}" — slug↔root must be bijective.`
        );
      }
      return existing;
    }
    const mgr = new WorktreeManager(root);
    this.wtByRepo.set(slug, mgr);
    this.rootBySlug.set(slug, root);
    return mgr;
  }

  /**
   * Resolves (and caches) the manifest + primary slug used to map story.repo
   * fields to real filesystem roots. When `opts.manifest` is supplied by the
   * caller, uses that; otherwise builds a synthetic single-entry manifest from
   * `opts.projectRoot` so existing single-repo tests and CLI callers are
   * byte-identical to the pre-change behavior (NFR-2 regression obligation).
   */
  private manifestContext(): { manifest: WorkspaceManifest; primarySlug: string } {
    if (this._manifestCtx) return this._manifestCtx;

    if (this.opts.manifest) {
      const primarySlug =
        this.opts.primarySlug ?? resolvePrimaryRepo(this.opts.manifest);
      this._manifestCtx = { manifest: this.opts.manifest, primarySlug };
      return this._manifestCtx;
    }

    // Fallback: derive a single-entry manifest from projectRoot. This keeps
    // single-repo behavior unchanged — the WorktreeManager ends up rooted at
    // the same canonical path it always was.
    const realRoot = (() => {
      try { return fs.realpathSync(this.opts.projectRoot); }
      catch { return this.opts.projectRoot; }
    })();
    const fallbackManifest: WorkspaceManifest = {
      version: 1,
      repos: [{ slug: 'primary', path: realRoot, remote_url: null, primary: true }],
    };
    this._manifestCtx = { manifest: fallbackManifest, primarySlug: 'primary' };
    return this._manifestCtx;
  }

  /**
   * Resolves the worker-MCP context from policy at dispatch time: the
   * worker backend (`policy.agents.worker_backend`) and the approved-MCP
   * registry (`policy.mcp.registry`, resolved relative to projectRoot; null
   * when unset). Cached after first use. A policy-load failure falls back to
   * safe defaults — claude-code with an empty registry — so a malformed
   * policy can never crash dispatch.
   */
  private mcpContext(): {
    backend: 'claude-code' | 'cursor-cli';
    registry: McpRegistry | null;
  } {
    if (this.mcpCtx) return this.mcpCtx;
    let backend: 'claude-code' | 'cursor-cli' = 'claude-code';
    let registry: McpRegistry | null = null;
    try {
      const policy = PolicyEngine.load(
        path.join(this.opts.projectRoot, '.loom')
      ).policyData;
      backend = policy.agents.worker_backend;
      const regPath = policy.mcp.registry;
      if (regPath) {
        registry = new McpRegistry(path.resolve(this.opts.projectRoot, regPath));
      }
    } catch {
      // Safe defaults — never let a policy read crash dispatch.
    }
    this.mcpCtx = { backend, registry };
    return this.mcpCtx;
  }

  /**
   * Resolves the spawn stagger for this run (story-006-004), caching the result.
   * An injected `opts.spawnStagger` always wins (the test seam). Otherwise the
   * stagger only exists for the cursor-cli backend — that is the sole backend
   * with the `~/.cursor/cli-config.json` rename herd — and is built once with a
   * real clock + a process-seeded PRNG. Returns `null` for claude-code so its
   * spawns are never delayed (bench-baseline behaviour preserved).
   */
  private spawnStaggerFor(): SpawnStagger | null {
    if (this.spawnStagger !== undefined) return this.spawnStagger;
    if (this.opts.spawnStagger) {
      this.spawnStagger = this.opts.spawnStagger;
      return this.spawnStagger;
    }
    const { backend } = this.mcpContext();
    this.spawnStagger =
      backend === 'cursor-cli'
        ? new SpawnStagger({
            clock: new SystemRetryClock(),
            jitter: new Mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
          })
        : null;
    return this.spawnStagger;
  }

  private dispatch(
    task: StoryTask,
    gateProvides?: Map<string, Record<string, unknown>>
  ): Promise<{ storyId: string; result: WorkerResult }> {
    // Claim a spawn-stagger slot up front (story-006-004) so concurrent
    // dispatches space their cursor-agent spawns apart and clear the
    // `~/.cursor/cli-config.json` rename herd. The slot is claimed in dispatch
    // order (the loop calls dispatch synchronously) and awaited just before the
    // worker spawns below, so the worktree/MCP setup still proceeds eagerly. A
    // null stagger (claude-code, or no concurrency) means an already-resolved
    // slot — no delay.
    const staggerSlot = this.spawnStaggerFor()?.waitForSlot() ?? Promise.resolve();
    // Branch base. In rolling mode every worker branches from the LIVE
    // `epic/<id>` tip, which already contains every story merged so far —
    // so the worktree carries real integrated code, not just one dependency.
    // In the legacy (off) topology a dependent story branches from its first
    // dependency's branch so the worktree at least contains that work.
    const firstDep = task.story.dependencies[0];
    const fromBranch = this.rolling
      ? this.integration.branchName(task.epicId)
      : firstDep
        ? `story/${firstDep}`
        : undefined;
    // Resolve the story's target repo and create its worktree. Use the cached
    // result from the repoFilter pass when available to avoid a second resolution.
    const { manifest: mf, primarySlug: ps } = this.manifestContext();
    let repoSetupErr: unknown;
    const repoSetup = (() => {
      try {
        const { slug, root } = task.resolvedRepo ?? resolveStoryRepo(task.story, mf, ps);
        const mgr = this.worktreeFor(slug, root);
        const worktree = mgr.create(task.story.id, fromBranch ? { fromBranch } : {});
        return { repoSlug: slug, repoRoot: root, wt: worktree };
      } catch (e) {
        repoSetupErr = e;
        return null;
      }
    })();
    if (repoSetup === null) {
      // Repo resolution or worktree creation failed. Record an audit entry so
      // the story surfaces as failed in `loom status` rather than crashing the
      // entire run. Matches the observable outcome of the repoFilter catch path.
      this.audit.record({
        action: 'story_setup_failed',
        command: task.story.id,
        detail: {
          reason: 'repo_unresolvable',
          error: repoSetupErr instanceof Error ? repoSetupErr.message : String(repoSetupErr),
        },
      });
      return Promise.resolve({
        storyId: task.story.id,
        result: {
          status: 'failed' as const,
          commitCount: 0,
          summary: `Repo setup failed: ${repoSetupErr instanceof Error ? repoSetupErr.message : String(repoSetupErr)}`,
          logTail: '',
        },
      });
    }
    const { repoSlug, repoRoot, wt } = repoSetup;
    // Remember the branch point so a handoff/retry can scope to this worker's
    // own commits (`baseSha..HEAD`).
    this.storyBaseSha.set(task.story.id, wt.baseSha);

    // ─── Worker MCP isolation (epic-002, dispatch ordering steps 2–4) ──────
    // Materialize a worktree-local `.cursor/mcp.json` exposing EXACTLY the
    // policy.mcp.registry servers (whole-file overwrite, never a merge). The
    // cursor enforcer (step 3) disables any stray inherited servers headlessly;
    // it is a no-op for claude-code, which gets strict isolation from the
    // `--strict-mcp-config` spawn arg.
    const { backend, registry } = this.mcpContext();
    const mat = materializeWorktreeMcpConfig({
      worktreePath: wt.path,
      registry,
    });
    const enf =
      backend === 'cursor-cli'
        ? enforceCursorMcpAllowlist({
            worktreePath: wt.path,
            allowlist: mat.serverNames,
          })
        : undefined;
    this.audit.record({
      agent_id: task.agentId,
      action: 'worker_mcp_servers',
      command: task.story.id,
      detail: {
        servers: mat.serverNames,
        backend,
        configPath: path.relative(wt.path, mat.configPath),
        ...(enf ? { disabledServers: enf.disabled, gaps: enf.gaps } : {}),
      },
    });

    // ─── Per-worker read-scope settings (epic-067, story-067-003) ───────────
    // Writes a `.claude/settings.json` with a PreToolUse hook that routes
    // Read/Grep/Glob/Bash through `loom guard hook` so out-of-scope reads are
    // blocked at the OS level. Only materializes when loomScriptPath is provided
    // (omitted in tests that don't exercise the read-scope path).
    if (this.opts.loomScriptPath) {
      try {
        const loomDir = path.join(repoRoot, '.loom');
        let readRootRel = '.';
        try {
          readRootRel = PolicyEngine.load(loomDir).policyData?.filesystem?.allowed_read_root ?? '.';
        } catch {
          // Policy unreadable — default to repo root
        }
        let readRoot: string;
        try {
          readRoot = fs.realpathSync(path.resolve(repoRoot, readRootRel));
        } catch {
          readRoot = path.resolve(repoRoot, readRootRel);
        }
        materializeWorktreeReadScope({
          worktreePath: wt.path,
          readRoot,
          loomScriptPath: this.opts.loomScriptPath,
        });
      } catch (err) {
        // Never let settings materialization crash dispatch, but warn so operators
        // can detect that read-scope enforcement is absent for this worker.
        process.stderr.write(
          `[loom] warning: failed to materialize read-scope settings for ${wt.path}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // First story dispatched for an epic captures the epic's base SHA — the
    // EpicFinalizer needs it to build `epic/<id>` from a stable point. Root
    // stories (no dependency) branch from the project base, so their baseSha
    // IS the epic base; we never overwrite an already-set value. In rolling
    // mode base_sha was already captured when the integration branch was
    // created at epic start, so this never fires.
    if (!firstDep && !this.rolling) {
      const epic = this.epics.get(task.epicId);
      if (epic && !epic.base_sha) {
        this.epics.updateBaseSha(task.epicId, wt.baseSha);
      }
    }

    task.status = 'running';
    this.agents.updateStatus(task.agentId, 'running', {
      worktree_path: wt.path,
      branch_name: wt.branch,
      started_at: new Date().toISOString(),
    });
    // Seed agents.model with the requested model now; overwritten by the executed
    // model once the system/init stream event arrives (see applyResult).
    if (this.opts.workerModel) {
      this.agents.setModel(task.agentId, this.opts.workerModel);
    }
    this.audit.record({
      agent_id: task.agentId,
      action: 'dispatch',
      command: task.story.id,
      detail: { worktree: wt.path, branch: wt.branch },
    });

    this.opts.onWorkerEvent?.({
      type: 'dispatched',
      storyId: task.story.id,
      agentId: task.agentId,
      worktreePath: wt.path,
      branchName: wt.branch,
    });

    // Set the agentId→storyId mapping once, before the per-chunk closure, so
    // it is not redundantly re-set on every output chunk.
    this.agentToStory.set(task.agentId, task.story.id);

    // Whether this story declares provides — used to gate the LOOM_PROVIDES
    // streaming capture below so stories without provides pay zero overhead.
    const capturesProvides =
      task.story.provides !== undefined && Object.keys(task.story.provides).length > 0;
    // Line buffer for streaming LOOM_PROVIDES capture. Chunks may not align to
    // line boundaries, so we accumulate until a newline, then scan complete lines.
    // This avoids calling parseLoomProvides on the (possibly truncated) logTail.
    let loomProvidesLineBuffer = '';
    let capturedProvidesLineLocal: string | null = null;

    // ── LOOM_TOO_BIG streaming capture (injection point B setup, epic-095-005) ──
    // Scan ALL stories' stdout for LOOM_TOO_BIG_SIGNAL (not gated on `provides`).
    // Last occurrence wins; the fan-out payload is everything after the signal word.
    let tooBigLineBuffer = '';

    const onOutput = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      // Redaction runs ONCE here — before any persistence path (DB tail or file).
      const redacted = redactSecrets(chunk);
      this.opts.onWorkerEvent?.({
        type: 'output',
        storyId: task.story.id,
        stream,
        chunk: redacted,
      });
      this.appendToTail(task.agentId, redacted);
      // File append returns new cumulative byte length; store it so flushTails
      // can write agents.log_bytes. File write precedes the DB pointer (ordering
      // invariant: log_bytes <= file size always).
      this.logBytes.set(
        task.story.id,
        this.workerLogs.append(task.story.id, redacted)
      );
      // Scan stdout for LOOM_PROVIDES lines (only when story declares provides).
      // Accumulate in a line buffer so we handle chunks that straddle a newline.
      // Last occurrence wins — updated on every matching line.
      if (capturesProvides && stream === 'stdout') {
        loomProvidesLineBuffer += redacted;
        const newlineIdx = loomProvidesLineBuffer.lastIndexOf('\n');
        if (newlineIdx !== -1) {
          const completeSection = loomProvidesLineBuffer.slice(0, newlineIdx);
          loomProvidesLineBuffer = loomProvidesLineBuffer.slice(newlineIdx + 1);
          for (const rawLine of completeSection.split('\n')) {
            const trimmed = rawLine.trim();
            if (trimmed.startsWith('LOOM_PROVIDES ')) {
              capturedProvidesLineLocal = trimmed;
            }
          }
        }
      }
      // Scan ALL stdout for LOOM_TOO_BIG_SIGNAL (epic-095 story-095-005).
      if (stream === 'stdout') {
        tooBigLineBuffer += redacted;
        const nlIdx = tooBigLineBuffer.lastIndexOf('\n');
        if (nlIdx !== -1) {
          const section = tooBigLineBuffer.slice(0, nlIdx);
          tooBigLineBuffer = tooBigLineBuffer.slice(nlIdx + 1);
          for (const rawLine of section.split('\n')) {
            const payload = matchTooBigSignal(rawLine);
            if (payload !== undefined) {
              this.capturedTooBigSignals.set(task.story.id, payload);
            }
          }
        }
      }
    };

    // Persist the worker subprocess pid as soon as it spawns so an
    // out-of-process call (loom_stop_agent) can SIGTERM it directly.
    // Also track in `childPids` so the guidance pusher can verify this
    // Supervisor owns the worker before pushing (Winston review S1).
    const onPid = (pid: number | null): void => {
      this.agents.updateWorkerPid(task.agentId, pid);
      if (pid != null) {
        this.childPids.add(pid);
      }
      // On spawn-close (pid === null) we keep the entry until applyResult
      // sweeps it — guards against a late push racing with worker exit.
    };

    // Watchdog — only when policy enables it. Kills the worker if it
    // spends too long with zero Edit/Write/MultiEdit calls (the
    // analysis-only failure mode). Methodology-safe: doesn't alter
    // the worker prompt; only acts on an unambiguous failure signal.
    const watchdog =
      this.opts.watchdog?.enabled
        ? new WorkerWatchdog({
            agentId: task.agentId,
            storyId: task.story.id,
            agentStore: this.agents,
            audit: this.audit,
            warnSec: this.opts.watchdog.warnSec ?? 600,
            killSec: this.opts.watchdog.killSec ?? 1200,
          })
        : undefined;
    watchdog?.start();

    // Decision-trace capture — claude's thinking blocks land here as
    // they stream, recorded as first-class reasoning events alongside
    // the audit log. Best-effort; a DB write hiccup must not fail the run.
    const onTrace = (trace: { kind: string; subject?: string; rationale: string }): void => {
      try {
        watchdog?.onTrace(trace);
      } catch {
        // Watchdog updates must never break the worker — failure to
        // count an edit just means the watchdog's check is conservative.
      }
      try {
        this.decisionTraces.record({
          agent_id: task.agentId,
          epic_id: task.epicId,
          story_id: task.story.id,
          kind: trace.kind,
          subject: trace.subject,
          rationale: trace.rationale,
        });
      } catch {
        // Trace capture is best-effort; never fail a story over telemetry.
      }
    };

    // Capture the per-spawn input channel so the guidance watcher can
    // push operator messages into the live worker. Each spawn (initial
    // + every revision) overwrites the prior channel — only the latest
    // spawn is the one currently holding stdin open.
    const onChannel = (channel: WorkerInputChannel): void => {
      this.channelsByStory.set(task.story.id, channel);
    };

    // Near-deadline warning — the worker's timeout guard fires this once when
    // it is approaching its stall/cap deadline. Record it so an operator can
    // see "this story is about to be killed" in the audit log / dashboard.
    const onTimeoutWarn = (info: {
      reason: 'stall' | 'cap' | 'budget';
      elapsedMs: number;
      remainingMs: number;
    }): void => {
      try {
        this.audit.record({
          agent_id: task.agentId,
          action: 'worker_timeout_warn',
          command: task.story.id,
          detail: {
            reason: info.reason,
            elapsed_sec: Math.round(info.elapsedMs / 1000),
            remaining_sec: Math.round(info.remainingMs / 1000),
          },
        });
      } catch {
        // Audit is best-effort; never fail a story over telemetry.
      }
    };

    // Compute upstream provides section for injection into worker prompt.
    // Only when the story has `requires` entries — otherwise no-op to keep
    // the prompt byte-identical to the pre-feature baseline. Reuse the map
    // already computed by the dispatch gate (gateProvides) to avoid a second
    // round of DB reads. gateProvides is always defined here: the dispatch gate
    // sets it when story.requires has keys, and this guard fires only then.
    let upstreamProvidesSection: string | undefined;
    if (task.story.requires && Object.keys(task.story.requires).length > 0) {
      const providesMap = gateProvides!;
      const block = buildProvidesBlock(task.story, providesMap);
      if (block) upstreamProvidesSection = block;
    }

    const assignment: WorkerAssignment = {
      storyId: task.story.id,
      epicId: task.epicId,
      story: task.story,
      worktreePath: wt.path,
      branchName: wt.branch,
      baseSha: wt.baseSha,
      projectRoot: repoRoot,
      integrationBranch: this.opts.integrationBranch ?? 'off',
      hasDependents: this.storiesWithDependents.has(task.story.id),
      skills: this.selectSkills(task.story, task.agentId),
      worktreeContext: { repoSlug, worktreePath: wt.path },
      ...(upstreamProvidesSection !== undefined ? { upstreamProvidesSection } : {}),
      onOutput,
      onPid,
      onTrace,
      onChannel,
      onTimeoutWarn,
      onPhaseBoundary: (info) => this.onPhaseBoundary(task, info.phase, info.summary),
    };

    // Await the spawn-stagger slot claimed at the top of dispatch — this is the
    // jittered 1–2s delay that spaces concurrent cursor-agent spawns apart
    // (story-006-004). All bookkeeping above ran eagerly; only the spawn waits.
    startPhase('dispatch');
    return staggerSlot
      .then(() => this.maybeAssembleContext(task))
      .then(() => {
        endPhase('dispatch');
        startPhase('worker');
        try { activeCollector()?.markFirstToken(); } catch { /* timing is observability */ }
        return this.opts.worker.run(assignment);
      })
      .then((result) => {
        // Flush any remaining incomplete line from the LOOM_PROVIDES buffer.
        // This handles output that ends without a trailing newline.
        if (capturesProvides && loomProvidesLineBuffer.trim().startsWith('LOOM_PROVIDES ')) {
          capturedProvidesLineLocal = loomProvidesLineBuffer.trim();
        }
        // Persist captured LOOM_PROVIDES line for applyResult to consume.
        // Using the full streaming capture avoids logTail truncation.
        if (capturesProvides) {
          this.capturedProvidesLines.set(task.story.id, capturedProvidesLineLocal);
        }
        // Flush any incomplete LOOM_TOO_BIG line from the buffer (epic-095-005).
        const pendingPayload = matchTooBigSignal(tooBigLineBuffer);
        if (pendingPayload !== undefined) {
          this.capturedTooBigSignals.set(task.story.id, pendingPayload);
        }
        return { storyId: task.story.id, result };
      })
      .catch((err: unknown) => ({
        storyId: task.story.id,
        result: {
          status: 'failed' as const,
          commitCount: 0,
          summary: `Worker threw: ${(err as Error).message}`,
          logTail: '',
        },
      }))
      .finally(() => {
        endPhase('worker');
        watchdog?.stop();
      });
  }

  /**
   * Distill the worker's planning context once at dispatch (policy.agents.
   * distill_context='on'). Best-effort: any failure — missing artifacts, a
   * dropped acceptance criterion, a write error — is swallowed so a distillation
   * problem never blocks the worker spawn. When the flag is off this is a no-op
   * and the dispatch path stays byte-identical to the bench baseline.
   */
  private async maybeAssembleContext(task: StoryTask): Promise<void> {
    if (this.opts.distillWorkerContext !== 'on') return;
    try {
      const artifacts = this.readPlanningArtifacts(task);
      // Nothing to distill when every artifact came back empty.
      if (Object.values(artifacts).every((a) => a.trim().length === 0)) return;
      await assembleWorkerContext(task.story.id, artifacts, {
        db: this.opts.db,
        agent_id: task.agentId,
        epic_id: task.epicId,
      });
    } catch {
      // Best-effort: a distillation error never blocks the worker spawn.
    }
  }

  /** Read the four planning artifacts for a story (best-effort; missing = ''). */
  private readPlanningArtifacts(task: StoryTask): PlanningArtifacts {
    const planDir = path.join(
      this.opts.projectRoot,
      '.loom',
      'planning',
      task.epicId,
    );
    const read = (file: string): string => {
      try {
        return fs.readFileSync(path.join(planDir, file), 'utf8');
      } catch {
        return '';
      }
    };
    return {
      prd: read('prd.md'),
      epic: read('epic.md') || (this.epics.get(task.epicId)?.title ?? ''),
      architecture: read('architecture.md'),
      story: this.renderStoryArtifact(task.story),
    };
  }

  /** Render a story as the markdown artifact the distiller consumes. */
  private renderStoryArtifact(story: Story): string {
    const lines: string[] = [
      `# Story ${story.id} — ${story.title}`,
      '',
      story.description,
      '',
      '## Acceptance criteria',
      ...story.acceptance_criteria.map((ac) => `- [ ] ${ac}`),
    ];
    if (story.tech_notes && story.tech_notes.trim().length > 0) {
      lines.push('', '## Technical guidance', story.tech_notes);
    }
    return lines.join('\n');
  }

  // ─── Story handoff (crash-resilient resume) ────────────────────────────────
  //
  // Assembles `.loom/handoff/<story-id>.md` from already-persisted state —
  // git log on the branch + the decision-trace timeline + the audit log +
  // the log tail. All of these survive a hard SIGKILL, so the handoff is
  // available even when the worker crashed rather than exiting cleanly.
  // 'telemetry' mode costs zero extra tokens; 'summarized' (an LLM compaction
  // pass) is a planned opt-in and currently renders the same telemetry doc.
  private refreshHandoff(task: StoryTask, result: WorkerResult, status: AgentStatus): void {
    const mode = this.opts.handoffMode ?? 'telemetry';
    if (mode === 'off') return;
    // Invariant: a handoff file existing means "this story has unfinished work
    // to resume". On success, clear any stale handoff from a prior failed
    // attempt so the next dispatch of this id doesn't wrongly inject it.
    if (SUCCESS.has(status)) {
      try {
        fs.rmSync(StoryHandoff.pathFor(this.opts.projectRoot, task.story.id), { force: true });
      } catch {
        // best-effort
      }
      return;
    }
    // Only resume-relevant outcomes need a handoff.
    if (!FAILURE.has(status)) return;
    this.writeHandoffDoc(task, status, result.summary, result.logTail);
  }

  /**
   * Mid-run handoff refresh fired at a phase boundary (PHASES=
   * 'on'). The worker has just checkpoint-committed one phase's work; persisting
   * the handoff now means a crash before the next phase finishes still resumes
   * from the committed work. Status is 'running' (the story is in flight) which
   * leaves the file in place — it is cleared only when the story succeeds.
   */
  private onPhaseBoundary(task: StoryTask, phase: string, summary: string): void {
    const mode = this.opts.handoffMode ?? 'telemetry';
    if (mode === 'off') return;
    this.writeHandoffDoc(task, 'running', `Phase '${phase}' complete. ${summary}`, '');
  }

  /**
   * Renders and writes `.loom/handoff/<story-id>.md` from durable state for the
   * given story. Shared by the terminal-failure path (refreshHandoff) and the
   * mid-run phase-boundary path. Best-effort: never throws into the caller.
   */
  private writeHandoffDoc(
    task: StoryTask,
    status: AgentStatus,
    summary: string,
    logTail: string
  ): void {
    const mode = this.opts.handoffMode ?? 'telemetry';
    try {
      const state = this.gatherStoryBranchState(task);
      if (!state) return;

      const content = StoryHandoff.render({
        storyId: task.story.id,
        epicId: task.epicId,
        title: task.story.title,
        description: task.story.description,
        branchName: state.branchName,
        worktreePath: state.worktreePath,
        status,
        summary,
        acceptanceCriteria: task.story.acceptance_criteria,
        commits: state.commits,
        diffStat: state.diffStat,
        dirty: state.dirty,
        traces: this.decisionTraces.getByStory(task.story.id),
        audit: this.audit.getByAgent(task.agentId),
        logTail,
      });
      const file = StoryHandoff.write(this.opts.projectRoot, task.story.id, content);
      this.audit.record({
        agent_id: task.agentId,
        action: 'handoff_written',
        command: task.story.id,
        detail: { path: file, mode, commits: state.commits.length, status },
      });
    } catch {
      // Handoff is best-effort telemetry; never fail a story over it.
    }
  }

  /**
   * Writes `.loom/context/<story-id>.md` — a "what I built" note for dependent
   * stories — when a story succeeds and context_notes is on. The OPPOSITE
   * semantic to the handoff (success enrichment, not a resume signal), so it
   * uses a separate path and never touches the handoff invariant. Best-effort.
   */
  private writeContextNote(task: StoryTask, summary: string): void {
    if (this.opts.contextNotes !== 'on') return;
    try {
      const state = this.gatherStoryBranchState(task);
      if (!state) return;
      const content = StoryContext.render({
        storyId: task.story.id,
        epicId: task.epicId,
        title: task.story.title,
        summary,
        branchName: state.branchName,
        commits: state.commits,
        diffStat: state.diffStat,
        traces: this.decisionTraces.getByStory(task.story.id),
      });
      const file = StoryContext.write(this.opts.projectRoot, task.story.id, content);
      this.audit.record({
        agent_id: task.agentId,
        action: 'context_note_written',
        command: task.story.id,
        detail: { path: file, commits: state.commits.length },
      });
    } catch {
      // Context notes are best-effort enrichment; never fail a story over them.
    }
  }

  /**
   * Appends a build-up entry for a successful story to the epic-cumulative doc
   * at .loom/buildup/<epic-id>.json. Gated on epicBuildup='on'. Best-effort:
   * never throws into the caller. Records a buildup_appended audit row (Invariant 5)
   * only when something was actually written (entry added or conventions appended).
   * No extra model calls — entry body is built from durable telemetry via
   * gatherStoryBranchState + StoryContext.render (NFR-1).
   */
  private appendBuildupEntry(
    task: StoryTask,
    summary: string,
    completedAt: string,
    logTail: string
  ): void {
    if (this.opts.epicBuildup !== 'on') return;

    // Build entry body from durable telemetry — no model call.
    const state = this.gatherStoryBranchState(task);
    let body = '';
    try {
      body = StoryContext.render({
        storyId: task.story.id,
        epicId: task.epicId,
        title: task.story.title,
        summary,
        branchName: state?.branchName ?? `story/${task.story.id}`,
        commits: state?.commits ?? [],
        diffStat: state?.diffStat,
        traces: this.decisionTraces.getByStory(task.story.id),
        generatedAt: completedAt,
      });
    } catch { /* best-effort render */ }

    // Parse conventions from worker output (never throws).
    const parsedConventions = parseConventions(logTail) ?? [];

    // Perform FS writes — each in its own try so one failure doesn't block the other.
    let entryAdded = false;
    try {
      entryAdded = EpicBuildup.appendStoryEntry(this.opts.projectRoot, task.epicId, {
        storyId: task.story.id,
        title: task.story.title,
        completedAt,
        body,
      });
    } catch { /* best-effort */ }

    let conventionsAdded = 0;
    try {
      if (parsedConventions.length > 0) {
        conventionsAdded = EpicBuildup.appendConventions(
          this.opts.projectRoot,
          task.epicId,
          task.story.id,
          completedAt,
          parsedConventions
        );
      }
    } catch { /* best-effort */ }

    // Audit fires unconditionally after writes (Invariant 5) — outside any catch scope.
    // Only emitted when something was actually written; no row for idempotent no-ops.
    if (entryAdded || conventionsAdded > 0) {
      this.audit.record({
        agent_id: task.agentId,
        action: 'buildup_appended',
        command: task.story.id,
        detail: {
          epicId: task.epicId,
          entryAdded,
          conventionsAdded,
        },
      });
    }
  }

  /**
   * Reads the durable branch state (commits since base, diffstat, dirty flag)
   * for a story from its worktree. Shared by the handoff doc and the cross-story
   * context note. Returns null when the agent has no recorded worktree.
   */
  private gatherStoryBranchState(task: StoryTask): {
    worktreePath: string;
    branchName: string;
    commits: Array<{ sha: string; subject: string }>;
    diffStat?: string;
    dirty: boolean;
  } | null {
    const agent = this.agents.get(task.agentId);
    const worktreePath = agent?.worktree_path;
    if (!worktreePath) return null;
    const branchName = agent?.branch_name ?? `story/${task.story.id}`;
    const baseSha = this.storyBaseSha.get(task.story.id);
    const range = baseSha ? `${baseSha}..HEAD` : 'HEAD';

    const logRes = gitSafe(worktreePath, ['log', '--reverse', '--pretty=format:%h%x09%s', range]);
    const commitList =
      logRes.ok && logRes.output.trim().length > 0
        ? logRes.output.split('\n').map((l) => {
            const tab = l.indexOf('\t');
            return tab === -1
              ? { sha: l, subject: '' }
              : { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
          })
        : [];
    const statRes = gitSafe(worktreePath, ['diff', '--stat', range]);
    const dirtyRes = gitSafe(worktreePath, ['status', '--porcelain']);
    return {
      worktreePath,
      branchName,
      commits: commitList,
      diffStat: statRes.ok ? statRes.output : undefined,
      dirty: dirtyRes.ok && dirtyRes.output.trim().length > 0,
    };
  }

  // ─── Live tail flush ───────────────────────────────────────────────────────

  private appendToTail(agentId: string, chunk: string): void {
    let entry = this.outputTails.get(agentId);
    if (!entry) {
      entry = { buffer: '', dirty: false };
      this.outputTails.set(agentId, entry);
    }
    entry.buffer += chunk;
    if (entry.buffer.length > Supervisor.LIVE_TAIL_CHARS * 2) {
      entry.buffer = entry.buffer.slice(-Supervisor.LIVE_TAIL_CHARS);
    }
    entry.dirty = true;
  }

  private startTailFlush(): void {
    if (this.tailFlushTimer) return;
    this.tailFlushTimer = setInterval(
      () => this.flushTails(),
      Supervisor.TAIL_FLUSH_MS
    );
  }

  private stopTailFlush(): void {
    if (this.tailFlushTimer) {
      clearInterval(this.tailFlushTimer);
      this.tailFlushTimer = null;
    }
    this.flushTails();
  }

  // ─── Operator-guidance file watcher ──────────────────────────────────────
  //
  // Watches `<projectRoot>/.loom/guidance/` for file changes. On each
  // debounced event we read the delta from `<storyId>.md` and push it
  // into the live worker's stdin via the per-story `WorkerInputChannel`.
  //
  // Design notes:
  //   - The MCP server (loom serve) and the Supervisor (loom run) are
  //     separate processes. The guidance file IS the channel — MCP
  //     writes it (unchanged), we react.
  //   - Backends with NO_OP_CHANNEL silently fall through to the existing
  //     per-revision pickup; nothing breaks.
  //   - Ownership guard: we only push when `agents.worker_pid` for the
  //     story is in `childPids`. Defends against two `loom run`s racing
  //     for the same project (Winston review S1).
  //   - `fs.watch` on macOS coalesces and can fire both `'change'` and
  //     `'rename'`; we handle both and debounce 100ms (Amelia review P1).

  private startGuidanceWatcher(): void {
    if (this.guidanceWatcher) return;
    const dir = path.join(this.opts.projectRoot, '.loom', 'guidance');
    fs.mkdirSync(dir, { recursive: true }); // must precede fs.watch
    try {
      this.guidanceWatcher = fs.watch(
        dir,
        { persistent: false, recursive: false },
        (_eventType, filename) => {
          if (!filename) return;
          // Both 'change' and 'rename' arrive; ignore non-.md and
          // dotfiles (the watcher dir may contain the future
          // `.pulled/<id>.offset` markers from Phase 2's MCP-pull tool).
          if (!filename.endsWith('.md')) return;
          if (filename.startsWith('.')) return;
          const storyId = filename.slice(0, -3);
          const existing = this.guidanceDebounce.get(storyId);
          if (existing) clearTimeout(existing);
          this.guidanceDebounce.set(
            storyId,
            setTimeout(
              () => this.pushGuidanceDelta(storyId, dir),
              Supervisor.GUIDANCE_DEBOUNCE_MS
            )
          );
        }
      );
    } catch {
      // fs.watch may fail on exotic filesystems; per-revision pickup
      // still works, so this is a soft degrade.
      this.guidanceWatcher = null;
      return;
    }
    Supervisor.liveInstances.add(this);
    if (!Supervisor.exitHookInstalled) {
      Supervisor.exitHookInstalled = true;
      // Single process-wide hook fans out to all live instances. Avoids
      // the per-instance EventEmitter listener leak.
      process.on('exit', () => {
        for (const s of Supervisor.liveInstances) s.stopGuidanceWatcher();
      });
    }
  }

  private async pushGuidanceDelta(storyId: string, dir: string): Promise<void> {
    this.guidanceDebounce.delete(storyId);
    // Ownership guard — only push when this Supervisor owns the worker.
    const agent = this.agents.getByStory(storyId);
    if (!agent || agent.worker_pid == null) return;
    if (!this.childPids.has(agent.worker_pid)) return;

    const channel = this.channelsByStory.get(storyId);
    if (!channel || !channel.available()) return;

    const file = path.join(dir, `${storyId}.md`);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      // File vanished between the watch event and the stat — likely a
      // race with OperatorGuidance.clear(). Reset offset; nothing to push.
      this.guidanceOffsets.delete(storyId);
      return;
    }
    const stored = this.guidanceOffsets.get(storyId) ?? 0;
    // Handle OperatorGuidance.clear() — file shrank below our offset.
    const from = size < stored ? 0 : stored;
    if (size <= from) return;

    let delta = '';
    let fh: number | null = null;
    try {
      fh = fs.openSync(file, 'r');
      const buf = Buffer.alloc(size - from);
      fs.readSync(fh, buf, 0, buf.length, from);
      delta = buf.toString('utf8');
    } catch {
      return;
    } finally {
      if (fh !== null) {
        try { fs.closeSync(fh); } catch {}
      }
    }
    this.guidanceOffsets.set(storyId, size);
    if (delta.length === 0) return;

    let ok = false;
    try {
      ok = await channel.push(delta);
    } catch {
      ok = false;
    }
    try {
      this.audit.record({
        agent_id: agent.id,
        action: ok ? 'operator_guidance_pushed' : 'operator_guidance_push_rejected',
        command: storyId,
        detail: {
          bytes: delta.length,
          channel_open: channel.available(),
        },
      });
    } catch {
      // Audit is best-effort.
    }
  }

  private stopGuidanceWatcher(): void {
    if (this.guidanceWatcher) {
      try { this.guidanceWatcher.close(); } catch {}
      this.guidanceWatcher = null;
    }
    for (const t of this.guidanceDebounce.values()) clearTimeout(t);
    this.guidanceDebounce.clear();
    for (const ch of this.channelsByStory.values()) {
      try { ch.close(); } catch {}
    }
    this.channelsByStory.clear();
    this.guidanceOffsets.clear();
    this.childPids.clear();
    Supervisor.liveInstances.delete(this);
  }

  /** Writes any dirty rolling tails and durable byte offsets to the DB. */
  private flushTails(): void {
    for (const [agentId, entry] of this.outputTails) {
      if (!entry.dirty) continue;
      const trimmed =
        entry.buffer.length > Supervisor.LIVE_TAIL_CHARS
          ? entry.buffer.slice(-Supervisor.LIVE_TAIL_CHARS)
          : entry.buffer;
      const storyId = this.agentToStory.get(agentId);
      const logBytes = storyId != null ? (this.logBytes.get(storyId) ?? 0) : 0;
      this.agents.updateLogTail(agentId, trimmed, logBytes);
      entry.dirty = false;
    }
  }

  /**
   * Picks and loads the skills most relevant to a story, recording each
   * injection in skill_usage so the skill's track record can be measured.
   */
  private selectSkills(story: Story, agentId: string): string[] {
    if (!this.opts.skillStore) return [];
    const manifests = this.opts.skillStore.discover();
    const bodies: string[] = [];
    for (const manifest of SkillSelector.select(story, manifests)) {
      const body = this.opts.skillStore.load(manifest.name);
      if (body === null) continue;
      this.skillUsage.recordInjection(manifest.name, agentId, story.id);
      const provenance = manifest.metadata.generated_from_story_id;
      this.opts.onSkillEvent?.({
        type: 'injected',
        skillName: manifest.name,
        storyId: story.id,
        agentId,
        source: manifest.source,
        lifecycle: manifest.lifecycle,
        ...(typeof provenance === 'string' && provenance.length > 0
          ? { generatedFromStoryId: provenance }
          : {}),
      });
      bodies.push(body);
    }
    return bodies;
  }

  private applyResult(task: StoryTask, result: WorkerResult): void {
    // Always clean up the captured provides line regardless of worker exit status.
    // Cleaning up only inside the SUCCESS guard would leave stale entries for
    // stories with `provides` that exit 'failed', causing them to accumulate
    // across block-and-revise retry cycles.
    const capturedProvidesLine = this.capturedProvidesLines.get(task.story.id);
    this.capturedProvidesLines.delete(task.story.id);
    // Consume LOOM_TOO_BIG signal for injection point A (epic-095-005).
    // Delete unconditionally so stale signals don't bleed into retries.
    const capturedTooBigPayload = this.capturedTooBigSignals.get(task.story.id);
    this.capturedTooBigSignals.delete(task.story.id);

    let status: AgentStatus =
      result.status === 'done' ? (result.prUrl ? 'pr_open' : 'done') : 'failed';

    // Parse and persist LOOM_PROVIDES when the story declares `provides`.
    // Only enforced on a successful worker exit — failures keep the failed status.
    // Stories without `provides` skip this block entirely (backward-compat: no
    // extra audit entries, prompt byte-identical to pre-feature).
    // When blocking due to parse failure, pr_url is not carried so a blocked
    // agent never appears to have an open PR.
    let providesParseBlocked = false;
    if (SUCCESS.has(status) && task.story.provides && Object.keys(task.story.provides).length > 0) {
      // Prefer the streaming-captured LOOM_PROVIDES line (full fidelity, immune
      // to logTail's 2 kB truncation). When the streaming capture found a line
      // (non-null string, captured before applyResult was called), use it directly.
      // Otherwise fall back to logTail so the mock test runner (which never calls
      // onOutput) still exercises the parse path.
      // Note: capturedProvidesLine reflects "last occurrence wins" semantics already
      // — the streaming capture overwrites on each matching line, so the value here
      // is the last LOOM_PROVIDES line seen, not the first.
      const capturedLine = capturedProvidesLine;
      const rawOutput = typeof capturedLine === 'string' ? capturedLine : (result.logTail ?? '');
      let parsedProvides: Record<string, unknown> | null = null;
      let parseErr: LoomProvidesParseError | null = null;
      try {
        parsedProvides = parseLoomProvides(rawOutput);
      } catch (err) {
        if (err instanceof LoomProvidesParseError) parseErr = err;
      }

      if (parseErr !== null) {
        // Malformed trailer → block
        status = 'blocked';
        providesParseBlocked = true;
        this.audit.record({
          agent_id: task.agentId,
          action: 'provides_parse_failed',
          command: task.story.id,
          allowed: false,
          detail: { reason: 'malformed', raw: parseErr.raw.slice(0, 200) },
        });
      } else if (parsedProvides === null) {
        // Absent trailer when story.provides is declared → block
        status = 'blocked';
        providesParseBlocked = true;
        this.audit.record({
          agent_id: task.agentId,
          action: 'provides_parse_failed',
          command: task.story.id,
          allowed: false,
          detail: { reason: 'trailer_absent' },
        });
      } else {
        // Check that all keys declared in story.provides are present in the
        // parsed object. A worker emitting LOOM_PROVIDES {} for a story that
        // declares provides: { schemaVersion: {} } would otherwise silently
        // pass — the downstream requires check would then fail with a
        // misleading error pointing at the dependent story.
        const declaredKeys = Object.keys(task.story.provides);
        const missingKeys = declaredKeys.filter((k) => !(k in parsedProvides!));
        if (missingKeys.length > 0) {
          status = 'blocked';
          providesParseBlocked = true;
          this.audit.record({
            agent_id: task.agentId,
            action: 'provides_parse_failed',
            command: task.story.id,
            allowed: false,
            detail: { reason: 'missing_keys', keys: missingKeys },
          });
        } else {
          // All declared keys present → persist to agents.provides_output
          this.agents.setProvidesOutput(task.agentId, JSON.stringify(parsedProvides));
        }
      }
    }

    task.status = status;
    // Emit an audit entry for any orphaned PR so operators can find and close
    // it even though the story is blocked (pr_url not stored on the blocked record).
    if (providesParseBlocked && result.prUrl) {
      try {
        this.audit.record({
          agent_id: task.agentId,
          action: 'orphaned_pr',
          command: task.story.id,
          allowed: false,
          detail: { pr_url: result.prUrl, reason: 'provides_parse_failed' },
        });
      } catch { /* audit is best-effort */ }
    }
    this.agents.updateStatus(task.agentId, status, {
      // Do not carry pr_url when blocking due to parse failure — a blocked
      // agent should not appear to have an open PR.
      pr_url: providesParseBlocked ? null : (result.prUrl ?? null),
    });
    if (result.review && result.review.status !== 'skipped') {
      this.agents.setReview(task.agentId, result.review.status, result.review.summary);
      this.audit.record({
        agent_id: task.agentId,
        action: 'code_review_pass',
        command: task.story.id,
        detail: {
          status: result.review.status,
          blockers: result.review.blockerCount,
          total: result.review.totalCount,
          revisions: result.review.revisions,
          summary: result.review.summary,
        },
      });
      // Persist the real review's structured findings + the actual revise-round
      // count, so `loom review` renders findings and `loom status` shows
      // `(revise N)`. These come from BaseCliWorker's real block-and-revise loop
      // (ReviewOutcome.findings / .revisions) — the only place they are produced.
      // Clear the story's prior findings first so a clean retry doesn't leave an
      // earlier attempt's blockers as the "latest" (getByStory is per-story).
      this.findings.clearByStory(task.story.id);
      if (result.review.findings && result.review.findings.length > 0) {
        this.findings.saveFindings(task.agentId, task.story.id, result.review.findings);
      }
      this.agents.setReviseRound(task.agentId, result.review.revisions);
    }
    // Story signal ledger — record heuristics + tier to both sinks (story-010-002).
    // Best-effort: SignalLedger.record never throws. Runs regardless of
    // ADAPTIVE_COST (FR-5); audit row lands before return (NFR-2).
    {
      const agent = this.agents.get(task.agentId);
      const worktreePath = agent?.worktree_path;
      const baseSha = this.storyBaseSha.get(task.story.id);
      if (worktreePath && baseSha) {
        const heuristics = computeHeuristics({
          worktreePath,
          baseSha,
          testsGreenFirstTry: null,
        });
        // Feed the worker's self-assessment (B1) into the tier resolution when
        // present — without it confidence defaults to low and the resolver
        // recommends `heavy` for nearly every story. Still observe-only.
        const signals = buildStorySignals(heuristics, {
          ...(result.selfAssessment ? { selfAssessment: result.selfAssessment } : {}),
        });
        this.signalLedger.record(task.story.id, signals, task.agentId);
      }
    }
    if (result.usage) {
      this.agents.setUsage(task.agentId, {
        tokens_input: result.usage.inputTokens,
        tokens_output: result.usage.outputTokens,
        tokens_cached: result.usage.cacheReadTokens,
        tokens_cache_creation: result.usage.cacheCreationTokens,
        cost_usd: result.usage.costUsd,
        request_count: result.usage.requestCount,
      });
      activeCollector()?.addUsage(toLLMUsage(result.usage), result.model, 'worker');
    }
    // Overwrite with the executed model when the system/init event provided one.
    if (result.model) {
      this.agents.setModel(task.agentId, result.model);
    }
    // Write the durable log_bytes offset at completion. The periodic flushTails
    // runs on a 1-second cadence so fast workers may complete before it fires;
    // this write guarantees log_bytes is always persisted at the end of a run.
    const completionStoryId = this.agentToStory.get(task.agentId);
    const completionLogBytes =
      completionStoryId != null ? (this.logBytes.get(completionStoryId) ?? 0) : 0;
    this.agents.updateLogTail(
      task.agentId,
      result.logTail ?? '',
      completionLogBytes
    );
    // Clear the live entry so a subsequent flushTails doesn't overwrite the
    // just-written final log_tail/log_bytes with a stale rolling buffer.
    this.outputTails.delete(task.agentId);
    // Release the agentId→storyId mapping; the log_bytes accumulator for the
    // story is intentionally preserved (a retry continues appending to the same
    // file, so the cumulative offset must survive past the agent's completion).
    this.agentToStory.delete(task.agentId);
    // Per-story guidance state: the channel is dead now that the spawn
    // ended, and the offset is meaningless for a future story even if the
    // file lingers on disk. Worker pid was added to childPids on spawn —
    // remove it now so any late watcher event sees an unowned pid.
    const completedAgent = this.agents.get(task.agentId);
    if (completedAgent?.worker_pid != null) {
      this.childPids.delete(completedAgent.worker_pid);
    }
    this.channelsByStory.get(task.story.id)?.close();
    this.channelsByStory.delete(task.story.id);
    this.guidanceOffsets.delete(task.story.id);
    this.skillUsage.recordOutcome(task.agentId, status);
    this.audit.record({
      agent_id: task.agentId,
      action: 'completion',
      command: task.story.id,
      detail: { status, summary: result.summary, commits: result.commitCount },
    });
    // Crash-resilient resume: on a failed/blocked story, materialize the
    // handoff doc from durable telemetry so a later retry can continue.
    this.refreshHandoff(task, result, status);
    // Cross-story "what I built" note for dependents. In rolling mode a story is
    // not truly available to dependents until it integrates, so defer to
    // integrateStory there; otherwise (legacy topology) write it on success now.
    if (!this.rolling && SUCCESS.has(status)) {
      this.writeContextNote(task, result.summary);
      this.appendBuildupEntry(task, result.summary, new Date().toISOString(), result.logTail ?? '');
    }
    // Single-event-per-story contract: in rolling mode a successful worker is
    // not "done" until its branch integrates, so DEFER the completed event to
    // integrateStory, which emits exactly one with the final status (done on a
    // clean merge, blocked on a conflict). Everything else still emits here.
    if (!(this.rolling && SUCCESS.has(status))) {
      this.opts.onWorkerEvent?.({
        type: 'completed',
        storyId: task.story.id,
        status,
        summary: result.summary,
        commitCount: result.commitCount,
        ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      });
    }

    // Self-learning: extract a reusable skill from a successful story.
    // Respects SKILL_GENERATION: 'off' suppresses entirely,
    // 'sampled' runs every Nth success — a cost-conscious knob for teams
    // who want the loop but not on every story.
    if (this.opts.skillGenerator && SUCCESS.has(status) && this.shouldGenerateNow()) {
      const generator = this.opts.skillGenerator;
      const audit = this.audit;
      const onSkillEvent = this.opts.onSkillEvent;
      const promise = generator.afterStory(task.agentId, task.story).then((manifest) => {
        if (manifest) {
          audit.record({
            action: 'skill_generated',
            command: manifest.name,
            detail: {
              story_id: task.story.id,
              source: manifest.source,
              lifecycle: manifest.lifecycle,
            },
          });
          onSkillEvent?.({
            type: 'generated',
            skillName: manifest.name,
            storyId: task.story.id,
          });
        }
        return manifest;
      });
      this.skillGenPromises.push(promise);
    }

    // Clean auto-retry on stall (story-061-003). Classify the exit; only
    // 'stall' takes the recovery path. Audit-first: the stall-kill row lands
    // even when budget is exhausted or prep rejects. Recovery never resumes
    // from a checkpoint — it always starts a fresh worktree + branch.
    const exitClass = classifyWorkerExit(result);
    if (exitClass === 'stall') {
      // Read durable count before any mutation so recordStallKill carries the
      // pre-retry value and the audit-first invariant is preserved throughout.
      const currentCount = this.recoveryStore.getRecoveryCount(task.story.id);
      recordStallKill(this.audit, {
        agentId: task.agentId,
        storyId: task.story.id,
        result,
        recoveryCount: currentCount,
      });
      const budget = this.opts.stallRecoveryBudget ?? 2;
      if (currentCount < budget) {
        const prep = this.cleanRetryService.prepare(task.story.id);
        if (prep.status === 'ready') {
          const newCount = currentCount + 1;
          const kr = result.killReason;
          if (kr !== 'stall' && kr !== 'hung_request') {
            throw new Error(
              `classifyWorkerExit returned 'stall' but killReason='${kr}' is not in the stall allowlist`
            );
          }
          // Atomic: both the audit row and the budget counter land in one
          // SQLite transaction so a crash between them cannot leave the
          // counter and audit log in a split state.
          this.opts.db.transaction(() => {
            recordAutoRecovery(this.audit, {
              agentId: task.agentId,
              storyId: task.story.id,
              detail: {
                recovery_attempt: newCount,
                budget,
                kill_reason: kr,
                reset_stories: prep.resetStories,
              },
            });
            this.recoveryStore.incrementRecoveryCount(task.story.id);
          })();
          this.runAutoRecoveryCount++; // story-065-004: track for terminal attribution
          this.runCleanRetryCount++;   // clean-worktree recovery path
          task.status = 'pending';
          return;
        }
      }
      // Budget spent or prep rejected → surface for manual intervention.
    }

    // Injection point A: reroute on LOOM_TOO_BIG signal (epic-095-005).
    // Prefer streaming capture (full fidelity); fall back to scanning logTail so
    // test runners that bypass onOutput (MockWorkerRunner) also trigger reroutes.
    // This mirrors the LOOM_PROVIDES capturedLine / logTail fallback pattern.
    const effectiveTooBigPayload =
      capturedTooBigPayload !== undefined
        ? capturedTooBigPayload
        : scanLogTailForTooBigSignal(result.logTail ?? '');
    // Guard: a successful worker that incidentally printed the signal must not be
    // re-decomposed. Only reroute when the worker actually did not finish the story.
    if (effectiveTooBigPayload !== undefined && result.status !== 'done' && this.opts.pmAgent) {
      this.pendingReroutes.set(task.story.id, {
        trigger: 'LOOM_TOO_BIG',
        fanOutPayload: effectiveTooBigPayload,
      });
      task.status = 'pending';
      return;
    }

    // Injection point B: reroute on absoluteCapMs kill (epic-095-005).
    // A 'cap' kill means the story is genuinely too large for a single worker
    // run; re-decompose it rather than treating it as a permanent failure.
    if (result.killReason === 'cap' && this.opts.pmAgent) {
      this.pendingReroutes.set(task.story.id, {
        trigger: 'cap',
        fanOutPayload: '',
      });
      task.status = 'pending';
      return;
    }
  }

  /**
   * Handles a queued reroute for a story whose applyResult set `pendingReroutes`.
   * Budget-gated PM decompose → Supervisor allocates schema-valid sub-story IDs →
   * validate the sub-graph → re-point every downstream dependent (dependencies onto
   * ALL sub-stories, `requires` onto the providing sub-story) → atomically inject +
   * supersede the original → mirror in the in-memory tasks map → clean up the
   * original's worktree.
   *
   * Throws (RerouteBudgetExhaustedError / RerouteValidationError / internal) so the
   * dispatch-loop sweep can mark this ONE story failed and continue — a single
   * un-splittable story must never abort the run or orphan concurrent workers.
   */
  private async doReroute(
    task:    StoryTask,
    pending: { trigger: 'LOOM_TOO_BIG' | 'cap'; fanOutPayload: string },
    tasks:   Map<string, StoryTask>
  ): Promise<void> {
    const original = task.story;
    const payload: ReroutePayload = {
      story:         original,
      fanOutPayload: pending.fanOutPayload,
      trigger:       pending.trigger,
    };

    // Coverage keys: `requires` keys that some downstream demands FROM the original.
    // The PM must arrange exactly one sub-story to `provides` each (validated below).
    const coverageKeys = this.computeCoverageKeys(original.id, tasks);

    let result: { subStories: Story[]; parentResplitCount: number };
    try {
      result = await handleReroute(payload, {
        pmAgent:      this.opts.pmAgent!,
        agents:       this.agents,
        epicId:       task.epicId,
        auditLog:     this.audit,
        coverageKeys,
      });
    } catch (err) {
      task.status = 'failed';
      throw err; // budget-exhausted / insufficient — swept + continued by the caller
    }

    try {
      // The Supervisor (sole holder of the full DAG) stamps schema-valid
      // `story-NNN-MMM` IDs and remaps the sub-stories' internal references.
      const subStories = this.allocateSubStoryIds(task.epicId, tasks, result.subStories);

      // Validate the id-stamped sub-graph before any DB write.
      validateSubStories(original, subStories, new Set(tasks.keys()), coverageKeys);

      const allSubIds = subStories.map((s) => s.id);
      // key -> the sub-story that provides it (exactly one, per validation).
      const providerFor = new Map<string, string>();
      for (const sub of subStories) {
        if (!sub.provides) continue;
        for (const k of Object.keys(sub.provides)) {
          if (coverageKeys.includes(k)) providerFor.set(k, sub.id);
        }
      }

      // Re-point downstream dependents: dependencies onto ALL sub-stories (so
      // downstream waits for the whole re-split), requires onto the provider.
      const depOverrides: DownstreamOverride[] = [];
      const requiresOverrides: DownstreamRequiresOverride[] = [];
      for (const t of tasks.values()) {
        if (t.story.id === original.id) continue;
        if (t.story.dependencies.includes(original.id)) {
          const newDeps = t.story.dependencies.flatMap((d) =>
            d === original.id ? allSubIds : [d]
          );
          depOverrides.push({ storyId: t.story.id, newDependencies: newDeps });
        }
        if (t.story.requires) {
          let changed = false;
          const newReq: Record<string, string> = { ...t.story.requires };
          for (const [k, src] of Object.entries(t.story.requires)) {
            if (src === original.id) { newReq[k] = providerFor.get(k)!; changed = true; }
          }
          if (changed) requiresOverrides.push({ storyId: t.story.id, newRequires: newReq });
        }
      }

      // Atomic: sub rows (seeded resplit) + dep/requires overrides + supersede original.
      injectSubStories(original, subStories, task.epicId, this.opts.db, this.audit, {
        parentResplitCount: result.parentResplitCount,
        depOverrides,
        requiresOverrides,
      });

      // Mirror the committed DB writes in the in-memory tasks map.
      for (const sub of subStories) {
        const agentRow = this.agents.getByStory(sub.id);
        if (!agentRow) {
          throw new Error(
            `Internal error: agent row for injected sub-story ${sub.id} not found ` +
            `immediately after injectSubStories committed`
          );
        }
        tasks.set(sub.id, { epicId: task.epicId, story: sub, agentId: agentRow.id, status: 'pending' });
      }
      for (const ov of depOverrides) {
        const t = tasks.get(ov.storyId);
        if (t) t.story = { ...t.story, dependencies: ov.newDependencies };
      }
      for (const ov of requiresOverrides) {
        const t = tasks.get(ov.storyId);
        if (t) t.story = { ...t.story, requires: ov.newRequires };
      }

      // The original is superseded (DB row now has superseded_by; keeps status='failed').
      tasks.delete(original.id);
      // Reclaim the original's worktree — it will never be retried.
      this.removeStoryWorktree(original.id);

      this.opts.onWorkerEvent?.({
        type:        'rerouted',
        storyId:     original.id,
        subStoryIds: allSubIds,
        trigger:     pending.trigger,
      });
    } catch (err) {
      task.status = 'failed';
      throw err; // validation / internal — swept + continued by the caller
    }
  }

  /** Keys that some downstream (in the tasks map) `requires` FROM `originalId`. */
  private computeCoverageKeys(originalId: string, tasks: Map<string, StoryTask>): string[] {
    const keys = new Set<string>();
    for (const t of tasks.values()) {
      if (t.story.id === originalId || !t.story.requires) continue;
      for (const [k, src] of Object.entries(t.story.requires)) {
        if (src === originalId) keys.add(k);
      }
    }
    return [...keys];
  }

  /**
   * Stamps schema-valid `story-<epicNum>-<NNN>` IDs onto PM-returned sub-stories
   * (the PM uses placeholder IDs it can't guarantee are unique or well-formed), and
   * remaps each sub-story's internal `dependencies`/`requires` references from the
   * placeholder IDs to the freshly allocated ones. New numbers continue past the max
   * `-MMM` currently present in the epic (YAML + already-injected).
   */
  private allocateSubStoryIds(
    epicId:  string,
    tasks:   Map<string, StoryTask>,
    rawSubs: Story[]
  ): Story[] {
    const epicNum = epicId.match(/-(\d{3})$/)?.[1] ?? '000';
    let maxMMM = 0;
    for (const id of tasks.keys()) {
      // Match 3+ digits so a prior 4-digit allocation (MMM > 999) is still counted,
      // never re-allocated as a colliding lower number.
      const m = id.match(/^story-\d{3}-(\d{3,})$/);
      if (m) maxMMM = Math.max(maxMMM, parseInt(m[1], 10));
    }
    // Allocate ids BY INDEX (not via a placeholder-keyed map) so two subs that share
    // a duplicate PM placeholder id still get DISTINCT allocated ids. padStart(3) is a
    // minimum width — values > 999 simply widen, staying regex-matchable above.
    const allocated = rawSubs.map((_, i) => `story-${epicNum}-${String(maxMMM + 1 + i).padStart(3, '0')}`);
    // The reference remap still keys on placeholder id → allocated id. A duplicate
    // placeholder maps to the LAST occurrence's allocated id; that only affects a sub
    // that *references* the duplicate placeholder, and validateSubStories rejects any
    // resulting inconsistency (graceful fail) rather than producing a bad DAG.
    const idMap = new Map<string, string>();
    rawSubs.forEach((sub, i) => idMap.set(sub.id, allocated[i]));
    const remap = (id: string) => idMap.get(id) ?? id;
    return rawSubs.map((sub, i) => ({
      ...sub,
      id:           allocated[i],
      dependencies: sub.dependencies.map(remap),
      ...(sub.requires
        ? { requires: Object.fromEntries(Object.entries(sub.requires).map(([k, v]) => [k, remap(v)])) }
        : {}),
    }));
  }

  /** Best-effort removal of a superseded story's worktree across all repo managers. */
  private removeStoryWorktree(storyId: string): void {
    for (const mgr of this.wtByRepo.values()) {
      try { mgr.remove(storyId); } catch { /* best-effort: worktree may not exist */ }
    }
  }

  /**
   * Returns true when skill generation should run for the *next* successful
   * story. Increments the success counter as a side effect. 'on' = always,
   * 'off' = never, 'sampled' = every Nth (defaults to N=4).
   */
  private shouldGenerateNow(): boolean {
    const mode = this.opts.skillGenerationMode ?? 'on';
    if (mode === 'off') return false;
    this.successCount += 1;
    if (mode === 'on') return true;
    const n = Math.max(2, this.opts.skillGenerationSampleN ?? 4);
    return this.successCount % n === 0;
  }

  private transition(task: StoryTask, status: AgentStatus, reason: string): void {
    task.status = status;
    this.agents.updateStatus(task.agentId, status);
    // A blocked story may have had skills injected before being force-stopped.
    this.skillUsage.recordOutcome(task.agentId, status);
    this.audit.record({
      agent_id: task.agentId,
      action: 'status_change',
      command: task.story.id,
      detail: { status, reason },
    });
  }

  /**
   * Builds a Map<storyId → provides object> from the persisted `provides_output`
   * column of completed stories referenced in `story.requires`. Used by both the
   * `checkRequires` call (dispatch gate) and `injectProvidesSection` (prompt
   * injection). Returns an empty map when `story.requires` is absent.
   */
  private buildProvidesMapForStory(story: Story): Map<string, Record<string, unknown>> {
    const result = new Map<string, Record<string, unknown>>();
    if (!story.requires) return result;
    const seen = new Set<string>();
    for (const sourceStoryId of Object.values(story.requires)) {
      if (seen.has(sourceStoryId)) continue;
      seen.add(sourceStoryId);
      const agent = this.agents.getByStory(sourceStoryId);
      if (!agent?.provides_output) continue;
      try {
        const parsed = JSON.parse(agent.provides_output);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          result.set(sourceStoryId, parsed as Record<string, unknown>);
        }
      } catch {
        // Emit a low-severity audit entry so operators can diagnose why a
        // downstream story is unexpectedly blocked due to corrupt upstream data.
        try {
          this.audit.record({
            agent_id: agent.id,
            action: 'provides_output_corrupt',
            command: sourceStoryId,
            allowed: false,
            detail: { story_id: sourceStoryId },
          });
        } catch { /* audit is best-effort; never fail a build over telemetry */ }
      }
    }
    return result;
  }

}
