import type { Policy } from '../types.js';

export const INTAKE_TIMEOUT_DEFAULT_MS = 180_000;
export const INTAKE_TIMEOUT_FLOOR_MS   = 120_000;

/**
 * Resolve the effective intake classification timeout from policy.
 * FR-5: a single call is never capped below INTAKE_TIMEOUT_FLOOR_MS even if
 * the operator configures a lower value.
 */
export function resolveIntakeTimeoutMs(policy: Policy): number {
  return Math.max(
    policy.agents.intake_classify_timeout_ms ?? INTAKE_TIMEOUT_DEFAULT_MS,
    INTAKE_TIMEOUT_FLOOR_MS,
  );
}
