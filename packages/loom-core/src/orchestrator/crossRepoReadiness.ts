import type { Story } from '../types.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';
import { resolveStoryRepo } from './resolveStoryRepo.js';

// ─── Cross-repo edge detection ────────────────────────────────────────────────

/**
 * Returns true when `story` and `depStory` resolve to different repo slugs,
 * i.e. the dependency edge crosses a repo boundary.
 */
export function isCrossRepoEdge(
  story: Story,
  depStory: Story,
  m: WorkspaceManifest,
  primarySlug: string,
): boolean {
  const storySlug = resolveStoryRepo(story, m, primarySlug).slug;
  const depSlug = resolveStoryRepo(depStory, m, primarySlug).slug;
  return storySlug !== depSlug;
}

// ─── Repo-level DAG ──────────────────────────────────────────────────────────

/**
 * Map<consumerSlug, producerSlug[]> — one entry per repo that appears in the
 * epic (seeded from stories), with [] for roots (no cross-repo producers).
 * Same-repo story dependencies are excluded; only cross-repo edges appear here.
 */
export type RepoDag = Map<string, string[]>;

/**
 * Builds a repo-level dependency DAG from the story-level dependency graph.
 *
 * Returns: repo-slug → repo-slugs it depends on (i.e. whose PRs must land first).
 * One entry per repo that participates in this epic (seeded from stories).
 * Same-repo story dependencies are excluded — only cross-repo edges contribute.
 * N=1 ⇒ a single entry with no edges; N=2 ⇒ a single-edge special case.
 *
 * Trade-off (ADR-008): inter-repo edges are inferred from story dependencies.
 * A missing story dep silently drops a landing-order constraint.
 */
export function buildRepoDag(
  stories: Story[],
  m: WorkspaceManifest,
  primarySlug: string,
): RepoDag {
  const byId = new Map<string, Story>(stories.map(s => [s.id, s]));

  // Seed every repo slug that appears in this epic (one node per participating repo).
  const dag = new Map<string, Set<string>>();
  for (const s of stories) {
    const slug = resolveStoryRepo(s, m, primarySlug).slug;
    if (!dag.has(slug)) dag.set(slug, new Set());
  }

  // Lift cross-repo story dependencies to repo-level edges.
  // Same-repo edges (sSlug === depSlug) are intentionally dropped — they belong
  // to the story work-queue, not the inter-repo landing order (ADR-008).
  for (const s of stories) {
    const sSlug = resolveStoryRepo(s, m, primarySlug).slug;
    for (const depId of s.dependencies) {
      const depStory = byId.get(depId);
      if (!depStory) continue; // missing dep → no edge (ADR-008 inference boundary)
      const depSlug = resolveStoryRepo(depStory, m, primarySlug).slug;
      if (sSlug !== depSlug) {
        dag.get(sSlug)!.add(depSlug);
      }
    }
  }

  const result: RepoDag = new Map();
  for (const [slug, deps] of dag) {
    result.set(slug, [...deps]);
  }
  return result;
}

// ─── Readiness predicate ──────────────────────────────────────────────────────

/**
 * Repo-stage statuses (mirrors CrossRepoCoordinator.RepoStage.status).
 * Defined here so the readiness predicate has no circular dependency on the coordinator.
 */
export type RepoStageStatus =
  | 'pending'
  | 'running'
  | 'finalizing'
  | 'awaiting_merge'
  | 'merged_gating'
  | 'landed'
  | 'gated'
  | 'partial_landing'
  | 'failed';

/**
 * Returns true when a dependency is satisfied for dispatching `story`.
 *
 * - Same-repo edge: satisfied when `depStoryStatus` is in the SUCCESS set
 *   ('done' | 'pr_open') — today's behaviour, unchanged.
 * - Cross-repo edge: satisfied only when the producer repo stage has reached
 *   'landed'. The individual dep story status is irrelevant for cross-repo edges
 *   because the whole producer repo must land (including its PR merge) before the
 *   consumer can execute against it.
 *
 * @param depStoryStatus      The dep story's current agent status.
 * @param depRepoStageStatus  The dep's repo stage status; required for cross-repo
 *                            edges, ignored for same-repo edges.
 */
