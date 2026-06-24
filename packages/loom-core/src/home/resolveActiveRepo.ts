import { computeRepoSlug } from './repoSlug.js';
import { readManifest, registerRepo, type ManifestEntry } from './workspaceManifest.js';

/**
 * Resolve the active repo from the manifest by matching computeRepoSlug(projectRoot)
 * against entry.slug. Auto-registers (delegates to registerRepo) when the invoked
 * repo is absent. Pure observe-and-record: never throws on the happy path, never
 * alters command behavior.
 *
 * NOTE: The returned `entry.path` is advisory metadata — it reflects the filesystem
 * path at registration time and may be stale after a repo move. Callers must not
 * rely on `entry.path` for filesystem access; use `resolveRepoStatePaths(projectRoot)`
 * to obtain current, verified paths.
 */
export function resolveActiveRepo(loomHome: string, projectRoot: string): ManifestEntry {
  const { slug } = computeRepoSlug(projectRoot);
  const manifest = readManifest(loomHome);
  const existing = manifest.repos.find(r => r.slug === slug);
  if (existing) return existing;
  return registerRepo(loomHome, projectRoot);
}
