import type Database from 'better-sqlite3';
import type { WorkerRunner, WorkerAssignment } from './WorkerRunner.js';
import { ClaudeCodeWorker } from './ClaudeCodeWorker.js';
import { CursorAgentWorker } from './CursorAgentWorker.js';
import type { PrStrategy } from './BaseCliWorker.js';
import type { CodeReviewAgent } from '../review/CodeReviewAgent.js';
import type { ReviewPassDeps } from '../review/orchestrator.js';
import { codeReviewReviewer } from '../review/codeReviewAdapter.js';
import { skillReviewer } from '../review/reviewer.js';
import { SOURCE } from '../findings/sources.js';
import { AuditLog } from '../state/AuditLog.js';
import type { LLMClient } from '../llm/LLMClient.js';
import type { ReviewStoryContext } from '../review/types.js';

export type WorkerBackend = 'claude-code' | 'cursor-cli';

export interface WorkerFactoryOptions {
  backend: WorkerBackend;
  /** policy.git.allowed_remotes — gates where loom may push. */
  allowedRemotes: string[];
  /** Cursor model id, used only by the cursor-cli backend. */
  cursorModel?: string;
  /** policy.agents.model — Claude model id for the claude-code worker (`--model`). */
  model?: string;
  /** PR_STRATEGY — workers suppress per-story PRs in 'per-epic' mode. */
  prStrategy?: PrStrategy;
  /** Optional CodeReviewAgent for the post-commit review pass (Epic 18). */
  reviewAgent?: CodeReviewAgent;
  /** REVIEW_STRATEGY — applied after the worker commits. */
  reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
  /** Max revisions for 'block-and-revise'. */
  maxReviewRevisions?: number;
  /** REVIEW_REVISE_TRIGGER — severity threshold for re-prompts. */
  reviewReviseTrigger?: 'blockers' | 'any';
  /** OPERATOR_GUIDANCE — when 'on', worker reads .loom/guidance/<story-id>.md */
  operatorGuidance?: 'off' | 'on';
  /** SHARED_CONTRACT — when 'on', worker prompt prepends .loom/contract/<epic-id>.md */
  sharedContract?: 'off' | 'on';
  /** CONTEXT_NOTES — when 'on', worker prompt appends deps' .loom/context/<dep-id>.md */
  contextNotes?: 'off' | 'on';
  /** STORY_STALL_MINUTES — silence window before the stall kill (ms). */
  stallMs?: number;
  /** STORY_ABSOLUTE_CAP_MINUTES — absolute wall-clock ceiling (ms). */
  absoluteCapMs?: number;
  /** policy.agents.story_timeout_multipliers — per-complexity scaling of the budgets. */
  complexityMultipliers?: Record<string, number>;
  /** policy.agents.handoff — resume-handoff mode for the worker prompt. */
  handoff?: 'off' | 'telemetry' | 'summarized';
  /** PHASES — when 'on', run stories as implement+verify spawns. */
  phases?: 'off' | 'on';
  /** policy.agents.worker_auth — 'session' strips inherited ANTHROPIC_API_KEY from workers. */
  workerAuth?: 'inherit' | 'session';
  /** ADAPTIVE_COST — 'on' requests the worker self-assessment marker (B1). */
  adaptiveCost?: 'on' | 'off';
  /**
   * Runtime reroute active (epic-095): when true, the implement prompt gains the
   * LOOM_TOO_BIG opt-out block. Set by run.ts iff a reroute PM was constructed.
   */
  rerouteEnabled?: boolean;
  /** loom state database — required for the Review Forge orchestrated path (FR-6). */
  db?: Database.Database;
  /** LLM client — presence gates the Review Forge orchestrated path (FR-7). */
  llm?: LLMClient;
  /**
   * HUNG_REQUEST_SECONDS × 1000 — tighter kill bound after the
   * subprocess enters `requesting` state with no stream response. 0 or undefined
   * disables the third budget. Forwarded to WorkerTimeoutGuardOptions.hungRequestMs.
   */
  hungRequestMs?: number;
}

