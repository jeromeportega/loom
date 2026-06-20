/**
 * Fixture integration test: dashboard-enhancement epic.
 *
 * This test owns the Seam 7 verification property from the epic-028 contract:
 * after running computeWithinEpicOverlaps + deriveSameFileSerialization, every
 * pair of stories sharing a file must have a transitive ordering dependency —
 * no pair is left unordered. Also asserts the resulting graph is cycle-free.
 *
 * The fixture concentrates work in packages/loom-web/public/dashboard.js:
 * four stories all own that file, requiring the serializer to chain them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWithinEpicOverlaps,
  type OwnershipMap,
} from '../orchestrator/ContractOwnership.js';
import { deriveSameFileSerialization } from '../orchestrator/SerializeOverlaps.js';
import type { Story } from '../types.js';

// ─── Fixture: dashboard-enhancement epic ─────────────────────────────────────
//
// A representative epic whose stories concentrate edits in one file:
// packages/loom-web/public/dashboard.js. This is the shape that triggered the
// same-file serialization requirement: multiple independent stories land on the
// same shared UI entrypoint, making serial integration mandatory.

const DASHBOARD_FILE = 'packages/loom-web/public/dashboard.js';

/** Stories in topo order (as the PM would emit them). */
const FIXTURE_STORIES: Story[] = [
  {
    id: 'story-fx-001',
    title: 'Add user metrics section to dashboard',
    description: 'Render per-agent token usage in a new dashboard panel.',
    acceptance_criteria: ['Metrics panel visible in loom web dashboard'],
    estimated_complexity: 'small',
    dependencies: [],
  },
  {
    id: 'story-fx-002',
    title: 'Add real-time event log panel to dashboard',
    description: 'Stream audit events into a collapsible log panel in the dashboard.',
    acceptance_criteria: ['Event log panel shown and auto-scrolls on new events'],
    estimated_complexity: 'small',
    dependencies: [],
  },
  {
    id: 'story-fx-003',
    title: 'Add cost tracking chart to dashboard',
    description: 'Display running cost per epic as a bar chart in the dashboard.',
    acceptance_criteria: ['Cost chart renders correctly per active epic'],
    estimated_complexity: 'medium',
    dependencies: [],
  },
  {
    id: 'story-fx-004',
    title: 'Add story progress overview to dashboard',
    description: 'Show completion percentage across all epic stories in the dashboard.',
    acceptance_criteria: ['Progress bar visible for each active epic'],
    estimated_complexity: 'small',
    dependencies: [],
  },
];

/**
 * Ownership map: all four fixture stories own the shared dashboard file,
 * plus each story with supplementary files owns those independently.
 * This is the shape that forces the serializer to chain all four stories.
 */
const FIXTURE_OWNERSHIP: OwnershipMap = [
  { epicId: 'epic-fx', storyId: 'story-fx-001', path: DASHBOARD_FILE },
  { epicId: 'epic-fx', storyId: 'story-fx-001', path: 'packages/loom-web/public/metrics.css' },
  { epicId: 'epic-fx', storyId: 'story-fx-002', path: DASHBOARD_FILE },
  { epicId: 'epic-fx', storyId: 'story-fx-002', path: 'packages/loom-web/public/eventlog.js' },
  { epicId: 'epic-fx', storyId: 'story-fx-003', path: DASHBOARD_FILE },
  { epicId: 'epic-fx', storyId: 'story-fx-004', path: DASHBOARD_FILE },
  { epicId: 'epic-fx', storyId: 'story-fx-004', path: 'packages/loom-web/public/progress.js' },
];

// ─── Verification helpers (Seam 7) ───────────────────────────────────────────

/**
 * For every pair (a, b) of stories sharing a file in `ownership`, checks that
 * one story is transitively reachable from the other in the dependency DAG
 * formed by `stories[i].dependencies`. Returns true when this holds for all
 * same-file pairs; false when any pair is left unordered.
 *
 * Seam 7 (epic-028 contract): this helper lives in the test file and is not
 * exported to src — it is a test-only verification property.
 */
function noUnorderedSameFilePairs(stories: Story[], ownership: OwnershipMap): boolean {
  // Index: path → set of storyIds that own it.
  const pathToOwners = new Map<string, Set<string>>();
  for (const entry of ownership) {
    if (!entry.storyId) continue;
    let set = pathToOwners.get(entry.path);
    if (!set) { set = new Set(); pathToOwners.set(entry.path, set); }
    set.add(entry.storyId);
  }

  // Dependency adjacency list: storyId → direct dependencies.
  const directDeps = new Map<string, Set<string>>();
  for (const s of stories) directDeps.set(s.id, new Set(s.dependencies));

  // Memoised transitive-reachability: reachable(A) = all IDs reachable FROM A
  // via the dependency graph (A depends on B means A → B).
  const memo = new Map<string, Set<string>>();
  function reachable(start: string): Set<string> {
    const hit = memo.get(start);
    if (hit) return hit;
    const result = new Set<string>();
    memo.set(start, result); // set early to handle cycles gracefully
    for (const dep of directDeps.get(start) ?? []) {
      result.add(dep);
      for (const transitive of reachable(dep)) result.add(transitive);
    }
    return result;
  }

  // For each shared-file group, every pair must have a transitive ordering.
  for (const [, owners] of pathToOwners) {
    if (owners.size < 2) continue;
    const ids = [...owners];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        if (!reachable(a).has(b) && !reachable(b).has(a)) return false;
      }
    }
  }
  return true;
}

