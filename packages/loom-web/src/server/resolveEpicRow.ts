import { STANDALONE_KIND } from '@loom-ai/core';

/**
 * TECH DEBT (flagged 2026-06-23): this is a SHIM, not the right model.
 * Standalone stories are repurposed epic containers (kind='standalone' rows with
 * epic-NNN ids, re-framed as story-NNN at every surface). That forces per-surface
 * story↔epic derivation — now duplicated across the planner, `loom status`, the
 * web list (rollupEpics), and this web detail/mutations path. Each derivation is
 * a place to get it wrong. The robust fix is a FIRST-CLASS work-item model (a real
 * story-NNN identity, not derived from epic-NNN, behind a unified epic|story
 * abstraction — i.e. the Mission Control card model). Until then, every new
 * standalone surface needs this same shim. Go back and model it properly.
 *
 * Resolve an `/api/epics/:id` route param to its underlying epic row.
 *
 * Standalone stories are surfaced in the list (rollupEpics) with `id=story-NNN`,
 * but the underlying container row is `epic-NNN`. A direct `store.get('story-NNN')`
 * therefore misses, so the detail view (and its traces/artifacts/mutation routes)
 * 404s and the frontend falls back to the home view. When the direct lookup fails
 * for a `story-` id, fall back to the standalone container `epic-NNN` (verifying it
 * really is a standalone container so a normal `story-`-prefixed id can't be spoofed
 * onto an unrelated epic). Returns undefined when neither resolves.
 */
export function resolveEpicRow<T extends { kind?: string | null }>(
  store: { get(id: string): T | undefined },
  id: string,
): T | undefined {
  const direct = store.get(id);
  if (direct) return direct;
  if (id.startsWith('story-')) {
    const container = store.get(id.replace(/^story-/, 'epic-'));
    if (container && container.kind === STANDALONE_KIND) return container;
  }
  return undefined;
}
