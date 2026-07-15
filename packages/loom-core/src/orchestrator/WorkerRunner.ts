import type { Story, AgentStatus, SelfAssessment } from '../types.js';
import type { Finding } from '../findings/schema.js';
import type { WorkerInputChannel } from './WorkerInputChannel.js';
import type { AttemptClass, InfraSignature } from './resilience/types.js';
import type { TimeoutKillReason } from './WorkerTimeoutGuard.js';

/** A live worker stdout/stderr chunk handler — wired by the Supervisor. */
export type WorkerOutputCallback = (
  chunk: string,
  stream: 'stdout' | 'stderr'
) => void;

/**
 * High-level lifecycle events the Supervisor emits to the caller (CLI / pi).
 * `output` events surface live worker stdout / stderr so a long story is not
 * a black box.
 */
export type WorkerEvent =
  | {
      type: 'dispatched';
      storyId: string;
      agentId: string;
      worktreePath: string;
      branchName: string;
    }
  | {
      type: 'output';
      storyId: string;
      stream: 'stdout' | 'stderr';
      chunk: string;
    }
  | {
      type: 'completed';
      storyId: string;
      status: AgentStatus;
      summary: string;
      commitCount: number;
      prUrl?: string;
    };

export type WorkerEventCallback = (event: WorkerEvent) => void;

/** Everything a worker agent needs to implement one story. */
export interface WorkerAssignment {
  storyId: string;
  epicId: string;
  story: Story;
  /** Absolute path to the story's isolated git worktree. */
  worktreePath: string;
  /** The story's branch, e.g. story/story-001-001. */
  branchName: string;
  /** Commit the branch diverged from — used to count the worker's commits. */
  baseSha: string;
  /** Absolute path to the main project root (for resolving policy, docs). */
  projectRoot: string;
  /**
   * INTEGRATION_BRANCH. 'rolling' means this worktree was
   * branched from the live `epic/<id>` tip (it already contains every story
   * completed before dispatch), which changes the dependency wording in the
   * prompt. 'off'/undefined keeps the legacy first-dependency wording.
   */
  integrationBranch?: 'off' | 'rolling';
  /**
   * Whether any other story in this epic lists this story in its
   * `dependencies[]`. Set by the Supervisor from the full epic DAG — the
   * worker never topo-derives it (it sees only its own story). Drives the
   * completion-copy in `BaseCliWorker.run()`: a terminal story (no
   * dependents) must not claim downstream work that does not exist.
   * Additive/optional: when unset (mock + bench workers), the copy degrades
   * to making no downstream claim at all.
   */
  hasDependents?: boolean;
  /** Skill bodies to inject into the worker's context (Epic 5 populates this). */
  skills: string[];
  /**
   * Per-story silence window (ms) before the stall kill fires. Resolved by the
   * Supervisor from policy + `story.estimated_complexity`. When unset the
   * worker's own default applies. Resets on any output activity.
   */
  stallMs?: number;
  /**
   * Per-story absolute wall-clock ceiling (ms). Resolved by the Supervisor
   * from policy + `story.estimated_complexity`. When unset the worker's own
   * default applies.
   */
  absoluteCapMs?: number;
  /**
   * Optional near-deadline warning sink — invoked once when the worker is
   * approaching its stall/cap deadline so the Supervisor can record a
   * "commit now" audit row and surface it on the dashboard.
   */
  onTimeoutWarn?: (info: { reason: 'stall' | 'cap' | 'budget'; elapsedMs: number; remainingMs: number }) => void;
  /**
   * Optional live output sink — invoked with each stdout/stderr chunk from the
   * underlying agent CLI as it arrives. The worker still returns a final
   * logTail in WorkerResult; this stream is for progress visibility.
   */
  onOutput?: WorkerOutputCallback;
  /**
   * Optional pid sink — invoked with the OS pid right after the underlying
   * subprocess spawns, and again with `null` when it closes. The Supervisor
   * persists this to agents.worker_pid so an out-of-process call (e.g. the
   * MCP `loom_stop_agent` tool) can target the worker directly.
   */
  onPid?: (pid: number | null) => void;
  /**
   * Optional decision-trace sink — invoked when the worker subprocess emits
   * a reasoning event (claude's stream-json thinking blocks become
   * `{kind:'thinking'}` traces; subsequent tool calls emit `tool_intent`
   * with the antecedent rationale). The Supervisor persists these to the
   * `decision_traces` table so an operator can replay WHY the agent did
   * what it did.
   */
  onTrace?: (trace: { kind: string; subject?: string; rationale: string }) => void;
  /**
   * Optional channel sink — invoked once at spawn time with the per-spawn
   * input channel. The Supervisor uses this to push operator guidance
   * (from a fs.watch on `.loom/guidance/<story-id>.md`) into the running
   * worker's stdin mid-spawn. Backends without streaming-input support
   * pass NO_OP_CHANNEL — the existing per-revision pickup keeps working.
   * See docs/research/live-agent-guidance.md.
   */
  onChannel?: (channel: WorkerInputChannel) => void;
  /**
   * Optional phase-boundary sink — invoked by the phased pipeline
   * (PHASES='on') after each phase's agent spawn returns and its
   * work is checkpoint-committed. The Supervisor uses it to refresh the
   * crash-resilient handoff doc mid-run, so a crash between phases (e.g. during
   * verify) still resumes from the committed implement work. No-op when phases
   * are off.
   */
  onPhaseBoundary?: (info: { phase: 'implement' | 'verify'; summary: string }) => void;
  /**
   * Per-story worktree confinement context — the repo slug and worktree path this
   * story is isolated to. Set by the Supervisor at dispatch so guardrail hooks
   * can enforce that writes stay within the story's own worktree and repo.
   * Consumed by story-058-007's repoConfinement guard; optional so existing
   * mock/bench workers that don't inspect it are unaffected.
   * TODO(story-058-007): remove this field if the repoConfinement guard is not landed.
   */
  worktreeContext?: { repoSlug: string; worktreePath: string };
  /**
   * Optional attempt-classification sink (epic-006 story-006-003) — invoked
   * once per spawn inside the infra auto-retry loop with the classifier's
   * verdict and the zero-based retry attempt that produced it. The Supervisor
   * uses it to persist the classification (attempt_class column + audit row)
   * and surface infra retries on the dashboard. Additive like `onTimeoutWarn`;
   * no-op when unset, so the bench-baseline run is unaffected.
   */
  onAttemptClassified?: (info: {
    attemptClass: AttemptClass;
    signature?: InfraSignature;
    retryAttempt: number;
  }) => void;
}

