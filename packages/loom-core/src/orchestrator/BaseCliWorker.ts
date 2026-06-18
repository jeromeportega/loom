import {
  spawn,
  execFileSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type {
  WorkerRunner,
  WorkerAssignment,
  WorkerResult,
  ReviewOutcome,
  WorkerUsage,
  ConflictResolution,
  ConflictResolutionResult,
} from './WorkerRunner.js';
import { type WorkerInputChannel, NO_OP_CHANNEL } from './WorkerInputChannel.js';
import { buildWorkerPrompt, buildIntegratorPrompt } from './workerPrompt.js';
import { parseSelfAssessment } from './selfAssessment.js';
import type { SelfAssessment } from '../types.js';
import type { Story } from '../types.js';
import { gitSafe, defaultRemote, remoteUrl } from './git.js';
import {
  WorkerTimeoutGuard,
  type TimeoutKillReason,
  type WorkerTimeoutGuardOptions,
} from './WorkerTimeoutGuard.js';
import { type SpawnOutcome, classifyAttempt } from './InfraFailureClassifier.js';
import type { Classification } from './resilience/types.js';
import { InfraRetryController } from './InfraRetryController.js';
import {
  SystemRetryClock,
  Mulberry32,
  type RetryClock,
  type JitterSource,
} from './resilience/RetryClock.js';
import type { AttemptClass, InfraSignature } from './resilience/types.js';
import type { CodeReviewAgent } from '../review/CodeReviewAgent.js';
import type { ReviewFinding } from '../review/types.js';
import {
  runReviewPass,
  runReviewLoop,
  type ReviewPassDeps,
  type ReviewPassResult,
  type ReviewerInput,
} from '../review/orchestrator.js';
import type { Finding } from '../findings/schema.js';

export type PrStrategy = 'per-story' | 'per-epic' | 'both';

export interface CliWorkerOptions {
  /**
   * Legacy absolute wall-clock kill. Retained for backward compatibility:
   * when `absoluteCapMs` is unset this value (if provided) becomes the
   * absolute cap. Prefer `absoluteCapMs` / `stallMs`. Default: 30 minutes
   * worth of cap when nothing else is supplied.
   */
  timeoutMs?: number;
  /**
   * Kill the worker after this long with ZERO output activity (the worker is
   * silent — genuinely stuck). Resets on any stdout/stderr chunk, so a
   * long-but-streaming run (e.g. a multi-minute test suite) is never killed
   * by the stall path. Default ~12 minutes. Per-story overrides arrive via
   * `WorkerAssignment.stallMs` (complexity-scaled by the Supervisor).
   */
  stallMs?: number;
  /**
   * Absolute wall-clock ceiling regardless of activity — the backstop against
   * a worker that streams forever in a useless loop. Default ~60 minutes.
   * Per-story overrides arrive via `WorkerAssignment.absoluteCapMs`.
   */
  absoluteCapMs?: number;
  /**
   * Per-complexity multiplier applied to BOTH `stallMs` and `absoluteCapMs`
   * when the assignment does not carry an explicit override. Lets a `large`
   * 4-service story get more budget than a `trivial` doc edit. Keyed by
   * `story.estimated_complexity`; missing keys default to 1.0.
   */
  complexityMultipliers?: Record<string, number>;
  /** Open a PR when the repo has a remote and the worker made commits. Default: true. */
  openPr?: boolean;
  /**
   * Glob patterns for remotes loom may push to (policy.git.allowed_remotes).
   * `undefined` means "no policy supplied" (push allowed); an empty array means
   * "block all pushes" (matching the guardrail engine).
   */
  allowedRemotes?: string[];
  /**
   * PR strategy (policy.agents.pr_strategy). When 'per-epic', workers commit
   * on their story branch locally but do NOT push or open a per-story PR —
   * the EpicFinalizer handles the single epic PR. 'both' keeps both. Defaults
   * to 'per-story' for backward compatibility at the worker level; the run.ts
   * caller passes the resolved policy value.
   */
  prStrategy?: PrStrategy;
  /**
   * Optional CodeReviewAgent for the worker's post-commit review pass
   * (Epic 18 story-018-002). Unset → review_strategy is treated as 'off'.
   */
  reviewAgent?: CodeReviewAgent;
  /**
   * Review strategy applied AFTER the worker makes its commits and BEFORE
   * the PR is opened. 'off' = no review (default at this layer for backward
   * compat); 'comment' = findings attach to the PR; 'block-and-revise' =
   * blockers trigger up to `maxReviewRevisions` re-prompts of the worker
   * with the review in context.
   */
  reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
  /** Max revision rounds for 'block-and-revise'. Defaults to 2. */
  maxReviewRevisions?: number;
  /**
   * policy.agents.review_revise_trigger — severity threshold that
   * re-prompts the worker in block-and-revise:
   *   'blockers' (default) — only blocker-severity findings revise
   *   'any'                — any non-empty finding revises (still
   *                          bounded by maxReviewRevisions)
   */
  reviewReviseTrigger?: 'blockers' | 'any';
  /**
   * Review Forge orchestrator hook (epic-001 story-003). When set, the
   * post-commit review pass fans out to the three reviewers this returns
   * (the CodeReviewAgent adapter plus the ported adversarial-review /
   * edge-case-hunter reviewers), unions and dedupes their findings, and
   * revises while any blocker/high finding remains — bounded by
   * `maxReviewRevisions`. Constructed by the caller that holds the loom db
   * (so skill invocations are audited). Unset → the legacy single-
   * CodeReviewAgent pass applies, so existing callers are byte-identical.
   */
  reviewOrchestrator?: (assignment: WorkerAssignment) => ReviewPassDeps;
  /**
   * Per-story token budget (Epic 16 story-016-005). When set and the worker's
   * cumulative token usage crosses this, the subprocess is SIGTERM'd and the
   * story marked failed with reason "budget exhausted". Requires a backend
   * that emits inflight usage (currently only claude-code via stream-json).
   */
  budgetTokensPerStory?: number;
  /**
   * policy.agents.operator_guidance — when 'on', the worker prompt includes
   * the operator's guidance file at .loom/guidance/<story-id>.md (when
   * the file exists). Default 'off' so the worker prompt is byte-identical
   * to the bench baseline.
   */
  operatorGuidance?: 'off' | 'on';
  /**
   * policy.agents.shared_contract — when 'on', the worker prompt prepends the
   * architect's epic-wide shared contract at .loom/contract/<epic-id>.md (when
   * the file exists). Default 'off' so the worker prompt is byte-identical to
   * the bench baseline.
   */
  sharedContract?: 'off' | 'on';
  /**
   * policy.agents.context_notes — when 'on', the worker prompt appends each
   * dependency's "what I built" note at .loom/context/<dep-id>.md WHEN THOSE
   * FILES EXIST (written when the upstream story succeeded). Default 'off' so
   * the worker prompt is byte-identical to the bench baseline.
   */
  contextNotes?: 'off' | 'on';
  /**
   * policy.agents.handoff — when not 'off', the worker prompt includes the
   * resume handoff at .loom/handoff/<story-id>.md WHEN THAT FILE EXISTS. The
   * file is only present after a prior attempt failed/timed-out (the
   * Supervisor writes it then, and clears it on success), so a first attempt
   * keeps the byte-identical baseline prompt. Default 'off'.
   */
  handoff?: 'off' | 'telemetry' | 'summarized';
  /**
   * policy.agents.phases — when 'on', `run()` executes the story as discrete
   * agent spawns (implement, then verify) instead of one. Each phase gets its
   * own fresh stall/cap timer (a fresh `spawnAgent`), and the boundary commits
   * any residue + refreshes the handoff. Default 'off' keeps the single-spawn
   * bench baseline byte-identical.
   */
  phases?: 'off' | 'on';
  /**
   * policy.agents.worker_auth — when 'session', the worker spawn env strips
   * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the spawned CLI uses the
   * operator's `claude login` session instead of an inherited API key. Lets
   * an outer agent run on API credits while workers stay on the session.
   * 'inherit' (default) leaves the parent env untouched.
   */
  workerAuth?: 'inherit' | 'session';
  /**
   * policy.agents.adaptive_cost — when 'on', the implement prompt asks the
   * worker to end with a self-assessment marker (B1), and the worker surfaces
   * the parsed rating on its result for the signal ledger. Default 'off' keeps
   * the worker prompt byte-identical to the bench baseline.
   */
  adaptiveCost?: 'on' | 'off';
}

/** Legacy absolute cap used when neither absoluteCapMs nor timeoutMs is given. */
const DEFAULT_ABSOLUTE_CAP_MS = 60 * 60 * 1000;
/** Default silence window before the stall kill fires. */
const DEFAULT_STALL_MS = 12 * 60 * 1000;
/**
 * Per-complexity scaling of the stall/cap budgets. An engineering tuning
 * choice — operators don't have the calibration data to set this better,
 * so it lives in the source, not the policy schema.
 */
const DEFAULT_COMPLEXITY_MULTIPLIERS: Record<string, number> = {
  trivial: 0.5,
  small: 0.75,
  medium: 1,
  large: 2,
};
const LOG_TAIL_CHARS = 2000;

/**
 * Shared implementation for CLI-backed worker runners. A worker invokes an
 * agent CLI headless inside the story's git worktree, then counts commits and
 * — when the repo has an allowed remote — pushes the branch and opens a PR.
 *
 * Subclasses supply only the binary, its args, and a name; the run flow,
 * commit counting, and PR handling live here once.
 */
export abstract class BaseCliWorker implements WorkerRunner {
  /** Default stall window (ms); per-story override comes from the assignment. */
  protected stallMs: number;
  /** Default absolute cap (ms); per-story override comes from the assignment. */
  protected absoluteCapMs: number;
  /** Per-complexity multipliers applied to the defaults above. */
  protected complexityMultipliers: Record<string, number>;
  private openPr: boolean;
  private allowedRemotes?: string[];
  private prStrategy: PrStrategy;
  private reviewAgent?: CodeReviewAgent;
  private reviewStrategy: 'off' | 'comment' | 'block-and-revise';
  private maxReviewRevisions: number;
  private reviewReviseTrigger: 'blockers' | 'any';
  private reviewOrchestrator?: (assignment: WorkerAssignment) => ReviewPassDeps;
  private budgetTokensPerStory?: number;
  private operatorGuidance: 'off' | 'on';
  private sharedContractEnabled: boolean;
  private contextNotesEnabled: boolean;
  private handoffEnabled: boolean;
  private phasesEnabled: boolean;
  /** When true, request + parse the worker self-assessment marker (B1). */
  private adaptiveCostEnabled: boolean;
  /** When true, strip inherited Anthropic API auth from the worker spawn env. */
  private sessionAuth: boolean;
  /** Accumulated worker usage across the spawn (and its revisions). */
  private accumulatedUsage: WorkerUsage | undefined = undefined;

  constructor(opts: CliWorkerOptions = {}) {
    // `timeoutMs` is the legacy single knob; it now seeds the absolute cap so
    // existing callers/tests keep their kill semantics.
    this.absoluteCapMs = opts.absoluteCapMs ?? opts.timeoutMs ?? DEFAULT_ABSOLUTE_CAP_MS;
    this.stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
    this.complexityMultipliers = opts.complexityMultipliers ?? DEFAULT_COMPLEXITY_MULTIPLIERS;
    this.openPr = opts.openPr ?? true;
    this.allowedRemotes = opts.allowedRemotes;
    this.prStrategy = opts.prStrategy ?? 'per-story';
    this.reviewAgent = opts.reviewAgent;
    this.reviewStrategy = opts.reviewStrategy ?? 'off';
    this.maxReviewRevisions = opts.maxReviewRevisions ?? 2;
    this.reviewReviseTrigger = opts.reviewReviseTrigger ?? 'blockers';
    this.reviewOrchestrator = opts.reviewOrchestrator;
    this.budgetTokensPerStory = opts.budgetTokensPerStory;
    this.operatorGuidance = opts.operatorGuidance ?? 'off';
    this.sharedContractEnabled = (opts.sharedContract ?? 'off') === 'on';
    this.contextNotesEnabled = (opts.contextNotes ?? 'off') === 'on';
    // Default 'telemetry' matches the Supervisor's handoffMode default: when
    // no caller specifies, the worker prompt includes the handoff doc on
    // resume. Set 'off' explicitly to opt out.
    this.handoffEnabled = (opts.handoff ?? 'telemetry') !== 'off';
    this.phasesEnabled = (opts.phases ?? 'off') === 'on';
    this.adaptiveCostEnabled = (opts.adaptiveCost ?? 'off') === 'on';
    this.sessionAuth = (opts.workerAuth ?? 'inherit') === 'session';
  }

  /**
   * Parses one line of the worker subprocess's stdout. Default: treat the line
   * as a human-readable text chunk. Subclasses (ClaudeCodeWorker) override to
   * parse JSON-line events emitted by `--output-format stream-json`, returning
   * usage snapshots and decision-trace fragments when present.
   *
   * Returns:
   *   - `humanText` to surface via `onOutput('stdout', ...)`
   *   - `usage` to update the running cumulative usage (Epic 16)
   *   - `traces` to record as agent reasoning events (decision_traces table)
   */
  protected parseStreamLine(line: string): {
    humanText?: string;
    /**
     * The FULL, untruncated assistant message text — used to scan for the
     * self-assessment marker (B1). `humanText` is truncated for display and a
     * stream-json backend's raw stdout has the marker's JSON escaped, so neither
     * is safe to parse the marker from. Stream backends set this from the
     * decoded text blocks. The default treats the whole line as assistant text.
     */
    assistantText?: string;
    usage?: WorkerUsage;
    traces?: Array<{ kind: string; subject?: string; rationale: string }>;
    /** Executed model id from the system/init event; undefined for backends that don't emit it. */
    model?: string;
  } {
    return { humanText: line, assistantText: line };
  }

  private resetUsage(): void {
    this.accumulatedUsage = undefined;
  }

  /** The agent binary to invoke (e.g. "claude", "cursor-agent"). */
  protected abstract binary(): string;
  /**
   * Args for the binary; the worker prompt is supplied on stdin. Receives the
   * assignment so a backend can derive args from the worktree (e.g.
   * ClaudeCodeWorker appends `--mcp-config <worktree>/.cursor/mcp.json`).
   */
  protected abstract agentArgs(assignment: WorkerAssignment): string[];

  /**
   * True when this backend keeps stdin open for follow-on user-messages
   * after the initial prompt (e.g. `claude --input-format stream-json`).
   * When false, stdin is closed immediately after the initial write
   * (today's behavior for cursor-cli and the mock). When true,
   * `buildInputChannel` returns a real channel and stdin stays open
   * until `isTerminalLine` recognizes the agent's terminal event.
   */
  protected streamingInput(): boolean {
    return false;
  }

  /**
   * Format the initial prompt before writing it to stdin. Default returns
   * the raw text — preserves cursor-cli / mock byte-identical behavior.
   * `ClaudeCodeWorker` overrides to wrap as a JSONL `user` event when
   * `--input-format stream-json` is in play. Bench discipline: when
   * `streamingInput()` is false this MUST return the raw prompt.
   */
  protected formatInitialPrompt(prompt: string): string {
    return prompt;
  }

  /**
   * Build the per-spawn input channel that the Supervisor uses to push
   * operator guidance into the live conversation. Default no-op channel
   * — backends without streaming-input support gracefully fall back to
   * today's per-revision file pickup.
   */
  protected buildInputChannel(_child: ChildProcess): WorkerInputChannel {
    return NO_OP_CHANNEL;
  }

  /**
   * Did the parsed stdout line indicate terminal completion? When true,
   * `spawnAgent` closes stdin so the held-open streaming-input session
   * shuts down cleanly. Defaults to never-terminal (the legacy stdin-
   * closed-immediately path applies). `ClaudeCodeWorker` overrides to
   * detect `{"type":"result"}`. Receives the raw JSONL line so the
   * subclass can do its own cheap parse without polluting
   * `parseStreamLine`'s return shape (per Amelia review P0).
   */
  protected isTerminalLine(_rawLine: string): boolean {
    return false;
  }

  /**
   * When true, the worker prompt gains a sentence telling the agent to
   * poll `loom_pull_guidance` between major tool calls. Used for backends
   * (cursor-cli) that can't accept mid-spawn stdin injection. Default
   * false so `claude-cli` keeps a byte-identical bench-baseline prompt.
   */
  protected pullGuidanceHint(): boolean {
    return false;
  }

  /**
   * Spawns the agent subprocess. Defaults to `child_process.spawn`. Exists as
   * a seam so tests can inject a fake child and drive `spawnAgent`'s stdout /
   * guard wiring deterministically without launching a real CLI (no real
   * cursor-agent, no sleeps). Production behaviour is unchanged.
   */
  protected spawnChild(
    bin: string,
    args: string[],
    opts: SpawnOptions
  ): ChildProcessWithoutNullStreams {
    return spawn(bin, args, opts) as ChildProcessWithoutNullStreams;
  }

  /**
   * Environment for the worker subprocess. With workerAuth='session' the
   * inherited ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed so the
   * spawned CLI falls back to the operator's `claude login` session rather
   * than billing an inherited API key (e.g. the outer agent's credits). The
   * default 'inherit' returns the parent env unchanged — byte-identical to
   * the prior behaviour.
   */
  protected workerEnv(): NodeJS.ProcessEnv {
    if (!this.sessionAuth) return process.env;
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }

  /**
   * Builds the progress-aware timeout guard for a spawn. Defaults to a real
   * `WorkerTimeoutGuard`. Exists as a seam so tests can inject the guard's
   * clock / timer sources (and a recording `killProcess`) to pin the
   * survive-past-stall and kill-at-stall behaviours under faked time without
   * touching the activity wiring. Production behaviour is unchanged.
   */
  protected createGuard(opts: WorkerTimeoutGuardOptions): WorkerTimeoutGuard {
    return new WorkerTimeoutGuard(opts);
  }

  /**
   * Builds the injectable clock + jitter source for the infra auto-retry
   * controller (story-006-003). Defaults to real time and a process-seeded
   * `mulberry32` PRNG so distinct workers de-synchronise their retries. Exists
   * purely as a test seam: tests override it to drive `waitBeforeRetry`'s
   * backoff through a fake clock with a fixed seed — asserting the schedule and
   * ±20% jitter with ZERO real sleeps. Production behaviour is unchanged.
   */
  protected createInfraRetrySources(): { clock: RetryClock; jitter: JitterSource } {
    return {
      clock: new SystemRetryClock(),
      // A per-spawn seed mixed from the wall clock + a random draw: two workers
      // that fail at the same instant still draw different jitter sequences.
      jitter: new Mulberry32((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0),
    };
  }

  /**
   * Wraps a single `spawnAgent` call in the bounded infra auto-retry loop
   * (story-006-003). On each attempt:
   *
   *   1. spawn the agent in the SAME worktree (an infra fault is transient —
   *      re-entering in place often just works);
   *   2. classify the outcome via the story-006-002 classifier;
   *   3. emit `onAttemptClassified` with the verdict + the retry attempt index;
   *   4. if it is an `infra_failure` and we are under the attempt cap, wait the
   *      scheduled (jittered) backoff and retry; otherwise return the outcome.
   *
   * Crucially, this loop NEVER touches the story's failure budget (ADR-3/ADR-5):
   * an infra retry re-enters the same worktree and is free. The single
   * budget-counting point stays where it already is — `run()` returns ONE
   * WorkerResult per call, and the Supervisor counts that once. The returned
   * outcome carries the final attempt's classification so `run()`'s existing
   * terminal-failure handling sees the last (real) result.
   */
  protected async spawnWithInfraRetry(
    assignment: WorkerAssignment,
    prompt: string
  ): Promise<
    SpawnOutcome & {
      timeoutReason?: TimeoutKillReason;
      budgetExhausted?: boolean;
      attemptClass: AttemptClass;
      signature?: InfraSignature;
      /** Executed model id from the system/init event; absent when not emitted. */
      model?: string;
    }
  > {
    const { clock, jitter } = this.createInfraRetrySources();
    const controller = new InfraRetryController({ clock, jitter });
    let retryAttempt = 0;

    for (;;) {
      const outcome = await this.spawnAgent(assignment, prompt);
      const classification = suspendAwareClassification(outcome);
      assignment.onAttemptClassified?.({
        attemptClass: classification.class,
        ...(classification.signature !== undefined
          ? { signature: classification.signature }
          : {}),
        retryAttempt,
      });

      const isInfra = classification.class === 'infra_failure';
      if (!isInfra || !controller.shouldRetry(retryAttempt)) {
        return {
          ...outcome,
          attemptClass: classification.class,
          ...(classification.signature !== undefined
            ? { signature: classification.signature }
            : {}),
        };
      }

      await controller.waitBeforeRetry(retryAttempt);
      retryAttempt += 1;
    }
  }

  async run(assignment: WorkerAssignment): Promise<WorkerResult> {
    this.resetUsage();

    // ── Implement phase ──────────────────────────────────────────────────
    // The baseline single spawn. When phases are off this is the whole run
    // (byte-identical to the pre-phases behavior); when on it is phase 1 of 2.
    const prompt = buildWorkerPrompt(assignment, {
      includeOperatorGuidance: this.operatorGuidance === 'on',
      includeSharedContract: this.sharedContractEnabled,
      includeUpstreamContext: this.contextNotesEnabled,
      pullGuidanceHint: this.pullGuidanceHint(),
      includeHandoff: this.handoffEnabled,
      requestSelfAssessment: this.adaptiveCostEnabled,
      ...(this.phasesEnabled ? { phase: 'implement' as const } : {}),
    });
    // The single integration seam for epic-006's infra auto-retry: a detected
    // infra_failure retries in-place on the fixed backoff schedule WITHOUT
    // decrementing the story's failure budget — this returns one outcome per
    // run() call, exactly as the bare spawnAgent did, so the budget is still
    // counted once downstream.
    const proc = await this.spawnWithInfraRetry(assignment, prompt);
    let logTail = tail(proc.output, LOG_TAIL_CHARS);
    // Executed model id from the implement spawn's system/init event.
    // Propagated to WorkerResult so the Supervisor can upgrade agents.model.
    const executedModel = proc.model;

    // Parse the worker's self-assessment marker before any early return.
    // Prefer the decoded assistant text — a stream-json backend's raw `output`
    // has the marker's JSON escaped, so parsing that would always fail. Fall
    // back to `output` for non-stream backends (mock) where it's clean text.
    // Observe-only: surfaced on the result for the signal ledger (B1).
    const selfAssessment: SelfAssessment | undefined = this.adaptiveCostEnabled
      ? parseSelfAssessment(proc.assistantText ?? proc.output)
      : undefined;

    const implementFailure = this.terminalFailureResult(assignment, proc, logTail);
    if (implementFailure) return { ...implementFailure, ...(executedModel ? { model: executedModel } : {}) };

    const commitCount = this.countCommits(assignment);
    if (commitCount === 0) {
      // Two distinct shapes get conflated here. An abnormal exit (proc.code != 0)
      // is always a real failure — the worker crashed or hit a budget kill before
      // it could finish. A normal exit (proc.code === 0) with 0 commits, on the
      // other hand, is often an *audit-style* story the planner decomposed —
      // "identify the right code paths" / "reproduce the bug locally" / "decide
      // between approaches A and B" — where the worker correctly produces no
      // diff. Marking those `failed` cascades-blocks every dependent story (the
      // implementation work), and the epic dies before any code is written. Seen
      // on astropy-7746 across three SWE-bench Lite iters: a clean audit
      // completion blocked four follow-on implementation stories.
      //
      // Treat the normal-exit case as `done`. The worker's findings still flow
      // forward via the handoff doc and the cross-story "what I built" note
      // (Supervisor writes the latter on SUCCESS), so the implementation story
      // downstream gets the context it needs. False positives — a worker that
      // gives up gracefully without code — are caught downstream when the
      // dependent story fails for lack of foundation, and the audit log still
      // records the empty completion verbatim.
      if (proc.code === 0) {
        return {
          status: 'done',
          commitCount: 0,
          summary: this.completionSummary(assignment, 0, {}),
          logTail,
          ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
          ...(selfAssessment ? { selfAssessment } : {}),
          ...(executedModel ? { model: executedModel } : {}),
        };
      }
      return {
        status: 'failed',
        commitCount: 0,
        summary: `Worker exited with code ${proc.code} and made no commits.`,
        logTail,
        ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
        ...(executedModel ? { model: executedModel } : {}),
      };
    }

    // ── Verify phase (policy.agents.phases='on') ─────────────────────────
    // A fresh agent spawn — and therefore a fresh stall/cap timer — whose only
    // job is to run the full build/test suite over the committed implementation
    // and fix failures. Checkpointing + refreshing the handoff at the boundary
    // means a crash during verify resumes from the implement commits rather
    // than losing the story.
    if (this.phasesEnabled) {
      this.checkpointUncommitted(assignment, 'implement-phase');
      assignment.onPhaseBoundary?.({
        phase: 'implement',
        summary: `Implementation committed (${this.countCommits(assignment)} commit(s)). Verifying.`,
      });
      const verifyPrompt = buildWorkerPrompt(assignment, {
        includeOperatorGuidance: this.operatorGuidance === 'on',
        includeSharedContract: this.sharedContractEnabled,
        includeUpstreamContext: this.contextNotesEnabled,
        pullGuidanceHint: this.pullGuidanceHint(),
        phase: 'verify',
      });
      const verifyProc = await this.spawnAgent(assignment, verifyPrompt);
      // verifyProc.model is not read: the executed model was already captured
      // from the implement-phase spawn and is propagated via executedModel.
      logTail = tail(verifyProc.output, LOG_TAIL_CHARS);
      const verifyFailure = this.terminalFailureResult(assignment, verifyProc, logTail);
      if (verifyFailure) return { ...verifyFailure, ...(executedModel ? { model: executedModel } : {}) };
      this.checkpointUncommitted(assignment, 'verify-phase');
      assignment.onPhaseBoundary?.({
        phase: 'verify',
        summary: 'Verification phase complete.',
      });
    }

    // Review pass — after the worker commits, before the PR opens.
    // block-and-revise may re-prompt the worker; the loop updates commitCount.
    const review = await this.runReviewPass(assignment);
    const finalCommitCount = this.countCommits(assignment);

    const pr = this.maybeOpenPr(assignment, review);
    return {
      status: 'done',
      commitCount: finalCommitCount,
      prUrl: pr.url,
      summary: this.completionSummary(assignment, finalCommitCount, pr),
      logTail,
      review,
      ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
      ...(selfAssessment ? { selfAssessment } : {}),
      ...(executedModel ? { model: executedModel } : {}),
    };
  }

  /**
   * DAG-accurate completion copy. Driven by `{ commitCount, hasDependents }`
   * rather than an unconditional template:
   *
   *  - `commitCount` decides whether the copy acknowledges that code changed
   *    (>0) or that the story finished without a diff (0, e.g. an audit story).
   *  - `assignment.hasDependents` (set by the Supervisor from the epic DAG)
   *    decides whether the copy may reference downstream work. A terminal
   *    story (`false`) NEVER names or implies a nonexistent downstream story;
   *    `true` may note that dependents will build on this. When the field is
   *    unset (mock + bench workers, which don't carry the DAG), the copy makes
   *    NO downstream claim — additive/optional means no crash and no invention.
   */
  private completionSummary(
    assignment: WorkerAssignment,
    commitCount: number,
    pr: { url?: string; note?: string }
  ): string {
    const head =
      commitCount > 0
        ? `Implemented ${assignment.storyId} in ${commitCount} commit(s).`
        : `Completed ${assignment.storyId} without code changes.`;

    const where = pr.url
      ? `PR: ${pr.url}`
      : pr.note ?? `Branch ${assignment.branchName} ready for review.`;

    // Downstream wording is gated strictly on the DAG. Only an explicit
    // `true` may reference downstream stories; `false` (terminal) and unset
    // (no DAG) both stay silent so the copy never invents a dependent.
    let downstream = '';
    if (assignment.hasDependents === true) {
      downstream =
        commitCount > 0
          ? ' Dependent stories can build on this work.'
          : ' Dependent stories proceed with the handoff context.';
    } else if (assignment.hasDependents === false) {
      downstream = ' No downstream stories depend on this one.';
    }

    return `${head} ${where}${downstream}`;
  }

  /**
   * Integrator capability (PR 3b): run a bounded agent in the integration
   * worktree to resolve a story merge that was left mid-conflict. Reuses the
   * same spawn + WorkerTimeoutGuard machinery as a story run, but skips all the
   * story bookkeeping (commit counting, review, PR) — loom inspects the tree,
   * commits the merge, and re-runs the gate itself. The agent only edits the
   * conflicted files; it never commits.
   */
  async resolveConflicts(task: ConflictResolution): Promise<ConflictResolutionResult> {
    const prompt = buildIntegratorPrompt(task);
    // A minimal synthetic assignment so `spawnAgent` can run a freeform task in
    // the integration worktree. Explicit stall/cap bypass the complexity-
    // multiplier path; the story fields are unused beyond the worktree + sinks.
    const story: Story = {
      id: task.storyId,
      title: `integrate ${task.storyId}`,
      description: '',
      acceptance_criteria: ['n/a'],
      estimated_complexity: 'medium',
      dependencies: [],
    };
    const assignment: WorkerAssignment = {
      storyId: task.storyId,
      epicId: task.epicId,
      story,
      worktreePath: task.cwd,
      branchName: `epic/${task.epicId}`,
      baseSha: '',
      projectRoot: task.cwd,
      skills: [],
      stallMs: task.stallMs ?? this.stallMs,
      absoluteCapMs: task.absoluteCapMs ?? this.absoluteCapMs,
      onOutput: task.onOutput,
      onPid: task.onPid,
    };
    const proc = await this.spawnAgent(assignment, prompt);
    const logTail = tail(proc.output, LOG_TAIL_CHARS);
    return {
      ok: !proc.spawnError && !proc.timedOut && proc.code === 0,
      timedOut: proc.timedOut,
      logTail,
    };
  }

  /**
   * Maps a spawn's abnormal exit (spawn error, budget exhaustion, timeout) to a
   * failed WorkerResult, checkpointing uncommitted work first so the abrupt
   * kill leaves a resumable commit instead of discarding the in-flight edits.
   * Returns `null` when the spawn exited normally and the run should continue.
   * Shared across phases so implement and verify get identical safety handling.
   */
  private terminalFailureResult(
    assignment: WorkerAssignment,
    proc: {
      code: number | null;
      output: string;
      timedOut: boolean;
      timeoutReason?: TimeoutKillReason;
      spawnError?: string;
      budgetExhausted?: boolean;
    },
    logTail: string
  ): WorkerResult | null {
    if (proc.spawnError) {
      return {
        status: 'failed',
        commitCount: this.countCommits(assignment),
        summary: `Could not start the worker (${this.binary()}): ${proc.spawnError}`,
        logTail,
        ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
      };
    }
    if (proc.budgetExhausted) {
      // Preserve any uncommitted work before reporting failure — the kill is
      // abrupt and would otherwise discard the edits in flight.
      this.checkpointUncommitted(assignment, 'budget-exhausted');
      return {
        status: 'failed',
        commitCount: this.countCommits(assignment),
        summary:
          `Worker halted — token budget of ${this.budgetTokensPerStory} exceeded ` +
          `(used ~${this.accumulatedUsage?.totalTokens ?? '?'}). ` +
          'Uncommitted work checkpointed for resume.',
        logTail,
        budgetExhausted: true,
        ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
      };
    }
    if (proc.timedOut) {
      // Commit-on-timeout: convert the catastrophic loss (the whole worktree
      // discarded on SIGTERM) into a resumable wip commit.
      this.checkpointUncommitted(assignment, `timeout-${proc.timeoutReason ?? 'cap'}`);
      const why =
        proc.timeoutReason === 'stall'
          ? `stalled (no output) for ${Math.round(this.stallMs / 60000)} minutes`
          : `exceeded the ${Math.round(this.absoluteCapMs / 60000)}-minute cap`;
      return {
        status: 'failed',
        commitCount: this.countCommits(assignment),
        summary: `Worker timed out — ${why}. Uncommitted work checkpointed for resume.`,
        logTail,
        ...(this.accumulatedUsage ? { usage: this.accumulatedUsage } : {}),
      };
    }
    return null;
  }

  /**
   * Runs the configured review strategy. Returns an outcome describing what
   * happened — `blocked` if blockers persisted past `maxReviewRevisions`,
   * `commented` if non-blocker findings exist, `passed` if clean, `skipped`
   * if review is `off` or no agent was configured.
   */
  private async runReviewPass(assignment: WorkerAssignment): Promise<ReviewOutcome> {
    if (this.reviewStrategy === 'off' || (!this.reviewAgent && !this.reviewOrchestrator)) {
      return { status: 'skipped', blockerCount: 0, totalCount: 0, summary: '', revisions: 0 };
    }
    try {
      return await this.runReviewPassUnsafe(assignment);
    } catch (err) {
      // Reviewer crashes do NOT cascade-fail the worker (#21).
      // Worker commits are intact on the story branch; degrade to an
      // 'errored' review outcome so the supervisor records the story as
      // done-with-review-errored rather than failed.
      const msg = (err as Error).message ?? 'unknown reviewer failure';
      return {
        status: 'errored',
        blockerCount: 0,
        totalCount: 0,
        summary:
          `Review failed: ${msg}. Worker commits intact on ${assignment.branchName}; ` +
          'PR will open without review findings.',
        revisions: 0,
      };
    }
  }

  private async runReviewPassUnsafe(assignment: WorkerAssignment): Promise<ReviewOutcome> {
    if (this.reviewStrategy === 'off') {
      return { status: 'skipped', blockerCount: 0, totalCount: 0, summary: '', revisions: 0 };
    }
    // Review Forge path (epic-001 story-003): when an orchestrator hook is
    // wired, fan out to the three reviewers, union+dedupe, and revise while a
    // blocker/high finding remains. Otherwise the legacy single-agent pass.
    if (this.reviewOrchestrator) {
      return this.runOrchestratedReviewPass(assignment, this.reviewOrchestrator(assignment));
    }
    if (!this.reviewAgent) {
      return { status: 'skipped', blockerCount: 0, totalCount: 0, summary: '', revisions: 0 };
    }
    let revisions = 0;
    let lastFindings: ReviewFinding[] = [];
    let lastSummary = '';

    // First review pass.
    let report = await this.singleReviewPass(assignment);
    lastFindings = report.findings;
    lastSummary = report.summary;

    // block-and-revise loop — re-prompt the worker with the review and re-review.
    // Trigger condition depends on policy.agents.review_revise_trigger:
    //   'blockers' (default) — only blocker-severity findings re-prompt
    //   'any'                — any non-empty finding re-prompts. Bounded by
    //                          maxReviewRevisions so 'any' can't soft-lock.
    const shouldRevise = (findings: ReviewFinding[]): boolean =>
      this.reviewReviseTrigger === 'any'
        ? findings.length > 0
        : findings.some((f) => f.severity === 'blocker');

    while (
      this.reviewStrategy === 'block-and-revise' &&
      revisions < this.maxReviewRevisions &&
      shouldRevise(lastFindings)
    ) {
      revisions += 1;
      const revisionContext = renderFindingsForRevision(lastFindings);
      const revisePrompt = buildWorkerPrompt(assignment, {
        revisionContext,
        includeOperatorGuidance: this.operatorGuidance === 'on',
        includeSharedContract: this.sharedContractEnabled,
        includeUpstreamContext: this.contextNotesEnabled,
        pullGuidanceHint: this.pullGuidanceHint(),
      });
      const proc = await this.spawnAgent(assignment, revisePrompt);
      if (proc.spawnError || proc.timedOut) break;
      report = await this.singleReviewPass(assignment);
      lastFindings = report.findings;
      lastSummary = report.summary;
    }

    const blockerCount = lastFindings.filter((f) => f.severity === 'blocker').length;
    const totalCount = lastFindings.length;
    let status: ReviewOutcome['status'];
    if (blockerCount > 0 && this.reviewStrategy === 'block-and-revise') {
      status = 'blocked';
    } else if (totalCount > 0) {
      status = 'commented';
    } else {
      status = 'passed';
    }
    return {
      status,
      blockerCount,
      totalCount,
      summary: lastSummary || 'Review produced no summary.',
      commentBody: lastFindings.length > 0 ? renderReviewComment(lastFindings, lastSummary) : undefined,
      revisions,
    };
  }

  /**
   * Review Forge orchestrated pass (epic-001 story-003). Drives the bounded
   * review/revise loop via the shared orchestrator: each pass unions the three
   * reviewers' findings, dedupes them, and a `blocker`/`high` survivor triggers
   * another worker revision until the `maxReviewRevisions` cap. The cap lives
   * in {@link runReviewLoop}; this method only translates the final pass into a
   * `ReviewOutcome` for the rest of the worker flow.
   */
  private async runOrchestratedReviewPass(
    assignment: WorkerAssignment,
    deps: ReviewPassDeps
  ): Promise<ReviewOutcome> {
    const blockAndRevise = this.reviewStrategy === 'block-and-revise';
    const { finalPass, revisions } = await runReviewLoop({
      maxRevisions: this.maxReviewRevisions,
      blockAndRevise,
      runPass: (revisionIndex) =>
        runReviewPass(this.buildReviewerInput(assignment), {
          story_id: assignment.storyId,
          epic_id: assignment.epicId,
          revision_index: revisionIndex,
          reviewers: deps.reviewers,
          audit: deps.audit,
          warn: deps.warn,
        }),
      revise: async (pass) => {
        const revisePrompt = buildWorkerPrompt(assignment, {
          revisionContext: renderOrchestratedFindings(pass.findings),
          includeOperatorGuidance: this.operatorGuidance === 'on',
          includeSharedContract: this.sharedContractEnabled,
          includeUpstreamContext: this.contextNotesEnabled,
          pullGuidanceHint: this.pullGuidanceHint(),
        });
        const proc = await this.spawnAgent(assignment, revisePrompt);
        return !(proc.spawnError || proc.timedOut);
      },
    });

    const findings = finalPass.findings;
    const blockerCount = findings.filter(
      (f) => f.severity === 'blocker' || f.severity === 'high'
    ).length;
    const totalCount = findings.length;
    let status: ReviewOutcome['status'];
    if (blockAndRevise && finalPass.triggers_revision) {
      status = 'blocked';
    } else if (totalCount > 0) {
      status = 'commented';
    } else {
      status = 'passed';
    }
    const summary = renderOrchestratedSummary(finalPass);
    return {
      status,
      blockerCount,
      totalCount,
      summary,
      commentBody:
        findings.length > 0 ? renderOrchestratedComment(findings, summary) : undefined,
      revisions,
    };
  }

  /** Builds the reviewer input (diff, changed files, story context) for a pass. */
  private buildReviewerInput(assignment: WorkerAssignment): ReviewerInput {
    return {
      diff: this.workerDiff(assignment),
      changed_files: this.changedFiles(assignment),
      story_context: [
        `Story ${assignment.storyId}: ${assignment.story.title}`,
        assignment.story.description,
        'Acceptance criteria:',
        ...assignment.story.acceptance_criteria.map((ac) => `- ${ac}`),
      ].join('\n'),
    };
  }

  /** Names of files the worker touched on its story branch since baseSha. */
  private changedFiles(assignment: WorkerAssignment): string[] {
    const range = assignment.baseSha ? `${assignment.baseSha}..HEAD` : 'HEAD';
    const res = gitSafe(assignment.worktreePath, ['diff', '--name-only', range]);
    if (!res.ok) return [];
    return res.output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Runs the CodeReviewAgent once over the worktree's diff since baseSha. */
  private async singleReviewPass(
    assignment: WorkerAssignment
  ): Promise<{ findings: ReviewFinding[]; summary: string }> {
    const diff = this.workerDiff(assignment);
    if (!this.reviewAgent) return { findings: [], summary: '' };
    const result = await this.reviewAgent.review({
      story: {
        storyId: assignment.storyId,
        title: assignment.story.title,
        description: assignment.story.description,
        acceptanceCriteria: assignment.story.acceptance_criteria,
      },
      diff,
    });
    return result.report;
  }

  /** Returns the unified diff for the worker's commits on its story branch. */
  private workerDiff(assignment: WorkerAssignment): string {
    const range = assignment.baseSha ? `${assignment.baseSha}..HEAD` : 'HEAD';
    const res = gitSafe(assignment.worktreePath, ['diff', range]);
    return res.ok ? res.output : '';
  }

  /**
   * Spawns the agent subprocess and parses its stdout line-by-line through
   * `parseStreamLine`. Subclasses that override `parseStreamLine` (e.g.
   * ClaudeCodeWorker for `--output-format stream-json`) get cumulative usage
   * captured here, and the budget gate (`budgetTokensPerStory`) terminates
   * the process when usage crosses the configured cap.
   *
   * When `streamingInput()` is true, stdin stays open after the initial
   * prompt write so the per-spawn `WorkerInputChannel` can push follow-on
   * operator messages (live agent guidance). stdin is closed when a parsed
   * line is recognised as terminal by `isTerminalLine`. The legacy
   * "close stdin immediately" behaviour is preserved when `streamingInput()`
   * returns false (cursor-cli, mock).
   *
   * Exposed as `protected` so tests can subclass and stub the subprocess
   * invocation without spinning up a real CLI.
   */
  protected spawnAgent(
    assignment: WorkerAssignment,
    prompt: string
  ): Promise<
    SpawnOutcome & {
      timeoutReason?: TimeoutKillReason;
      budgetExhausted?: boolean;
      /**
       * Sleep-proofing (story-006-005): true when the WorkerTimeoutGuard saw
       * the machine suspend during this spawn. Surfaced so `spawnWithInfraRetry`
       * can route a worker that died around the sleep through the infra-retry
       * path even when its bare outcome wouldn't otherwise classify as infra.
       */
      suspendDetected?: boolean;
      /** Executed model id from the system/init event; absent when not emitted. */
      model?: string;
    }
  > {
    const { worktreePath: cwd, onOutput, onPid, onTrace } = assignment;
    const streaming = this.streamingInput();
    // Per-story budget: an explicit assignment override wins; otherwise scale
    // the worker defaults by the story's complexity multiplier.
    const mult = this.complexityMultipliers[assignment.story.estimated_complexity] ?? 1;
    const stallMs = assignment.stallMs ?? Math.round(this.stallMs * mult);
    const absoluteCapMs = assignment.absoluteCapMs ?? Math.round(this.absoluteCapMs * mult);

    // Capture pre-spawn usage so we can correctly accumulate across
    // multiple spawns (block-and-revise revisions, the verify phase). Within
    // a single CLI invocation, stream-json emits cumulative session totals —
    // so `sessionUsage` REPLACES per parsed event — but `accumulatedUsage`
    // tracks the sum across every spawn the worker has made for this story.
    // Without this, the prior spawn's tokens / cost / request_count were
    // silently discarded when a revision spawn started.
    const preSpawnUsage = this.accumulatedUsage;

    return new Promise((resolve) => {
      let output = '';
      // Decoded assistant text (untruncated) for self-assessment parsing (B1).
      let assistantText = '';
      let timedOut = false;
      let timeoutReason: TimeoutKillReason | undefined;
      let budgetExhausted = false;
      // Sleep-proofing (story-006-005): set when the guard detects the machine
      // slept mid-spawn. The worker is NOT killed for the slept gap (timers
      // re-arm from resume); the flag lets `spawnWithInfraRetry` route a worker
      // that DID die around the sleep through the shared infra-retry path.
      let suspendDetected = false;
      // Set when the backend emits a system/init event with a model field.
      let executedModel: string | undefined;
      let settled = false;
      // Loudness gate (story-006-002 / ADR-2): set the instant the child emits
      // its first stdout/stderr byte. A worker that spoke and then exited
      // non-zero is a real work failure and can never be reclassified as infra.
      let producedOutput = false;
      // Stdout is parsed line-by-line; carry-over for partial lines.
      let stdoutCarry = '';
      // Within a spawn, stream-json events carry SESSION-CUMULATIVE usage —
      // each new event REPLACES the prior session totals (it's the running
      // sum for the current CLI invocation). Re-folding with `preSpawnUsage`
      // on every event keeps `accumulatedUsage` correct as the running
      // story-cumulative total across spawns. Cheap arithmetic.
      const applySessionUsage = (next: WorkerUsage): void => {
        this.accumulatedUsage = preSpawnUsage
          ? mergeWorkerUsage(preSpawnUsage, next)
          : next;
      };

      // `detached: true` makes the child its own process-group leader so the
      // guard can SIGTERM/SIGKILL the whole tree (the agent's test runner,
      // build, etc.), not just the immediate CLI process.
      const child = this.spawnChild(this.binary(), this.agentArgs(assignment), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: this.workerEnv(),
      });
      if (typeof child.pid === 'number') onPid?.(child.pid);

      // Progress-aware timeout: resets on output activity, kills on stall or
      // absolute cap, escalates SIGTERM -> SIGKILL. Replaces the old blunt
      // single 30-min wall-clock SIGTERM.
      const guard = this.createGuard({
        stallMs,
        absoluteCapMs,
        getPid: () => (typeof child.pid === 'number' ? child.pid : undefined),
        onKill: (reason) => {
          timedOut = true;
          timeoutReason = reason;
        },
        onWarn: (info) => assignment.onTimeoutWarn?.(info),
        // Sleep-proofing (story-006-005): the guard already re-armed its
        // start/activity instants from the resume moment before this fires, so
        // a streaming worker is NOT killed for the slept gap. We only record
        // that a suspend happened so `spawnWithInfraRetry` can route a worker
        // that died around the sleep through the shared infra-retry path.
        onSuspendDetected: () => {
          suspendDetected = true;
        },
      });
      guard.start();

      // Build the operator-guidance input channel and hand it to the
      // assignment owner (the Supervisor). Channel is no-op for backends
      // without streaming-input support.
      const channel = this.buildInputChannel(child);
      assignment.onChannel?.(channel);

      const closeStdinIfOpen = (): void => {
        if (child.stdin && !child.stdin.writableEnded) {
          try { child.stdin.end(); } catch {}
        }
      };

      const processLines = (chunk: string): void => {
        const text = stdoutCarry + chunk;
        const parts = text.split('\n');
        stdoutCarry = parts.pop() ?? '';
        for (const line of parts) {
          if (line.length === 0) continue;
          const parsed = this.parseStreamLine(line);
          if (parsed.humanText !== undefined && parsed.humanText.length > 0) {
            onOutput?.(parsed.humanText + '\n', 'stdout');
          }
          if (parsed.assistantText && parsed.assistantText.length > 0) {
            assistantText += parsed.assistantText + '\n';
          }
          if (parsed.usage) {
            applySessionUsage(parsed.usage);
            // Budget is per-story (cumulative across revisions), so check the
            // running total — not just this spawn's session — against the cap.
            if (
              this.budgetTokensPerStory !== undefined &&
              (this.accumulatedUsage?.totalTokens ?? 0) > this.budgetTokensPerStory
            ) {
              budgetExhausted = true;
              guard.terminate('budget');
            }
          }
          if (parsed.traces && onTrace) {
            for (const t of parsed.traces) {
              onTrace(t);
            }
          }
          // Capture the executed model on the first system/init event; ignore later ones.
          if (parsed.model !== undefined && executedModel === undefined) {
            executedModel = parsed.model;
          }
          // Streaming-input backends keep stdin open until the agent
          // emits its terminal event. Closing stdin tells the held-open
          // session to flush + exit (otherwise the subprocess would
          // wait for another user message forever).
          if (streaming && this.isTerminalLine(line)) {
            closeStdinIfOpen();
          }
        }
      };

      child.stdout.on('data', (d) => {
        guard.recordActivity();
        producedOutput = true;
        const chunk = d.toString();
        output += chunk;
        processLines(chunk);
      });
      child.stderr.on('data', (d) => {
        guard.recordActivity();
        producedOutput = true;
        const chunk = d.toString();
        output += chunk;
        onOutput?.(chunk, 'stderr');
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        guard.stop();
        // Defensive — universal stdin close + channel close per the
        // review's cleanup-contract recommendation.
        closeStdinIfOpen();
        channel.close();
        onPid?.(null);
        resolve({
          code: null,
          output,
          assistantText: assistantText || undefined,
          timedOut,
          timeoutReason,
          spawnError: err.message,
          producedOutput,
          suspendDetected,
          model: executedModel,
        });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        guard.stop();
        // Flush trailing carry that did not end in a newline.
        if (stdoutCarry.length > 0) {
          const parsed = this.parseStreamLine(stdoutCarry);
          if (parsed.humanText !== undefined && parsed.humanText.length > 0) {
            onOutput?.(parsed.humanText, 'stdout');
          }
          if (parsed.assistantText && parsed.assistantText.length > 0) {
            assistantText += parsed.assistantText + '\n';
          }
          if (parsed.usage) {
            applySessionUsage(parsed.usage);
          }
          stdoutCarry = '';
        }
        closeStdinIfOpen();
        channel.close();
        onPid?.(null);
        resolve({ code, output, assistantText: assistantText || undefined, timedOut, timeoutReason, budgetExhausted, producedOutput, suspendDetected, ...(executedModel ? { model: executedModel } : {}) });
      });

      // Initial prompt write. `formatInitialPrompt` is identity for
      // non-streaming backends (preserves bench-baseline byte equality);
      // ClaudeCodeWorker overrides it to wrap as a JSONL `user` event.
      child.stdin.write(this.formatInitialPrompt(prompt));
      if (!streaming) {
        // Legacy single-shot: close stdin immediately so the subprocess
        // processes the prompt and exits.
        child.stdin.end();
      }
      // When streaming, stdin stays open until `isTerminalLine` fires or
      // any of the termination branches above close it defensively.
    });
  }

  /**
   * Commits any uncommitted work in the worktree so an abrupt kill (timeout or
   * budget) leaves a resumable commit instead of discarding everything.
   *
   * Notes:
   *  - loom runs git directly via `gitSafe` (it is the supervisor, not the
   *    sandboxed worker), so the PreToolUse guardrail hook does not apply.
   *  - We use `--no-verify`: the target repo's pre-commit hooks (lint/type/
   *    test) can reject the commit, and rejecting it would lose the exact work
   *    we are trying to save. This is a deliberate, scoped exception to the
   *    usual "never skip hooks" rule — the wip checkpoint is squashed/redone on
   *    the real retry. The message is clearly marked `[loom] wip` so it is
   *    reviewable and obviously not a finished commit.
   *  - A stale `index.lock` can linger if the killed agent was mid-git; the
   *    child is already dead here, so clearing it is safe. The lock lives in the
   *    real gitdir, which for a `git worktree` is NOT `<worktree>/.git` (that is
   *    a *file* pointing elsewhere) — it is the path `git rev-parse --git-dir`
   *    resolves to (e.g. `<repo>/.git/worktrees/<id>`). Resolving it is what
   *    makes the lock actually findable in production.
   */
  protected checkpointUncommitted(assignment: WorkerAssignment, reason: string): void {
    const dirty = gitSafe(assignment.worktreePath, ['status', '--porcelain']);
    if (!dirty.ok || dirty.output.trim().length === 0) return;
    // Clear a stale index lock left by an interrupted git operation. Resolve
    // the real gitdir first — in a worktree `<worktree>/.git` is a file, so a
    // naive `<worktree>/.git/index.lock` join never matches the actual lock.
    const gitDirRes = gitSafe(assignment.worktreePath, ['rev-parse', '--git-dir']);
    const gitDir = gitDirRes.ok ? gitDirRes.output.trim() : '';
    if (gitDir) {
      const resolvedGitDir = path.isAbsolute(gitDir)
        ? gitDir
        : path.join(assignment.worktreePath, gitDir);
      const lock = path.join(resolvedGitDir, 'index.lock');
      try {
        if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });
      } catch {
        // Best-effort — the add/commit below will surface any real problem.
      }
    }
    gitSafe(assignment.worktreePath, ['add', '-A']);
    gitSafe(assignment.worktreePath, [
      'commit',
      '--no-verify',
      '-m',
      `wip: ${reason} checkpoint [loom]`,
    ]);
  }

  /** Counts commits the worker added on its branch since the branch point. */
  private countCommits(assignment: WorkerAssignment): number {
    const range = assignment.baseSha ? `${assignment.baseSha}..HEAD` : 'HEAD';
    const res = gitSafe(assignment.worktreePath, ['rev-list', '--count', range]);
    return res.ok ? parseInt(res.output, 10) || 0 : 0;
  }

  /** Whether loom may push to a remote, per policy.git.allowed_remotes. */
  private remoteAllowed(url: string): boolean {
    if (this.allowedRemotes === undefined) return true;
    return this.allowedRemotes.some((pattern) => minimatch(url, pattern));
  }

  private maybeOpenPr(
    assignment: WorkerAssignment,
    review?: ReviewOutcome
  ): { url?: string; note?: string } {
    if (!this.openPr) {
      return { note: `Branch ${assignment.branchName} ready (PR creation disabled).` };
    }
    if (this.prStrategy === 'per-epic') {
      return {
        note:
          `Branch ${assignment.branchName} ready locally — per-epic PR ` +
          'strategy: the EpicFinalizer will open one PR for the whole epic.',
      };
    }
    const remote = defaultRemote(assignment.worktreePath);
    if (!remote) {
      return { note: `Branch ${assignment.branchName} ready (repo has no remote).` };
    }

    const url = remoteUrl(assignment.worktreePath, remote);
    if (url && !this.remoteAllowed(url)) {
      return {
        note:
          `Branch ${assignment.branchName} committed; not pushed — remote "${url}" ` +
          'is not in policy.git.allowed_remotes. Add it to enable PRs.',
      };
    }

    const push = gitSafe(assignment.worktreePath, [
      'push',
      '-u',
      remote,
      assignment.branchName,
    ]);
    if (!push.ok) {
      return { note: `Branch committed but push failed: ${push.output}` };
    }

    const title = `${assignment.branchName}: ${assignment.story.title}`;
    try {
      const out = execFileSync(
        'gh',
        [
          'pr',
          'create',
          '--head',
          assignment.branchName,
          '--title',
          title,
          '--body',
          prBody(assignment),
        ],
        { cwd: assignment.worktreePath, encoding: 'utf8' }
      );
      const prUrl = out.trim().split('\n').find((l) => l.startsWith('http'));
      // Attach review findings to the PR as a comment, when present.
      if (prUrl && review?.commentBody) {
        try {
          execFileSync('gh', ['pr', 'comment', prUrl, '--body', review.commentBody], {
            cwd: assignment.worktreePath,
          });
        } catch {
          // Comment failure should not fail the worker — the PR still exists.
        }
      }
      return { url: prUrl };
    } catch {
      return { note: `Branch pushed; open a PR manually for ${assignment.branchName}.` };
    }
  }
}

