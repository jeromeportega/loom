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
 * Builds a repo-level dependency DAG from the story-level dependency graph.
 *
 * Returns: repo-slug → repo-slugs it depends on (i.e. whose PRs must land first).
 * Same-repo story dependencies are excluded — only cross-repo edges contribute.
 */
export function buildRepoDag(
  stories: Story[],
  m: WorkspaceManifest,
  primarySlug: string,
): Map<string, string[]> {
  const byId = new Map<string, Story>(stories.map(s => [s.id, s]));

  // Seed every repo slug that appears in this epic.
  const dag = new Map<string, Set<string>>();
  for (const s of stories) {
    const slug = resolveStoryRepo(s, m, primarySlug).slug;
    if (!dag.has(slug)) dag.set(slug, new Set());
  }

  // Lift cross-repo story dependencies to repo-level edges.
  for (const s of stories) {
    const sSlug = resolveStoryRepo(s, m, primarySlug).slug;
    for (const depId of s.dependencies) {
      const depStory = byId.get(depId);
      if (!depStory) continue;
      const depSlug = resolveStoryRepo(depStory, m, primarySlug).slug;
      if (sSlug !== depSlug) {
        dag.get(sSlug)!.add(depSlug);
      }
    }
  }

  const result = new Map<string, string[]>();
  for (const [slug, deps] of dag) {
    result.set(slug, [...deps]);
  }
  return result;
}

// ─── Readiness predicate ──────────────────────────────────────────────────────

/**
 * Repo-stage statuses (mirrors CrossRepoCoordinator.RepoStage.status).
 * Defined here so the readiness predicate has no dependency on the coordinator.
 */
export type RepoStageStatus =
  | 'pending'
  | 'running'
  | 'finalizing'
  | 'awaiting_merge'
  | 'landed'
  | 'gated'
  | 'partial_landing'
  | 'failed';

/**
 * Returns true when a dependency is satisfied for dispatching `story`.
 *
 * - Same-repo edge: satisfied when `depStatus` is in the SUCCESS set
 *   ('done' | 'pr_open') — today's behaviour, unchanged.
 * - Cross-repo edge: satisfied only when the producer repo stage has reached
 *   'landed'. The individual dep story status is irrelevant for cross-repo edges
 *   because the whole producer repo must land (including its PR merge) before the
 *   consumer can execute against it.
 *
 * @param depStatus      The dep story's current agent status.
 * @param depRepoStageStatus  The dep's repo stage status; required for cross-repo
 *                       edges, ignored for same-repo edges.
 */
export function isDepReady(
  story: Story,
  depStory: Story,
  depStatus: string,
  depRepoStageStatus: RepoStageStatus | undefined,
  m: WorkspaceManifest,
  primarySlug: string,
): boolean {
  if (!isCrossRepoEdge(story, depStory, m, primarySlug)) {
    // Same-repo: mirror the Supervisor's existing SUCCESS set.
    return depStatus === 'done' || depStatus === 'pr_open';
  }
  // Cross-repo: producer repo stage must reach 'landed'.
  return depRepoStageStatus === 'landed';
}

// ─── Planner validation ───────────────────────────────────────────────────────

export interface CrossRepoEdgeError {
  /** Story that declared the bad dependency. */
  storyId: string;
  /** Dependency story id. */
  depId: string;
  reason: string;
}

/**
 * Validates that every cross-repo dependency edge points producer→consumer.
 *
 * A cross-repo edge "A depends on B" is valid iff A's repo does NOT also (directly
 * or transitively) land before B's repo — i.e. the repo DAG is acyclic. A cycle
 * means the two repos mutually depend on each other, creating a consumer→producer
 * edge that cannot be scheduled.
 *
 * Returns the story-level edges that form or contribute to a cycle. An empty array
 * means all cross-repo edges are valid (producer→consumer only).
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

  for (const s of stories) {
    const sSlug = resolveStoryRepo(s, m, primarySlug).slug;
    if (!reposInCycle.has(sSlug)) continue;
    for (const depId of s.dependencies) {
      const depStory = byId.get(depId);
      if (!depStory) continue;
      const depSlug = resolveStoryRepo(depStory, m, primarySlug).slug;
      if (sSlug !== depSlug && reposInCycle.has(depSlug)) {
        errors.push({
          storyId: s.id,
          depId,
          reason:
            `cross-repo dependency creates a cycle between repo "${sSlug}" ` +
            `and repo "${depSlug}" — only producer→consumer edges are valid`,
        });
      }
    }
  }
  return errors;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns the set of repo slugs that participate in at least one cycle in the
 * directed dependency graph (detected via DFS colour-marking).
 */
function findReposInCycles(dag: Map<string, string[]>): Set<string> {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  const inCycle = new Set<string>();

  for (const node of dag.keys()) colors.set(node, WHITE);

  function dfs(node: string): boolean {
    colors.set(node, GRAY);
    for (const dep of dag.get(node) ?? []) {
      if (colors.get(dep) === GRAY) {
        inCycle.add(node);
        inCycle.add(dep);
        return true;
      }
      if (colors.get(dep) !== BLACK) {
        if (dfs(dep)) {
          inCycle.add(node);
          return true;
        }
      }
    }
    colors.set(node, BLACK);
    return false;
  }

  for (const node of dag.keys()) {
    if (colors.get(node) === WHITE) dfs(node);
  }

  return inCycle;
}
