import type { Story } from '../types.js';
import type { WorkspaceManifest } from '../home/workspaceManifest.js';

/**
 * Resolve the target repo for a story.
 *
 * If the story declares a `repo` slug, that slug is used.
 * Otherwise the provided `primarySlug` (from resolvePrimaryRepo) is used.
 *
 * Returns the slug and its realpath root from the manifest entry — the manifest
 * stores `path` as fs.realpathSync(projectRoot), so the root is already
 * canonical (matches what epic-057 resolveRegisteredRepo would return).
 *
 * Throws if the resolved slug is not registered in the manifest.
 */
export function resolveStoryRepo(
  story: Story,
  manifest: WorkspaceManifest,
  primarySlug: string,
): { slug: string; root: string } {
  const slug = story.repo ?? primarySlug;
  const entry = manifest.repos.find(r => r.slug === slug);
  if (!entry) {
    throw new Error(
      `Story "${story.id}" targets repo "${slug}" which is not registered in the workspace manifest`,
    );
  }
  return { slug: entry.slug, root: entry.path };
}