function renderFindingsForRevision(findings: ReviewFinding[]): string {
  return findings
    .map((f) => {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      const suggestion = f.suggestion ? `\n  Suggestion: ${f.suggestion}` : '';
      return `- [${f.severity}] ${loc} — ${f.issue}${suggestion}`;
    })
    .join('\n');
}

function renderReviewComment(findings: ReviewFinding[], summary: string): string {
  const lines: string[] = [];
  lines.push('## Automated review (loom)');
  if (summary) {
    lines.push('');
    lines.push(summary);
  }
  lines.push('');
  lines.push('### Findings');
  for (const f of findings) {
    const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    lines.push(`- **${f.severity}** ${loc} — ${f.issue}`);
    if (f.suggestion) {
      lines.push(`  - Suggestion: ${f.suggestion}`);
    }
  }
  return lines.join('\n');
}

/** Renders deduped findings as revision context for the worker re-prompt. */
function renderOrchestratedFindings(findings: Finding[]): string {
  return findings
    .map((f) => {
      const loc = f.location.line ? `${f.location.file}:${f.location.line}` : f.location.file;
      const fix = f.suggested_fix ? `\n  Suggestion: ${f.suggested_fix}` : '';
      return `- [${f.severity}] (${f.source}) ${loc} — ${f.description}${fix}`;
    })
    .join('\n');
}

