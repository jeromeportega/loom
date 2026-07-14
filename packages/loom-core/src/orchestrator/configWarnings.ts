import os from 'node:os';
import type { Policy } from '../types.js';

// stallConfigWarning was removed with the knob-hardening: it validated a
// story_stall_minutes / story_absolute_cap_minutes combination that is no
// longer operator-configurable (both are baked constants), so it could only
// ever fire a permanent, unactionable message on the cursor-cli backend.

/**
 * Soft advisory when max_concurrent exceeds the machine's available parallelism.
 *
 * The threshold is max(1, cpuCount - 2) — leave two cores for the OS and the
 * loom supervisor process. Returns a warning string when max_concurrent exceeds
 * that threshold; returns undefined when it is at or below it. Never mutates
 * the policy (ADR-5: warn, never rewrite).
 *
 * @param cpuCount - Defaults to os.cpus().length; injectable for tests.
 */
export function maxConcurrentAdvisory(
  policy: Policy,
  cpuCount: number = os.cpus().length,
): string | undefined {
  const { max_concurrent } = policy.agents;
  const threshold = Math.max(1, cpuCount - 2);
  if (max_concurrent <= threshold) return undefined;

  return (
    `policy.agents.max_concurrent (${max_concurrent}) exceeds the recommended ` +
    `ceiling of ${threshold} for this machine (${cpuCount} CPUs). Running more ` +
    'concurrent workers than available cores can degrade performance. ' +
    `Consider lowering max_concurrent to ${threshold} or fewer.`
  );
}
