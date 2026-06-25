import { RunMetricsCollector } from './RunMetricsCollector.js';
import { bindActiveCollector, clearActiveCollector } from './activeCollector.js';
import type { MetricsStore } from '../state/MetricsStore.js';
import type { RunScope } from './types.js';

/**
 * Lifecycle wrapper that binds a RunMetricsCollector for the duration of `fn`.
 *
 * Binding contract (ADR-001):
 *  1. Instantiates exactly one RunMetricsCollector per call.
 *  2. Sets the scope and calls bindActiveCollector BEFORE fn runs — all async
 *     descendants of fn see the same collector via activeCollector().
 *  3. In the finally block: attempts store.recordRun(c.build()) once (exactly).
 *     A metrics throw is caught and dropped so it never propagates into the run
 *     (NFR-1 fail-open). clearActiveCollector() fires in a nested finally so it
 *     runs even if c.build() throws.
 *
 * The single recordRun call is structural — no other site may call recordRun
 * for the same run (story-065-004 sets attribution via c.setAttribution before
 * this finally fires; story-065-002/003 accumulate phase/usage data via the
 * active collector).
 */
export async function withRunMetrics<T>(
  init: { scope: RunScope; store: MetricsStore },
  fn: (collector: RunMetricsCollector) => Promise<T>,
): Promise<T> {
  const c = new RunMetricsCollector();
  c.setAttribution({ scope: init.scope });
  bindActiveCollector(c);
  try {
    return await fn(c);
  } finally {
    try {
      init.store.recordRun(c.build());
    } catch {
      // fail-open — a metrics error must never propagate into the run
    } finally {
      clearActiveCollector();
    }
  }
}
