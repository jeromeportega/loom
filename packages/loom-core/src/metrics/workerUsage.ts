import type { LLMUsage } from '../llm/LLMClient.js';
import type { WorkerUsage } from '../orchestrator/WorkerRunner.js';

/**
 * Maps a WorkerUsage (subprocess-reported) to the LLMUsage shape expected by
 * RunMetricsCollector.addUsage. Both optional fields default to zero / one so
 * the collector always receives a complete record.
 *
 * Owned by story-065-003. This is the second hand-maintained usage path
 * (the first is instrumentLLMClient). It exists because subprocess claude-cli
 * cost is structurally invisible to the in-process LLM client tap.
 */
export function toLLMUsage(w: WorkerUsage): LLMUsage {
  return {
    inputTokens: w.inputTokens,
    outputTokens: w.outputTokens,
    cacheReadTokens: w.cacheReadTokens,
    cacheCreationTokens: w.cacheCreationTokens,
    costUsd: w.costUsd ?? 0,
    requestCount: w.requestCount ?? 1,
  };
}
