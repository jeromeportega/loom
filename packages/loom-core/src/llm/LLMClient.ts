/**
 * Provider-agnostic LLM client interface. Loom V1 ships an Anthropic
 * implementation; tests use MockLLMClient. Keeping this seam means the planner
 * never imports the Anthropic SDK directly and stays unit-testable.
 */

export interface SystemBlock {
  text: string;
  /** When true, mark this block with cache_control: ephemeral (prompt caching). */
  cache?: boolean;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Opt-in non-agentic completion; absence preserves agentic defaults (--append-system-prompt, tools on).
export interface NonAgenticMode {
  // Caller-side hint for req.system composition; ClaudeCliClient ignores this field — both values produce --system-prompt + tools-disable.
  excludeDynamicSections?: boolean;
}

export interface LLMRequest {
  model: string;
  /** System prompt as ordered blocks; cacheable blocks come first. */
  system: SystemBlock[];
  messages: LLMMessage[];
  maxTokens?: number;
  /**
   * When present, called once per streamed assistant text delta. Backends that
   * support streaming (ClaudeCliClient) switch to `--output-format stream-json`
   * and call this for each text chunk. Backends that do not support streaming
   * (MockLLMClient, CursorCliClient) ignore this field and return final text.
   */
  onText?: (delta: string) => void;
  /** Opt-in only; ClaudeCliClient honors it, CursorCliClient ignores it (FR-9). */
  nonAgentic?: NonAgenticMode;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Number of LLM requests this usage record represents. Each `complete()`
   * call is exactly 1 request from the planner/reviewer/skill-gen path's
   * perspective; for worker spawns the count is whatever the CLI's JSON
   * output exposes (cursor-agent JSON; Claude stream-json `result` events).
   *
   * The cursor-cli backend bills per request rather than per token, so this
   * — not costUsd — is the meaningful spend signal under that backend.
   */
  requestCount: number;
  /**
   * Actual API cost in USD. Populated only for backends that expose actual
   * billing (claude-cli stream-json's `total_cost_usd`); 0 for cursor-cli
   * (which has no per-token cost) and for the empty/mock paths.
   */
  costUsd: number;
}

export interface LLMResponse {
  text: string;
  usage: LLMUsage;
  model: string;
  stopReason: string | null;
}

export interface LLMClient {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export const EMPTY_USAGE: LLMUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  requestCount: 0,
  costUsd: 0,
};

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    requestCount: a.requestCount + b.requestCount,
    costUsd: a.costUsd + b.costUsd,
  };
}
