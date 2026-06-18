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
} from '../state/index.js';
import type { GlobalLimiter, LimiterSlot } from '../state/index.js';
import { EpicYamlSchema, type Story, type AgentStatus } from '../types.js';
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
  type McpJsonEntry,
} from '../mcp/index.js';
import { enforceCursorMcpAllowlist } from './CursorMcpEnforcer.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeJanitor } from './WorktreeJanitor.js';
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

export interface SupervisorOptions {
  projectRoot: string;
  db: Database.Database;
  worker: WorkerRunner;
  /** Max worker agents running concurrently (policy.agents.max_concurrent). */
  maxConcurrent: number;
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
   * Sourced from policy.agents.skill_generation; defaults to 'on'.
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
   * policy.agents.integration_branch. When 'rolling', the supervisor creates a
   * live `epic/<id>` branch up front, branches every worker from its tip, and
   * merges each story back as it completes (rolling integration). 'off'
   * (default) keeps the legacy topology: workers branch from their first
   * dependency and the EpicFinalizer big-bang-merges at the end. The caller
   * passes 'rolling' only under pr_strategy='per-epic'.
   */
  integrationBranch?: 'off' | 'rolling';
  /**
   * policy.agents.integrator. When 'on' (and integration_branch='rolling'), a
   * story whose merge-back conflicts is handed to a bounded integrator agent
   * that resolves the conflict in the integration worktree; loom commits the
   * merge and re-runs the gate. Only on a green result is the story integrated.
   * Exhausting the attempts (or any failure) falls back to the loud-block path —
   * the conflict is never silently dropped. 'off' (default) keeps the 3a
   * behavior: a merge conflict blocks the story immediately.
   */
  integrator?: 'off' | 'on';
  /** policy.agents.integrator_max_attempts — resolve+gate rounds before giving up (default 1). */
  integratorMaxAttempts?: number;
  /** policy.agents.test_command — the gate command the integrator re-runs after a resolution. */
  testCommand?: string;
  /** policy.agents.integration_gate_timeout_minutes (ms) — bound for the integrator's gate run. */
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
   * policy.agents.context_notes. When 'on', a "what I built" note is written to
   * .loom/context/<story-id>.md when a story succeeds (and, in rolling mode,
   * integrates) so dependent workers can be primed with its decisions + surface
   * area. 'off' (default) writes nothing and keeps the worker prompt
   * byte-identical to the bench baseline.
   */
  contextNotes?: 'off' | 'on';
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
   * Per-story worker watchdog config (policy.agents.analysis_only_watchdog).
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
   * The `.cursor/mcp.json` entry for loom's own MCP server, built in loom-cli
   * (commands/run.ts) via `loomScriptPath()` — core cannot compute it (ADR-5).
   * Threaded into the worktree config only for the cursor-cli backend, whose
   * CursorAgentWorker.pullGuidanceHint() depends on the `loom_pull_guidance`
   * tool (ADR-3). Unset = the loom server is never added to worker configs.
   */
  loomServerEntry?: McpJsonEntry;
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
  private wt: WorktreeManager;
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
  private static readonly LIVE_TAIL_CHARS = 4096;
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
    this.wt = new WorktreeManager(opts.projectRoot);
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
  }

  async run(epicIds?: string[]): Promise<SupervisorResult> {
    this.skillGenPromises = [];
    this.outputTails.clear();
    this.successCount = 0;
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
        const policy = PolicyEngine.load(loomDir).policyData;
        await approveAndDispatch(
          { epicStore: this.epics, auditLog: this.audit, policy },
          epic.id,
          { actor: 'full-auto' }
        );
      }
    }

    const { selected, skipped } = this.selectEpics(epicIds);

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
      for (const story of this.loadStories(epicId)) {
        tasks.set(story.id, this.taskFor(epicId, story));
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
          const pruned = new WorktreeJanitor(this.wt, this.agents).prune({
            reasons: ['no-agent'],
          });
          if (pruned.length > 0) {
            this.audit.record({
              action: 'worktrees_pruned',
              command: leased.join(','),
              detail: {
                count: pruned.length,
                worktrees: pruned.map((p) => ({ story: p.storyId, reason: p.reason })),
              },
            });
          }
        } catch {
          // Pruning is housekeeping; a failure must not fail the run.
        }
      }

      const all = [...tasks.values()];
      result = {
        epicsProcessed: leased,
        epicsSkipped: allSkipped,
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
    return result;
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
    let fin;
    try {
      fin = await this.opts.epicFinalizer!.finalize(epicId);
    } catch (err) {
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

  private selectEpics(epicIds?: string[]): { selected: string[]; skipped: string[] } {
    const selected: string[] = [];
    const skipped: string[] = [];

    // 'in_progress' is runnable too — it is an epic a prior run started but did
    // not finish (a halt, a checkpoint, or a failure). That is what resume needs.
    const RUNNABLE = new Set(['approved', 'in_progress']);
    const candidates = epicIds
      ? epicIds.map((id) => this.epics.get(id)).filter((e) => e !== undefined)
      : [
          ...this.epics.listByStatus('approved'),
          ...this.epics.listByStatus('in_progress'),
        ];

    for (const epic of candidates) {
      if (RUNNABLE.has(epic!.status)) selected.push(epic!.id);
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
    return { selected, skipped };
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
      while (!haltDispatch && inFlight.size < cap) {
        const ready = [...tasks.values()].find(
          (t) =>
            t.status === 'pending' &&
            t.story.dependencies.every(depDone) &&
            (firstActiveEpic === undefined || t.epicId === firstActiveEpic)
        );
        if (!ready) break;
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
        inFlight.set(ready.story.id, this.dispatch(ready));
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
          const gate = await this.integratorGate.run({ projectRoot: wtPath });
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

  private dispatch(task: StoryTask): Promise<{ storyId: string; result: WorkerResult }> {
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
    const wt = this.wt.create(task.story.id, fromBranch ? { fromBranch } : {});
    // Remember the branch point so a handoff/retry can scope to this worker's
    // own commits (`baseSha..HEAD`).
    this.storyBaseSha.set(task.story.id, wt.baseSha);

    // ─── Worker MCP isolation (epic-002, dispatch ordering steps 2–4) ──────
    // Materialize a worktree-local `.cursor/mcp.json` exposing EXACTLY the
    // policy.mcp.registry servers (whole-file overwrite, never a merge). The
    // loom server is included per-backend (ADR-3): cursor-cli gets it because
    // CursorAgentWorker.pullGuidanceHint() relies on the `loom_pull_guidance`
    // tool, whereas claude-code workers get registry servers only. The loom
    // entry itself is built in loom-cli and threaded via SupervisorOptions —
    // core never computes it (ADR-5). The cursor enforcer (step 3) disables
    // any stray inherited servers headlessly; it is a no-op for claude-code,
    // which gets strict isolation from the `--strict-mcp-config` spawn arg.
    const { backend, registry } = this.mcpContext();
    const loomServerEntry =
      backend === 'cursor-cli' ? this.opts.loomServerEntry : undefined;
    const mat = materializeWorktreeMcpConfig({
      worktreePath: wt.path,
      registry,
      loomServerEntry,
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
        loomServerIncluded: loomServerEntry !== undefined,
        ...(enf ? { disabledServers: enf.disabled, gaps: enf.gaps } : {}),
      },
    });

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

    const onOutput = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      this.opts.onWorkerEvent?.({
        type: 'output',
        storyId: task.story.id,
        stream,
        chunk,
      });
      this.appendToTail(task.agentId, chunk);
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

    const assignment: WorkerAssignment = {
      storyId: task.story.id,
      epicId: task.epicId,
      story: task.story,
      worktreePath: wt.path,
      branchName: wt.branch,
      baseSha: wt.baseSha,
      projectRoot: this.opts.projectRoot,
      integrationBranch: this.opts.integrationBranch ?? 'off',
      hasDependents: this.storiesWithDependents.has(task.story.id),
      skills: this.selectSkills(task.story, task.agentId),
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
    return staggerSlot
      .then(() => this.maybeAssembleContext(task))
      .then(() => this.opts.worker.run(assignment))
      .then((result) => ({ storyId: task.story.id, result }))
      .catch((err: unknown) => ({
        storyId: task.story.id,
        result: {
          status: 'failed' as const,
          commitCount: 0,
          summary: `Worker threw: ${(err as Error).message}`,
          logTail: '',
        },
      }))
      .finally(() => watchdog?.stop());
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
   * Mid-run handoff refresh fired at a phase boundary (policy.agents.phases=
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

  /** Writes any dirty rolling tails to agents.log_tail. */
  private flushTails(): void {
    for (const [agentId, entry] of this.outputTails) {
      if (!entry.dirty) continue;
      const trimmed =
        entry.buffer.length > Supervisor.LIVE_TAIL_CHARS
          ? entry.buffer.slice(-Supervisor.LIVE_TAIL_CHARS)
          : entry.buffer;
      this.agents.updateLogTail(agentId, trimmed);
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
    const status: AgentStatus =
      result.status === 'done' ? (result.prUrl ? 'pr_open' : 'done') : 'failed';
    task.status = status;
    this.agents.updateStatus(task.agentId, status, {
      pr_url: result.prUrl ?? null,
      log_tail: result.logTail,
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
    }
    // Story signal ledger — record heuristics + tier to both sinks (story-010-002).
    // Best-effort: SignalLedger.record never throws. Runs regardless of
    // policy.agents.adaptive_cost (FR-5); audit row lands before return (NFR-2).
    {
      const agent = this.agents.get(task.agentId);
      const worktreePath = agent?.worktree_path;
      const baseSha = this.storyBaseSha.get(task.story.id);
      if (worktreePath && baseSha) {
        let riskyPaths: string[] = [];
        try {
          const policy = PolicyEngine.load(
            path.join(this.opts.projectRoot, '.loom')
          ).policyData;
          riskyPaths = policy.agents.risky_paths;
        } catch {
          // Best-effort: missing or unreadable policy → default to empty list.
        }
        const heuristics = computeHeuristics({
          worktreePath,
          baseSha,
          riskyPaths,
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
    }
    if (result.budgetExhausted) {
      this.audit.record({
        agent_id: task.agentId,
        action: 'budget_exhausted',
        command: task.story.id,
        detail: {
          budget: result.usage?.totalTokens,
          summary: result.summary,
        },
      });
    }
    // The final log_tail just landed via updateStatus; clear the live entry so
    // a subsequent flush doesn't overwrite it with a stale rolling buffer.
    this.outputTails.delete(task.agentId);
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
    // Respects `policy.agents.skill_generation`: 'off' suppresses entirely,
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
}
