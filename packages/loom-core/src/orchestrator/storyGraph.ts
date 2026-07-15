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
  let found: string[] = [];

  for (const node of dag.keys()) colors.set(node, WHITE);

  function dfs(node: string): boolean {
    colors.set(node, GRAY);
    pathStack.push(node);
    for (const dep of dag.get(node) ?? []) {
      if (!colors.has(dep)) continue; // dep absent from this dag — skip
      if (colors.get(dep) === GRAY) {
        // Back-edge: everything from dep's stack position to here is the cycle.
        const start = pathStack.indexOf(dep);
        found = [...pathStack.slice(start), dep]; // dep repeated to show the loop
        return true;
      }
      if (colors.get(dep) !== BLACK && dfs(dep)) return true;
    }
    pathStack.pop();
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
export function topologicalSort(graph: StoryGraph): string[] {
  const cycle = dfsColorMark(graph.edges);
  if (cycle.length > 0) throw new StoryGraphCycleError(cycle);

  // Kahn's algorithm over the nodes present in the graph.
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

  return result;
}

// ─── detectCycles ─────────────────────────────────────────────────────────────

// Returns the cycle path as an array of story-IDs when a cycle exists, [] when
// acyclic. Covers both in-epic story-level cycles (via dfsColorMark) and
// cross-repo cycles (via validateCrossRepoEdges from crossRepoReadiness.ts).
export function detectCycles(
  graph: StoryGraph,
  opts?: { manifest?: WorkspaceManifest; primarySlug?: string },
): string[] {
  const cycle = dfsColorMark(graph.edges);
  if (cycle.length > 0) return cycle;

  if (opts?.manifest) {
    const stories = Array.from(graph.nodes.values());
    const errors = validateCrossRepoEdges(stories, opts.manifest, opts.primarySlug ?? '');
    if (errors.length > 0) {
      // Return the repo slugs involved in the first cross-repo cycle edge.
      return [errors[0].consumerSlug, errors[0].producerSlug];
    }
  }

  return [];
}

// ─── findReadyStories ────────────────────────────────────────────────────────

// Returns stories whose every declared dependency is present in the completed set.
export function findReadyStories(graph: StoryGraph, completed: Set<string>): Story[] {
  const ready: Story[] = [];
  for (const [id, story] of graph.nodes) {
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
export function criticalPath(graph: StoryGraph): CriticalPathResult {
  if (graph.nodes.size === 0) return { chain: [], estimatedMinutes: 0 };

  const order = topologicalSort(graph); // throws StoryGraphCycleError for cyclic input

  type DPEntry = { weight: number; length: number; path: string[] };
  const dp = new Map<string, DPEntry>();

  for (const id of order) {
    const story = graph.nodes.get(id);
    const nodeWeight = story?.estimated_effort ?? 0;
    const deps = (graph.edges.get(id) ?? []).filter(d => graph.nodes.has(d));

    if (deps.length === 0) {
      dp.set(id, { weight: nodeWeight, length: 1, path: [id] });
    } else {
      let best: DPEntry | null = null;
      for (const dep of deps) {
        const prev = dp.get(dep);
        if (!prev) continue;
        const w = prev.weight + nodeWeight;
        const l = prev.length + 1;
        if (!best || w > best.weight || (w === best.weight && l > best.length)) {
          best = { weight: w, length: l, path: [...prev.path, id] };
        }
      }
      // Fallback for deps that are all outside the graph (no valid predecessor found).
      dp.set(id, best ?? { weight: nodeWeight, length: 1, path: [id] });
    }
  }

  let globalBest: DPEntry | null = null;
  for (const val of dp.values()) {
    if (
      !globalBest ||
      val.weight > globalBest.weight ||
      (val.weight === globalBest.weight && val.length > globalBest.length)
    ) {
      globalBest = val;
    }
  }

  if (!globalBest) return { chain: [], estimatedMinutes: 0 };
  return { chain: globalBest.path, estimatedMinutes: globalBest.weight };
}
