import type { LLMClient } from './LLMClient.js';
import type { Policy } from '../types.js';
import { ClaudeCliClient } from './ClaudeCliClient.js';
import { CursorCliClient } from './CursorCliClient.js';

export type LLMBackend = 'claude-cli' | 'cursor-cli';

/**
 * Resolves the model id for a role. Cursor uses its own model ids (e.g.
 * "sonnet-4"), so when the backend is cursor-cli the cursor_model is used for
 * everything; otherwise the role-specific Claude model id applies.
 */
export function modelFor(policy: Policy, role: 'planning' | 'skill_gen'): string {
  if (policy.agents.llm_backend === 'cursor-cli') return policy.agents.cursor_model;
  return role === 'planning'
    ? policy.agents.planning_model
    : policy.agents.skill_gen_model;
}

export interface CreateLLMOptions {
  /**
   * Per-call wall-clock bound for the underlying CLI subprocess, in
   * milliseconds. Default 10 min on both backends. Set explicitly for the
   * reviewer so policy.agents.review_timeout_minutes takes effect — large
   * story diffs were silently shipping unreviewed at the hardcoded 10 min.
   */
  timeoutMs?: number;
}

/**
 * Builds the LLM client for the configured backend (policy.agents.llm_backend):
 *  - 'claude-cli' — session-based via the Claude Code login. No API key.
 *  - 'cursor-cli' — session-based via the Cursor login. No API key.
 *
 * Both backends are session-based; loom does not support direct API billing
 * (the `anthropic-api` backend was removed to align with the session-only auth policy).
 */
export function createLLMClient(
  backend: LLMBackend = 'claude-cli',
  opts: CreateLLMOptions = {}
): LLMClient {
  if (backend === 'cursor-cli') return new CursorCliClient({ timeoutMs: opts.timeoutMs });
  return new ClaudeCliClient({ timeoutMs: opts.timeoutMs });
}