/** Returns true when the dependency DAG formed by `stories[i].dependencies` contains a cycle. */
function hasCycle(stories: Story[]): boolean {
  const adj = new Map<string, Set<string>>();
  for (const s of stories) adj.set(s.id, new Set(s.dependencies));

  const UNVISITED = 0, VISITING = 1, VISITED = 2;
  const state = new Map<string, number>();

  function dfs(node: string): boolean {
    const s = state.get(node) ?? UNVISITED;
    if (s === VISITING) return true;
    if (s === VISITED) return false;
    state.set(node, VISITING);
    for (const next of adj.get(node) ?? new Set()) {
      if (dfs(next)) return true;
    }
    state.set(node, VISITED);
    return false;
  }

  for (const node of adj.keys()) {
    if ((state.get(node) ?? UNVISITED) === UNVISITED && dfs(node)) return true;
  }
  return false;
}

/** Returns a new Story array with `edges` applied to `stories[i].dependencies`. */
function applyEdges(
  stories: Story[],
  edges: ReturnType<typeof deriveSameFileSerialization>,
): Story[] {
  return stories.map((s) => {
    const newDeps = edges
      .filter((e) => e.from === s.id && !s.dependencies.includes(e.dependsOn))
      .map((e) => e.dependsOn);
    if (newDeps.length === 0) return s;
    return { ...s, dependencies: [...s.dependencies, ...newDeps] };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fixture: dashboard-enhancement epic — same-file serialization', () => {
  it('negative control: unserialized graph has unordered same-file pairs', () => {
    // All four stories own dashboard.js but none depends on another yet.
    // noUnorderedSameFilePairs must return false, proving the test is not vacuously passing.
    assert.equal(
      noUnorderedSameFilePairs(FIXTURE_STORIES, FIXTURE_OWNERSHIP),
      false,
      'expected unordered same-file pairs to exist before serialization',
    );
  });

  it('computeWithinEpicOverlaps detects the shared dashboard file with all four owners', () => {
    const overlaps = computeWithinEpicOverlaps(FIXTURE_OWNERSHIP);

    const dashboardOverlap = overlaps.find((o) => o.path === DASHBOARD_FILE);
    assert.ok(dashboardOverlap, 'overlap on dashboard.js must be detected');

    const ownerIds = dashboardOverlap!.owners.map((o) => o.storyId).sort();
    assert.deepEqual(
      ownerIds,
      ['story-fx-001', 'story-fx-002', 'story-fx-003', 'story-fx-004'],
      'all four fixture stories must appear as owners',
    );
  });

  it('computeWithinEpicOverlaps reports only the dashboard file as an overlap', () => {
    const overlaps = computeWithinEpicOverlaps(FIXTURE_OWNERSHIP);
    // The per-story supplementary files (metrics.css, eventlog.js, progress.js)
    // are each owned by exactly one story — they must not appear as overlaps.
    assert.equal(
      overlaps.length,
      1,
      'only the shared dashboard.js should trigger an overlap',
    );
    assert.equal(overlaps[0].path, DASHBOARD_FILE);
  });

  it('after serialization: noUnorderedSameFilePairs is true (AC-2)', () => {
    const overlaps = computeWithinEpicOverlaps(FIXTURE_OWNERSHIP);
    const edges = deriveSameFileSerialization(FIXTURE_STORIES, overlaps);
    const serialized = applyEdges(FIXTURE_STORIES, edges);

    assert.equal(
      noUnorderedSameFilePairs(serialized, FIXTURE_OWNERSHIP),
      true,
      'after serialization every same-file pair must have a transitive ordering dependency',
    );
  });

  it('serialized dependency graph is cycle-free', () => {
    const overlaps = computeWithinEpicOverlaps(FIXTURE_OWNERSHIP);
    const edges = deriveSameFileSerialization(FIXTURE_STORIES, overlaps);
    const serialized = applyEdges(FIXTURE_STORIES, edges);

    assert.equal(hasCycle(serialized), false, 'serialized dependency graph must be cycle-free');
  });

  it('serializer emits exactly 3 edges for 4 stories sharing one file (n-1 chain)', () => {
    const overlaps = computeWithinEpicOverlaps(FIXTURE_OWNERSHIP);
    const edges = deriveSameFileSerialization(FIXTURE_STORIES, overlaps);

    // 4 stories sharing 1 file → a chain of 3 edges: S1→S2→S3→S4 in topo order.
    assert.equal(edges.length, 3, 'expected n-1 = 3 edges for 4 same-file stories');
    assert.ok(
      edges.every((e) => e.reason === 'same-file-conflict-avoidance'),
      'all edges must carry the same-file-conflict-avoidance reason',
    );
    assert.ok(
      edges.every((e) => e.path === DASHBOARD_FILE),
      'all edges must reference the shared dashboard file',
    );
  });
});
