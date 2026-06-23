import path from 'node:path';
import type { Policy } from '../types.js';
import { resolveLoomHomePath } from './resolveLoomHomePath.js';
import { computeRepoSlug } from './repoSlug.js';

export interface RepoStatePaths {
  namespaceDir: string;
  dbPath: string;
  planningRoot: string;
}

export interface MigrationResult {
  migrated: boolean;
  from: string | null;
  to: string;
  method: 'rename' | 'copy' | null;
}

export function resolveRepoStatePaths(
  projectRoot: string,
  policy: Pick<Policy, 'loom_home'>,
): RepoStatePaths {
  const loomHome = resolveLoomHomePath(projectRoot, policy);
  const resolvedHome = path.resolve(loomHome);
  const { slug } = computeRepoSlug(projectRoot);
  const namespaceDir = path.resolve(resolvedHome, 'repos', slug);

  if (!namespaceDir.startsWith(resolvedHome + path.sep)) {
    throw new Error(`slug resolves outside loomHome — possible path traversal: ${slug}`);
  }

  return {
    namespaceDir,
    dbPath: path.join(namespaceDir, 'loom.db'),
    planningRoot: path.join(namespaceDir, 'planning'),
  };
}
