import type { LLMClient } from '../llm/LLMClient.js';
import { activeCollector } from './activeCollector.js';

export function instrumentLLMClient(inner: LLMClient): LLMClient {
  return {
    async complete(req) {
      const res = await inner.complete(req);
      try {
        activeCollector()?.addUsage(res.usage, res.model);
      } catch {
        // observe-only — never throw into the caller
      }
      return res;
    },
  };
}
