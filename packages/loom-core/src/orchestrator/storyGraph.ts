import type { Story } from '../types.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';
import { validateCrossRepoEdges } from './crossRepoReadiness.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StoryGraph {
  nodes: Map<string, Story>;    // story-id → Story
  edges: Map<string, string[]>; // story-id → ids of stories it depends on
}

export interface CriticalPathResult {
  chain: string[];          // ordered story-id array, source (no deps) first
  estimatedMinutes: number; // 0 when no estimated_effort data present
}

export class StoryGraphCycleError extends Error {
  readonly cyclePath: string[];
  constructor(cyclePath: string[]) {
    super(`Cycle detected in story graph: ${cyclePath.join(' → ')}`);
    this.name = 'StoryGraphCycleError';
    this.cyclePath = cyclePath;
  }
}

// ─── buildStoryGraph ──────────────────────────────────────────────────────────

export function buildStoryGraph(stories: Story[]): StoryGraph {
  const nodes = new Map<string, Story>();
  for (const s of stories) nodes.set(s.id, s);

  const edges = new Map<string, string[]>();
  for (const s of stories) edges.set(s.id, [...s.dependencies]);

  return { nodes, edges };
}

// ─── DFS cycle-detection helper (private) ────────────────────────────────────

// Returns the cycle path as an ordered array of story IDs (first element
// repeated at the end to show the back-edge), or [] when the graph is acyclic.
// Deps not present in dag are silently skipped (cross-story / external refs).
function dfsColorMark(dag: Map<string, string[]>): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  const pathStack: string[] = [];
  // Parallel index map avoids O(n) indexOf scans on the path stack.
  const stackIndex = new Map<string, number>();
  let found: string[] = [];

  for (const node of dag.keys()) colors.set(node, WHITE);

  function dfs(node: string): boolean {
    colors.set(node, GRAY);
    stackIndex.set(node, pathStack.length);
    pathStack.push(node);
    for (const dep of dag.get(node) ?? []) {
      if (!colors.has(dep)) continue; // dep absent from this dag — skip
      if (colors.get(dep) === GRAY) {
        // Back-edge: everything from dep's stack position to here is the cycle.
        const start = stackIndex.get(dep)!;
        found = [...pathStack.slice(start), dep]; // dep repeated to show the loop
        return true;
      }
      if (colors.get(dep) !== BLACK && dfs(dep)) return true;
    }
    pathStack.pop();
    stackIndex.delete(node);
    colors.set(node, BLACK);
    return false;
  }

  for (const node of dag.keys()) {
    if (colors.get(node) === WHITE && dfs(node)) break;
  }

  return found;
}

// ─── topologicalSort ─────────────────────────────────────────────────────────