/**
 * Token usage parsed from a worker subprocess's structured output stream
 * (claude --output-format stream-json). Backends that don't emit usage
 * (currently cursor-cli) leave this undefined. (Epic 16 story-016-004.)
 */
export interface WorkerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Sum across all input/output/cache token columns — the budget metric. */
  totalTokens: number;
  /** Cost in USD reported by the CLI, when available. */
  costUsd?: number;
  /**
   * Number of LLM requests this worker session represents — surfaced when
   * the CLI exposes it (cursor-agent JSON typically does; Claude stream-json
   * doesn't currently — we attribute 1 per session in that case). The
   * cursor-cli backend's organizational pricing is per-request, not per
   * token, so this is the meaningful spend signal under that backend.
   */
  requestCount?: number;
}

export interface ReviewOutcome {
  /**
   * - 'skipped'  — review_strategy: 'off' or no reviewer configured
   * - 'passed'   — review ran with no findings (or non-blockers only and
   *               we're not in block-and-revise)
   * - 'commented'— review produced findings but didn't block
   * - 'blocked'  — block-and-revise hit max revisions with blockers
   * - 'errored'  — the reviewer subprocess crashed. The worker's commits
   *               are intact; the story is NOT failed (reliability rule:
   *               reviewer crashes don't cascade-fail the worker). See
   *               #21.
   */
  status: 'passed' | 'commented' | 'blocked' | 'skipped' | 'errored';
  /** Number of blocker findings. */
  blockerCount: number;
  /** Number of all findings (blocker + should-fix + nit). */
  totalCount: number;
  /** One-line review summary from the agent — surfaces in status views. */
  summary: string;
  /** PR-comment-formatted body of the findings, ready to attach to a PR. */
  commentBody?: string;
  /** How many block-and-revise rounds ran (0 means no re-prompt). */
  revisions: number;
  /**
   * The final review pass's structured findings (Review-Forge `Finding[]`).
   * Persisted by the Supervisor so `loom review` can render them. Absent for
   * backends/paths that don't produce structured findings.
   */
  findings?: Finding[];
}

