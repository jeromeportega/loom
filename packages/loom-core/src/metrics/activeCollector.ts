import type { RunMetricsCollector } from './RunMetricsCollector.js';

let _active: RunMetricsCollector | undefined;

export function bindActiveCollector(c: RunMetricsCollector): void {
  _active = c;
}

export function clearActiveCollector(): void {
  _active = undefined;
}

export function activeCollector(): RunMetricsCollector | undefined {
  return _active;
}