/** A one-line summary of a pass: total findings and a severity tally. */
function renderOrchestratedSummary(pass: ReviewPassResult): string {
  if (pass.findings.length === 0) return 'Review produced no findings.';
  const tally = pass.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const parts = (['blocker', 'high', 'medium', 'low', 'info'] as const)
    .filter((sev) => tally[sev])
    .map((sev) => `${tally[sev]} ${sev}`);
  return `${pass.findings.length} finding(s): ${parts.join(', ')}.`;
}

/** Renders the PR/review comment body for the orchestrated findings. */
function renderOrchestratedComment(findings: Finding[], summary: string): string {
  const lines: string[] = ['## Automated review (loom)'];
  if (summary) {
    lines.push('', summary);
  }
  lines.push('', '### Findings');
  for (const f of findings) {
    const loc = f.location.line
      ? `\`${f.location.file}:${f.location.line}\``
      : `\`${f.location.file}\``;
    lines.push(`- **${f.severity}** (${f.source}) ${loc} — ${f.description}`);
    if (f.suggested_fix) {
      lines.push(`  - Suggestion: ${f.suggested_fix}`);
    }
  }
  return lines.join('\n');
}

function prBody(assignment: WorkerAssignment): string {
  return [
    `## ${assignment.story.title}`,
    '',
    assignment.story.description,
    '',
    '### Acceptance criteria',
    ...assignment.story.acceptance_criteria.map((ac) => `- [ ] ${ac}`),
    '',
    `_Generated by loom — story ${assignment.storyId}, epic ${assignment.epicId}._`,
  ].join('\n');
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(s.length - n);
}