export interface WorkerResult {
  status: 'done' | 'failed';
  /** Number of commits the worker made on the story branch. */
  commitCount: number;
  /** PR URL if one was opened (repo has a remote); absent for local-only repos. */
  prUrl?: string;
  /** One-line human-readable outcome summary. */
  summary: string;
  /** Tail of the worker's output, for the audit log and status view. */
  logTail: string;
  /** Outcome of the post-commit review pass when configured. */
  review?: ReviewOutcome;
  /** Token usage from the worker subprocess (Epic 16); unset for backends that don't emit it. */
  usage?: WorkerUsage;
  /** True when the run was halted by the per-story token cap. */
  budgetExhausted?: boolean;
  /**
   * The worker's post-work self-rating (B1), parsed from its
   * LOOM_SELF_ASSESSMENT marker. Requested only under adaptive cost control;
   * unset when the marker is absent/malformed or adaptive_cost is off. Consumed
   * by the signal ledger (and, later, the cost-tier gating).
   */
  selfAssessment?: SelfAssessment;
  /**
   * Executed model id from the worker's system/init stream event.
   * Set when the backend emits a system/init line with a model field; absent
   * for backends that do not (cursor-cli) or when the worker dies before init.
   * The Supervisor writes this to agents.model, upgrading the requested-model
   * value written at agent-create time.
   */
  model?: string;
  /**
   * Conventions discovered by the worker and emitted via LOOM_CONVENTIONS marker.
   * Present only when epic_buildup is 'on' and the worker emitted a valid marker.
   * Conventions are appended to the build-up store in-process regardless; this
   * field is for audit/ledger purposes only.
   */
  conventions?: string[];

  // ── epic-030 stall-recovery fields ────────────────────────────────────────

  /**
   * Set when a `WorkerTimeoutGuard` kill ended this run ('stall' | 'cap' |
   * 'hung_request'). Undefined on normal exit, spawn error, or budget exhaustion.
   * Consumed by story-030-003 (Supervisor resume predicate) and
   * story-030-004 (StallKillAudit).
   */
  killReason?: TimeoutKillReason;
  /**
   * Label of the last stream event the guard observed before kill
   * (e.g. 'system/status:requesting' | 'assistant/delta' | 'result' | '(none)').
   * '(none)' means the subprocess never emitted a recognized stream event —
   * useful for classifying fully-silent vs hung-request kills. Set alongside
   * `killReason`; undefined when the run was not ended by the guard.
   */
  lastStreamEvent?: string;
  /**
   * True iff a `wip: … [loom]` checkpoint commit was created on the story branch
   * after the guard kill. story-030-003 gates auto-resume on this being true —
   * resuming uncommitted work would lose the in-flight edits.
   */
  checkpointCommitted?: boolean;
}

/**
 * A bounded conflict-resolution task for the integrator (PR 3b). Unlike a
 * story `run`, the agent works in the live integration worktree where a
 * story merge has been LEFT mid-conflict (MERGE_HEAD intact, markers in the
 * tree); its only job is to resolve those markers. loom commits and re-runs
 * the gate afterward — the agent must NOT commit or touch `git merge`.
 */
export interface ConflictResolution {
  /** The integration worktree the merge is conflicted in (`.loom/integration/<epic-id>`). */
  cwd: string;
  epicId: string;
  /** The story whose merge-back conflicted. */
  storyId: string;
  storyTitle: string;
  /** Repo-relative paths git reported as conflicted. */
  conflictedFiles: string[];
  /**
   * Why the previous attempt was rejected (markers left, gate red, …), fed
   * back into the prompt on a retry — the block-and-revise pattern. Absent on
   * the first attempt.
   */
  previousFailure?: string;
  /** Silence window (ms) before the stall kill; falls back to the worker default. */
  stallMs?: number;
  /** Absolute wall-clock ceiling (ms); falls back to the worker default. */
  absoluteCapMs?: number;
  /** Live stdout/stderr sink for operator visibility. */
  onOutput?: WorkerOutputCallback;
  /** pid sink — pid on spawn, null on close (for out-of-process stop). */
  onPid?: (pid: number | null) => void;
}

export interface ConflictResolutionResult {
  /** True when the agent subprocess exited normally (not killed / spawn error). */
  ok: boolean;
  /** True when the agent hit its stall/cap timeout and was killed. */
  timedOut: boolean;
  /** Tail of the agent's output, for the audit log. */
  logTail: string;
}

/**
 * Runs a single story to completion. The mechanism is pluggable:
 *  - ClaudeCodeWorker shells out to the `claude` CLI in the worktree
 *  - MockWorkerRunner returns scripted results for tests
 * The Supervisor depends only on this interface.
 */
export interface WorkerRunner {
  run(assignment: WorkerAssignment): Promise<WorkerResult>;
  /**
   * Optional capability: resolve a left-in-place merge conflict in the
   * integration worktree (PR 3b integrator). Backends that can't run a freeform
   * agent task omit it; the Supervisor then falls back to the loud-block path.
   */
  resolveConflicts?(task: ConflictResolution): Promise<ConflictResolutionResult>;
}
