/**
 * Pure helpers used by the loom-web dashboard frontend.
 * Extracted here so they can be unit-tested without a browser.
 *
 * IMPORTANT — two copies of mutationControl exist intentionally:
 *   1. This module: mutationControl(html, readOnly) — explicit param, testable.
 *   2. index.html inline: function mutationControl(html) — 1-arg closure over
 *      the module-level `readOnly` variable.
 * Tests import this module and do NOT exercise the inline closure. If the inline
 * version drifts (e.g. the captured `readOnly` stops updating), the test suite
 * will not catch it. Keep both in sync when editing either.
 */

/** Minimal trace shape consumed by the grouping helper. */
export interface TraceRow {
  story_id: string | null;
  [key: string]: unknown;
}

/** Minimal audit-entry shape consumed by the merge helper. */
export interface AuditRow {
  id?: number;
  agent_id: string | null;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Group traces by story_id. Traces with a null story_id are grouped under
 * the sentinel key '(unattributed)'. Order within each group is preserved.
 * One call per epic — never N+1 (ADR-001).
 */
export function groupTracesByStory(traces: TraceRow[]): Map<string, TraceRow[]> {
  const map = new Map<string, TraceRow[]>();
  for (const t of traces) {
    const key = t.story_id ?? '(unattributed)';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  return map;
}

/**
 * Merge audit-entry arrays from multiple agent fetches (retry fan-out, ADR-002).
 * Deduplicates by `id` when present, falls back to `agent_id:timestamp`.
 * Returns entries sorted by timestamp ascending.
 */
export function mergeAuditsByTimestamp(entrySets: AuditRow[][]): AuditRow[] {
  const seen = new Set<string>();
  const merged: AuditRow[] = [];
  let counter = 0;
  for (const entries of entrySets) {
    for (const e of entries) {
      // When id is absent, append a monotonic counter so two entries with
      // agent_id=null and the same timestamp don't silently collapse into one.
      const key =
        e.id != null
          ? String(e.id)
          : `${e.agent_id ?? ''}:${e.timestamp}:${counter}`;
      counter++;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(e);
      }
    }
  }
  return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/**
 * Single chokepoint for all mutation controls (ADR-005).
 * When readOnly is true returns '' (hidden); otherwise passes html through.
 */
export function mutationControl(html: string, readOnly: boolean): string {
  return readOnly ? '' : html;
}
