import type { WorkerRunner } from './WorkerRunner.js';
import { ClaudeCodeWorker } from './ClaudeCodeWorker.js';
import { CursorAgentWorker } from './CursorAgentWorker.js';
import type { PrStrategy } from './BaseCliWorker.js';
import type { CodeReviewAgent } from '../review/CodeReviewAgent.js';

export type WorkerBackend = 'claude-code' | 'cursor-cli';

export interface WorkerFactoryOptions {
  backend: WorkerBackend;
  /** policy.git.allowed_remotes — gates where loom may push. */
  allowedRemotes: string[];
  /** Cursor model id, used only by the cursor-cli backend. */
  cursorModel?: string;
  /** policy.agents.pr_strategy — workers suppress per-story PRs in 'per-epic' mode. */
  prStrategy?: PrStrategy;
  /** Optional CodeReviewAgent for the post-commit review pass (Epic 18). */
  reviewAgent?: CodeReviewAgent;
  /** policy.agents.review_strategy — applied after the worker commits. */
  reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
  /** Max revisions for 'block-and-revise'. */
  maxReviewRevisions?: number;
  /** policy.agents.review_revise_trigger — severity threshold for re-prompts. */
  reviewReviseTrigger?: 'blockers' | 'any';
  /** policy.agents.budget_tokens_per_story — halts the worker on exceed. */
  budgetTokensPerStory?: number;
  /** policy.agents.operator_guidance — when 'on', worker reads .loom/guidance/<story-id>.md */
  operatorGuidance?: 'off' | 'on';
  /** policy.agents.shared_contract — when 'on', worker prompt prepends .loom/contract/<epic-id>.md */
  sharedContract?: 'off' | 'on';
  /** policy.agents.context_notes — when 'on', worker prompt appends deps' .loom/context/<dep-id>.md */
  contextNotes?: 'off' | 'on';
  /** policy.agents.story_stall_minutes — silence window before the stall kill (ms). */
  stallMs?: number;
  /** policy.agents.story_absolute_cap_minutes — absolute wall-clock ceiling (ms). */
  absoluteCapMs?: number;
  /** policy.agents.story_timeout_multipliers — per-complexity scaling of the budgets. */
  complexityMultipliers?: Record<string, number>;
  /** policy.agents.handoff — resume-handoff mode for the worker prompt. */
  handoff?: 'off' | 'telemetry' | 'summarized';
  /** policy.agents.phases — when 'on', run stories as implement+verify spawns. */
  phases?: 'off' | 'on';
}

/**
 * Builds the worker runner for the configured backend (policy.agents.worker_backend):
 *  - 'claude-code' — story agents run via the `claude` CLI.
 *  - 'cursor-cli'  — story agents run via Cursor's `cursor-agent` CLI.
 * Both are session-based.
 */
export function createWorker(opts: WorkerFactoryOptions): WorkerRunner {
  if (opts.backend === 'cursor-cli') {
    return new CursorAgentWorker({
      allowedRemotes: opts.allowedRemotes,
      model: opts.cursorModel,
      prStrategy: opts.prStrategy,
      reviewAgent: opts.reviewAgent,
      reviewStrategy: opts.reviewStrategy,
      maxReviewRevisions: opts.maxReviewRevisions,
      reviewReviseTrigger: opts.reviewReviseTrigger,
      budgetTokensPerStory: opts.budgetTokensPerStory,
      operatorGuidance: opts.operatorGuidance,
      sharedContract: opts.sharedContract,
      contextNotes: opts.contextNotes,
      stallMs: opts.stallMs,
      absoluteCapMs: opts.absoluteCapMs,
      complexityMultipliers: opts.complexityMultipliers,
      handoff: opts.handoff,
      phases: opts.phases,
    });
  }
  return new ClaudeCodeWorker({
    allowedRemotes: opts.allowedRemotes,
    prStrategy: opts.prStrategy,
    reviewAgent: opts.reviewAgent,
    reviewStrategy: opts.reviewStrategy,
    maxReviewRevisions: opts.maxReviewRevisions,
    budgetTokensPerStory: opts.budgetTokensPerStory,
    operatorGuidance: opts.operatorGuidance,
    sharedContract: opts.sharedContract,
    contextNotes: opts.contextNotes,
    stallMs: opts.stallMs,
    absoluteCapMs: opts.absoluteCapMs,
    complexityMultipliers: opts.complexityMultipliers,
    handoff: opts.handoff,
    phases: opts.phases,
  });
}