/**
 * Sleep-proofing routing (story-006-005). Classify a spawn outcome, then route
 * a suspend-affected death through the shared infra-retry path:
 *
 *   - First defer to the story-006-002 classifier verbatim. If it already says
 *     `infra_failure` (or a real `work_failure`), keep that verdict — the
 *     loudness invariant (ADR-2) is preserved exactly, so a worker that spoke
 *     and then exited non-zero is NEVER reclassified to infra, suspend or not.
 *   - Otherwise, if the guard detected a machine suspend during this spawn AND
 *     the worker did not exit cleanly, the failure is plausibly the sleep's
 *     fault (the session dropped while suspended, or the worker was killed for
 *     staying silent through the resume). Per ADR-4 we forgive the gap and
 *     re-enter via the infra-retry path with the `connection_loss` signature
 *     (the closest existing infra cause for a suspend-induced session drop).
 *
 * A clean exit (`code === 0`) is always success regardless of a suspend — the
 * worker streamed across the sleep and finished, which is the headline AC.
 */
function suspendAwareClassification(
  outcome: SpawnOutcome & { suspendDetected?: boolean }
): Classification {
  const base = classifyAttempt(outcome);
  if (base.class === 'infra_failure') return base;
  if (!outcome.suspendDetected) return base;
  // Loudness invariant: a worker that produced output and exited non-zero is a
  // real work failure even across a suspend — never reroute it.
  if (outcome.producedOutput && outcome.code !== null && outcome.code !== 0) {
    return base;
  }
  // A clean completion across the sleep is a success, not an infra retry.
  if (outcome.code === 0) return base;
  return { class: 'infra_failure', signature: 'connection_loss' };
}

/**
 * Adds two WorkerUsage records together. `WorkerUsage` differs from `LLMUsage`
 * (which has its own `addUsage`) — it carries a precomputed `totalTokens` and
 * makes `costUsd` / `requestCount` optional. Sum every shared field; an
 * optional field stays `undefined` only when ABSENT on both inputs (so a
 * Cursor session that reports `requestCount` accumulates with one that
 * doesn't, instead of dropping the count on the floor).
 */
export function mergeWorkerUsage(a: WorkerUsage, b: WorkerUsage): WorkerUsage {
  const merged: WorkerUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
  if (a.costUsd !== undefined || b.costUsd !== undefined) {
    merged.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  }
  if (a.requestCount !== undefined || b.requestCount !== undefined) {
    merged.requestCount = (a.requestCount ?? 0) + (b.requestCount ?? 0);
  }
  return merged;
}
