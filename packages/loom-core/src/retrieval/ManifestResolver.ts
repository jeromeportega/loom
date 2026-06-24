import fs from 'node:fs';
import { readManifest } from '../home/workspaceManifest.js';
import { computeRepoSlug } from '../home/repoSlug.js';
import { ResolvedRepo, RetrievalRefused, CROSS_REPO_RULES } from './types.js';

/**
 * Resolve a registered slug to its verified on-disk root.
 *
 * Fail-closed invariant: every refusal path throws RetrievalRefused — no fallback,
 * no broader search. The call either returns a fully identity-verified ResolvedRepo
 * or throws.
 */
export function resolveRegisteredRepo(loomHome: string, slug: string): ResolvedRepo {
  const manifest = readManifest(loomHome);
  const entry = manifest.repos.find(r => r.slug === slug);

  if (!entry) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.UNREGISTERED,
      `Repository "${slug}" is not registered in the workspace manifest`,
    );
  }

  // Canonicalize path — handles symlinks in entry.path (e.g. hand-edited manifests).
  let realpath: string;
  try {
    realpath = fs.realpathSync(entry.path);
  } catch {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Registered path for "${slug}" no longer exists: ${entry.path}`,
    );
  }

  // Confirm it is a directory, not a file.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realpath);
  } catch {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Cannot stat registered path for "${slug}": ${realpath}`,
    );
  }

  if (!stat.isDirectory()) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Registered path for "${slug}" resolves to a file, not a directory: ${realpath}`,
    );
  }

  // Identity check: re-derive slug from the on-disk realpath.
  // A mismatch means the path was swapped or replaced with a different repo (TOCTOU/T6).
  const { slug: derivedSlug } = computeRepoSlug(realpath);
  if (derivedSlug !== entry.slug) {
    throw new RetrievalRefused(
      CROSS_REPO_RULES.STALE_PATH,
      `Repository at "${realpath}" re-derives slug "${derivedSlug}" but manifest expects "${slug}" — path may have been replaced`,
    );
  }

  return { slug: entry.slug, root: realpath };
}

/**
 * Return the verified realpath roots of ALL registered repos whose on-disk identity
 * still matches the manifest. Stale or identity-mismatched entries are silently
 * excluded — callers (e.g. the guard) must not assume every manifest entry is present.
 */
export function listWorkspaceRoots(loomHome: string): string[] {
  const manifest = readManifest(loomHome);
  const roots: string[] = [];

  for (const entry of manifest.repos) {
    try {
      const realpath = fs.realpathSync(entry.path);
      const stat = fs.statSync(realpath);
      if (!stat.isDirectory()) continue;
      const { slug } = computeRepoSlug(realpath);
      if (slug !== entry.slug) continue;
      roots.push(realpath);
    } catch {
      // Stale or unresolvable entry — skip without throwing.
    }
  }

  return roots;
}
