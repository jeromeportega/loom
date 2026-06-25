import type { LLMClient } from '../llm/LLMClient.js';
import { activeCollector } from './activeCollector.js';

const INSTRUMENTED = Symbol('loom.instrumented');
type MaybeInstrumented = LLMClient & { [INSTRUMENTED]?: true };

export function instrumentLLMClient(inner: LLMClient): LLMClient {
  // Guard against double-wrapping — an already-instrumented client is returned as-is
  // so token counts are not doubled if the factory is called more than once.
  if ((inner as MaybeInstrumented)[INSTRUMENTED]) return inner;
  const wrapped: MaybeInstrumented = {
    [INSTRUMENTED]: true,
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
  return wrapped;
}
