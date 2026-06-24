import type { WorkspaceManifest } from './workspaceManifest.js';

/**
 * Resolve the primary repo slug from a workspace manifest.
 *
 * Fail-closed chain (ADR-006):
 *   1. Exactly one entry flagged `primary: true`  → that slug.
 *   2. No flag, exactly one registered repo        → that slug.
 *   3. No flag, multiple repos, activeRepoSlug is registered → activeRepoSlug.
 *   4. Otherwise                                   → throw; never guess.
 *
 * >1 entries flagged primary is always an error.
 */
export function resolvePrimaryRepo(
  manifest: WorkspaceManifest,
  activeRepoSlug?: string,
): string {
  const repos = manifest.repos;

  const flagged = repos.filter(r => r.primary === true);
  if (flagged.length > 1) {
    throw new Error(
      `Workspace manifest has ${flagged.length} repos flagged as primary ` +
      `(${flagged.map(r => r.slug).join(', ')}); at most one is allowed`,
    );
  }
  if (flagged.length === 1) {
    return flagged[0].slug;
  }

  if (repos.length === 1) {
    return repos[0].slug;
  }

  if (activeRepoSlug !== undefined) {
    const registered = repos.find(r => r.slug === activeRepoSlug);
    if (registered) {
      return activeRepoSlug;
    }
  }

  if (repos.length === 0) {
    throw new Error(
      'Workspace manifest has no registered repos; cannot resolve a primary repo',
    );
  }

  throw new Error(
    `Workspace manifest has ${repos.length} repos but none is flagged primary ` +
    `and no registered invocation repo was provided; cannot guess (fail-closed, ADR-006)`,
  );
}