/**
 * Gate + closure for the Review Forge orchestrated path (ADR-002).
 *
 * Returns undefined unless ALL three runtime deps are present AND
 * reviewStrategy==='block-and-revise' (FR-5/FR-7). This single gate is the
 * only availability check — no call site duplicates it.
 *
 * When defined, the returned closure assembles ReviewPassDeps on each
 * assignment: the three-reviewer array, a db-backed AuditSink (ADR-004 —
 * only orchestrator-level rows, not per-reviewer rows), and a warn logger.
 * The `llm` parameter is a presence gate only; the actual reviewer brain is
 * baked into the handlers by registerReviewerSkills() at the call site.
 */
export function buildReviewOrchestrator(deps: {
  db?: Database.Database;
  llm?: LLMClient;
  reviewAgent?: CodeReviewAgent;
  reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
}): ((assignment: WorkerAssignment) => ReviewPassDeps) | undefined {
  if (deps.reviewStrategy !== 'block-and-revise') return undefined;
  if (!deps.db || !deps.llm || !deps.reviewAgent) return undefined;

  const { db, reviewAgent } = deps;

  return (assignment: WorkerAssignment): ReviewPassDeps => {
    const story = assignment.story;
    const storyCtx: ReviewStoryContext = {
      storyId: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptance_criteria,
    };
    return {
      reviewers: [
        codeReviewReviewer(reviewAgent, storyCtx),
        skillReviewer(SOURCE.ADVERSARIAL, {
          db,
          story_id: assignment.storyId,
          epic_id: assignment.epicId,
        }),
        skillReviewer(SOURCE.EDGE_CASE, {
          db,
          story_id: assignment.storyId,
          epic_id: assignment.epicId,
        }),
      ],
      audit: {
        record: (action, detail) => new AuditLog(db).record({ action, detail }),
      },
      warn: (msg, detail?) =>
        console.warn(`[review] ${msg}`, ...(detail ? [detail] : [])),
    };
  };
}

/**
 * Builds the worker runner for the configured backend (policy.agents.worker_backend):
 *  - 'claude-code' — story agents run via the `claude` CLI.
 *  - 'cursor-cli'  — story agents run via Cursor's `cursor-agent` CLI.
 * Both are session-based.
 */
export function createWorker(opts: WorkerFactoryOptions): WorkerRunner {
  const reviewOrchestrator = buildReviewOrchestrator({
    db: opts.db,
    llm: opts.llm,
    reviewAgent: opts.reviewAgent,
    reviewStrategy: opts.reviewStrategy,
  });

  if (opts.backend === 'cursor-cli') {
    return new CursorAgentWorker({
      allowedRemotes: opts.allowedRemotes,
      model: opts.cursorModel,
      prStrategy: opts.prStrategy,
      reviewAgent: opts.reviewAgent,
      reviewStrategy: opts.reviewStrategy,
      maxReviewRevisions: opts.maxReviewRevisions,
      reviewReviseTrigger: opts.reviewReviseTrigger,
      operatorGuidance: opts.operatorGuidance,
      sharedContract: opts.sharedContract,
      contextNotes: opts.contextNotes,
      stallMs: opts.stallMs,
      absoluteCapMs: opts.absoluteCapMs,
      complexityMultipliers: opts.complexityMultipliers,
      handoff: opts.handoff,
      phases: opts.phases,
      workerAuth: opts.workerAuth,
      adaptiveCost: opts.adaptiveCost,
      rerouteEnabled: opts.rerouteEnabled,
      hungRequestMs: opts.hungRequestMs,
      reviewOrchestrator,
    });
  }
  return new ClaudeCodeWorker({
    allowedRemotes: opts.allowedRemotes,
    model: opts.model,
    prStrategy: opts.prStrategy,
    reviewAgent: opts.reviewAgent,
    reviewStrategy: opts.reviewStrategy,
    maxReviewRevisions: opts.maxReviewRevisions,
    operatorGuidance: opts.operatorGuidance,
    sharedContract: opts.sharedContract,
    contextNotes: opts.contextNotes,
    stallMs: opts.stallMs,
    absoluteCapMs: opts.absoluteCapMs,
    complexityMultipliers: opts.complexityMultipliers,
    handoff: opts.handoff,
    phases: opts.phases,
    adaptiveCost: opts.adaptiveCost,
    rerouteEnabled: opts.rerouteEnabled,
    hungRequestMs: opts.hungRequestMs,
    reviewOrchestrator,
  });
}
