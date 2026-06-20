import type { Story } from '../types.js';
import type { Overlap } from './ContractOwnership.js';

/**
 * A dependency edge derived by the same-file conflict serializer.
 * `from` is the later story that must wait; `dependsOn` is the earlier story
 * that must complete first. `path` is the exact shared file that triggered
 * the edge. Only one reason is currently possible, kept as a literal so callers
 * can switch on it without string comparison.
 */
export interface SerializationEdge {
  from: string;
  dependsOn: string;
  path: string;
  reason: 'same-file-conflict-avoidance';
}

/**
 * Pure function (no I/O). Given the set of stories for an epic and the
 * within-epic overlaps detected by `computeWithinEpicOverlaps`, derives the
 * minimal set of dependency edges that serializes every same-file group into a
 * total order — exactly one chain of (n-1) edges per file group.
 *
 * Ordering key (ADR-003 — deterministic re-plan): the story's position in the
 * `stories` array (its topo index), tie-broken lexicographically by story id.
 * Since `stories` is already in the PM's topological order, adding edges that
 * respect it cannot introduce cycles — the union of all derived chains is
 * provably acyclic.
 *
 * Idempotent: if a story's existing `dependencies` already includes the
 * required predecessor, no duplicate edge is emitted.
 *
 * Deduplication: the same (from, dependsOn) pair can arise from multiple
 * overlapping files — it is emitted at most once.
 */
export function deriveSameFileSerialization(
  stories: Story[],
  overlaps: Overlap[],
): SerializationEdge[] {
  if (overlaps.length === 0) return [];

  // topo index: position in the stories array, used as the primary sort key.
  const topoIndexMap = new Map<string, number>(stories.map((s, i) => [s.id, i]));

  // existing deps per story, for idempotency checks.
  const existingDeps = new Map<string, Set<string>>(
    stories.map((s) => [s.id, new Set(s.dependencies)])
  );

  // dedup key: `${from}:${dependsOn}` — one entry covers both the
  // pre-existing-edge skip and the cross-overlap dedup.
  const emitted = new Set<string>();
  const edges: SerializationEdge[] = [];

  for (const overlap of overlaps) {
    // Only story-attributed owners participate (storyId must be present).
    const storyIds = overlap.owners
      .filter((o) => o.storyId !== undefined)
      .map((o) => o.storyId as string);

    if (storyIds.length < 2) continue;

    // Total order: topo index (primary), story id (tiebreak — deterministic).
    const sorted = [...storyIds].sort((a, b) => {
      const ai = topoIndexMap.get(a) ?? Infinity;
      const bi = topoIndexMap.get(b) ?? Infinity;
      if (ai !== bi) return ai - bi;
      return a < b ? -1 : a > b ? 1 : 0;
    });

    // Chain: sorted[0] must complete before sorted[1], etc.
    for (let i = 0; i < sorted.length - 1; i++) {
      const dependsOn = sorted[i];
      const from = sorted[i + 1];
      const key = `${from}:${dependsOn}`;

      if (emitted.has(key)) continue;
      emitted.add(key);

      // Skip if the dependency already exists (idempotent).
      if (existingDeps.get(from)?.has(dependsOn)) continue;

      edges.push({ from, dependsOn, path: overlap.path, reason: 'same-file-conflict-avoidance' });
    }
  }

  return edges;
}