export function isDepReady(
  story: Story,
  depStory: Story,
  depStoryStatus: string,
  depRepoStageStatus: RepoStageStatus | undefined,
  m: WorkspaceManifest,
  primarySlug: string,
): boolean {
  if (!isCrossRepoEdge(story, depStory, m, primarySlug)) {
    // Same-repo: mirror the Supervisor's existing SUCCESS set.
    return depStoryStatus === 'done' || depStoryStatus === 'pr_open';
  }
  // Cross-repo: producer repo stage must reach 'landed'.
  // Individual dep story status is not consulted — the whole producer repo must merge.
  return depRepoStageStatus === 'landed';
}

// ─── Planner validation ───────────────────────────────────────────────────────

export interface CrossRepoEdgeError {
  /** Repo slug of the consumer (the repo declaring the dependency). */
  consumerSlug: string;
  /** Repo slug of the producer (the repo being depended on). */
  producerSlug: string;
  reason: string;            // operator-readable
}

/**
 * Validates that every cross-repo dependency edge points producer→consumer.
 *
 * A cross-repo edge "A depends on B" is valid iff A's repo does NOT also (directly
 * or transitively) land before B's repo — i.e. the repo DAG is acyclic. A cycle
 * means the two repos mutually depend on each other, creating a consumer→producer
 * edge that cannot be scheduled.
 *
 * Returns repo-level edges that participate in a cycle. One entry per unique
 * (consumerSlug, producerSlug) pair — duplicates from multiple stories on the
 * same repo edge are collapsed. An empty array means all cross-repo edges are
 * valid (producer→consumer only).
 */
export function validateCrossRepoEdges(
  stories: Story[],
  m: WorkspaceManifest,
  primarySlug: string,
): CrossRepoEdgeError[] {
  const dag = buildRepoDag(stories, m, primarySlug);
  const reposInCycle = findReposInCycles(dag);
  if (reposInCycle.size === 0) return [];

  const byId = new Map<string, Story>(stories.map(s => [s.id, s]));
  const errors: CrossRepoEdgeError[] = [];
  const seen = new Set<string>();

  for (const s of stories) {
    const sSlug = resolveStoryRepo(s, m, primarySlug).slug;
    if (!reposInCycle.has(sSlug)) continue;
    for (const depId of s.dependencies) {
      const depStory = byId.get(depId);
      if (!depStory) continue;
      const depSlug = resolveStoryRepo(depStory, m, primarySlug).slug;
      if (sSlug !== depSlug && reposInCycle.has(depSlug)) {
        const key = `${sSlug}→${depSlug}`;
        if (!seen.has(key)) {
          seen.add(key);
          errors.push({
            consumerSlug: sSlug,
            producerSlug: depSlug,
            reason:
              `cross-repo dependency creates a cycle between repo "${sSlug}" ` +
              `and repo "${depSlug}" — only producer→consumer edges are valid`,
          });
        }
      }
    }
  }
  return errors;
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Returns the set of repo slugs that participate in at least one cycle in the
 * directed dependency graph (detected via DFS colour-marking with a path stack).
 *
 * Only the nodes that form the cycle are marked — ancestors that merely have a
 * path *into* a cycle are NOT included.  The path-stack approach avoids the
 * ancestor-contamination bug of the simple propagation form: when a back-edge
 * is found we walk the stack from the cycle-entry to the current node and mark
 * exactly those nodes.
 */
export function findReposInCycles(dag: RepoDag): Set<string> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  const inCycle = new Set<string>();
  const pathStack: string[] = [];

  for (const node of dag.keys()) colors.set(node, WHITE);

  function dfs(node: string): void {
    colors.set(node, GRAY);
    pathStack.push(node);
    for (const dep of dag.get(node) ?? []) {
      if (colors.get(dep) === GRAY) {
        // Back-edge found: dep is on the current path stack, so everything
        // from dep's position to the current node is part of the cycle.
        const cycleStart = pathStack.indexOf(dep);
        for (let i = cycleStart; i < pathStack.length; i++) {
          inCycle.add(pathStack[i]);
        }
      } else if (colors.get(dep) !== BLACK) {
        dfs(dep);
      }
    }
    pathStack.pop();
    colors.set(node, BLACK);
  }

  for (const node of dag.keys()) {
    if (colors.get(node) === WHITE) dfs(node);
  }

  return inCycle;
}