// Returns a valid topological order (dependencies before their consumers).
// Throws StoryGraphCycleError when the graph contains a cycle.
// Uses Kahn's algorithm; dfsColorMark is only invoked when a cycle is confirmed
// (result.length < nodes.size) to extract the cycle path for the error.
export function topologicalSort(graph: StoryGraph): string[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → [consumers of dep]

  for (const id of graph.nodes.keys()) {
    indegree.set(id, 0);
    adj.set(id, []);
  }

  for (const [id, deps] of graph.edges) {
    if (!graph.nodes.has(id)) continue;
    for (const dep of deps) {
      if (!graph.nodes.has(dep)) continue; // skip refs outside this graph
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
      adj.get(dep)!.push(id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const consumer of adj.get(node) ?? []) {
      const newDeg = (indegree.get(consumer) ?? 0) - 1;
      indegree.set(consumer, newDeg);
      if (newDeg === 0) queue.push(consumer);
    }
  }

  // Kahn's naturally detects cycles: unprocessed nodes remain when a cycle exists.
  if (result.length < graph.nodes.size) {
    const cycle = dfsColorMark(graph.edges);
    throw new StoryGraphCycleError(cycle);
  }

  return result;
}

// ─── detectCycles ─────────────────────────────────────────────────────────────

// Returns the cycle path as an array of story-IDs when a cycle exists, [] when
// acyclic. Covers both in-epic story-level cycles (via dfsColorMark) and
// cross-repo cycles (via validateCrossRepoEdges from crossRepoReadiness.ts).
// For cross-repo cycles, returns the IDs of all stories that reside in the
// repos involved in the cycle — not the repo slugs themselves.
export function detectCycles(
  graph: StoryGraph,
  opts?: { manifest?: WorkspaceManifest; primarySlug?: string },
): string[] {
  const cycle = dfsColorMark(graph.edges);
  if (cycle.length > 0) return cycle;

  if (opts?.manifest) {
    const primarySlug = opts.primarySlug ?? '';
    const stories = Array.from(graph.nodes.values());
    const errors = validateCrossRepoEdges(stories, opts.manifest, primarySlug);
    if (errors.length > 0) {
      // Collect the repo slugs that participate in the cycle.
      const cycleRepos = new Set<string>();
      for (const e of errors) {
        cycleRepos.add(e.consumerSlug);
        cycleRepos.add(e.producerSlug);
      }
      // Map back to story IDs: return the IDs of stories that belong to the
      // offending repos. story.repo falls back to primarySlug when unset.
      const ids = stories
        .filter(s => cycleRepos.has(s.repo ?? primarySlug))
        .map(s => s.id);
      return ids.length > 0 ? ids : [errors[0].consumerSlug, errors[0].producerSlug];
    }
  }

  return [];
}

// ─── findReadyStories ────────────────────────────────────────────────────────

// Returns stories that are eligible to dispatch: not yet completed themselves,
// and every declared dependency is present in the completed set.
export function findReadyStories(graph: StoryGraph, completed: Set<string>): Story[] {
  const ready: Story[] = [];
  for (const [id, story] of graph.nodes) {
    if (completed.has(id)) continue; // already done — do not re-dispatch
    const deps = graph.edges.get(id) ?? [];
    if (deps.every(dep => completed.has(dep))) {
      ready.push(story);
    }
  }
  return ready;
}

// ─── criticalPath ─────────────────────────────────────────────────────────────

// Returns the longest dependency chain weighted by estimated_effort.
// Stories absent estimated_effort contribute 0 to the weight; when all stories
// lack effort data the longest path by edge count is returned with
// estimatedMinutes = 0 (ADR-5 fallback).
// Uses a parent-pointer DP table to avoid O(n²) path-array copying.
export function criticalPath(graph: StoryGraph): CriticalPathResult {
  if (graph.nodes.size === 0) return { chain: [], estimatedMinutes: 0 };

  const order = topologicalSort(graph); // throws StoryGraphCycleError for cyclic input

  type DPEntry = { weight: number; length: number; parent: string | null };
  const dp = new Map<string, DPEntry>();

  for (const id of order) {
    const story = graph.nodes.get(id);
    const nodeWeight = story?.estimated_effort ?? 0;
    const deps = (graph.edges.get(id) ?? []).filter(d => graph.nodes.has(d));

    if (deps.length === 0) {
      dp.set(id, { weight: nodeWeight, length: 1, parent: null });
    } else {
      let best: DPEntry | null = null;
      for (const dep of deps) {
        const prev = dp.get(dep);
        if (!prev) continue;
        const w = prev.weight + nodeWeight;
        const l = prev.length + 1;
        if (!best || w > best.weight || (w === best.weight && l > best.length)) {
          best = { weight: w, length: l, parent: dep };
        }
      }
      // Fallback for deps that are all outside the graph (no valid predecessor found).
      dp.set(id, best ?? { weight: nodeWeight, length: 1, parent: null });
    }
  }

  let globalBestId: string | null = null;
  let globalBest: DPEntry | null = null;
  for (const [id, val] of dp) {
    if (
      !globalBest ||
      val.weight > globalBest.weight ||
      (val.weight === globalBest.weight && val.length > globalBest.length)
    ) {
      globalBest = val;
      globalBestId = id;
    }
  }

  if (!globalBest || globalBestId === null) return { chain: [], estimatedMinutes: 0 };

  // Reconstruct path by walking parent pointers from the terminal node.
  const chain: string[] = [];
  let curr: string | null = globalBestId;
  while (curr !== null) {
    chain.push(curr);
    curr = dp.get(curr)!.parent;
  }
  chain.reverse();

  return { chain, estimatedMinutes: globalBest.weight };
}
