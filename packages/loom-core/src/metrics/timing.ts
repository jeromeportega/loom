import type { RunPhase } from './types.js';
import { activeCollector } from './activeCollector.js';

/**
 * Tap the active metrics collector (if any) to open a phase timing window.
 * No-op when no collector is bound. Never throws.
 *
 * This is the single clock-source seam for phase timing: all timing reads flow
 * through RunMetricsCollector.startPhase(), which uses Date.now(). Swapping to
 * process.hrtime.bigint() later only requires editing the collector.
 */
export function startPhase(phase: RunPhase): void {
  try { activeCollector()?.startPhase(phase); } catch { /* timing is observability */ }
}

/**
 * Tap the active metrics collector (if any) to close a phase timing window.
 * No-op when no collector is bound or when no matching startPhase was called.
 * Never throws.
 */
export function endPhase(phase: RunPhase): void {
  try { activeCollector()?.endPhase(phase); } catch { /* timing is observability */ }
}
