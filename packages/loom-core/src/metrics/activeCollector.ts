import { AsyncLocalStorage } from 'node:async_hooks';
import type { RunMetricsCollector } from './RunMetricsCollector.js';

const _store = new AsyncLocalStorage<RunMetricsCollector | undefined>();

export function bindActiveCollector(c: RunMetricsCollector): void {
  _store.enterWith(c);
}

export function clearActiveCollector(): void {
  _store.enterWith(undefined);
}

export function activeCollector(): RunMetricsCollector | undefined {
  return _store.getStore();
}
