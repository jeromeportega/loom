import fs from 'node:fs';
import path from 'node:path';
import { gitSafe, isGitRepo } from '../orchestrator/git.js';

export interface EnsureResult {
  path: string;
  created: boolean;
  initialized: boolean;
  reused: boolean;
}

const GITIGNORE_CONTENT = `# loom-home: machine-local namespaces (not pushed in Phase 1)
*.log
.DS_Store
`;

/**
 * Guards against nested-repo corruption: throws when loomHomePath is inside
 * a .git directory (any path component is ".git") or is a strict subdirectory
 * of an existing git repository.
 */
function guardAgainstNesting(loomHomePath: string): void {
  const parts = loomHomePath.split(path.sep);
  if (parts.includes('.git')) {
    throw new Error(
      `ensureLoomHome: path is inside a .git directory: ${loomHomePath}`,
    );
  }

  // Walk up to the nearest existing ancestor to detect enclosing git repos.
  let ancestor = loomHomePath;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root
    ancestor = parent;
  }

  const res = gitSafe(ancestor, ['rev-parse', '--show-toplevel']);
  if (res.ok) {
    // Resolve symlinks in both paths so platform-specific symlinks
    // (e.g. /var/folders → /private/var/folders on macOS) don't break the check.
    const repoRoot = fs.realpathSync(ancestor);
    const rel = path.relative(ancestor, loomHomePath);
    const loomHomeReal = path.join(repoRoot, rel);
    const gitTopLevel = fs.realpathSync(res.output);
    if (loomHomeReal.startsWith(gitTopLevel + path.sep)) {
      throw new Error(
        `ensureLoomHome: path is inside an existing git repository (${repoRoot}): ${loomHomePath}`,
      );
    }
  }
}

/**
 * Idempotent: ensures loom-home exists as a git repository at loomHomePath.
 *
 * - Absent directory → mkdir -p + git init (created + initialized).
 * - Existing git repo → reuse without re-init (reused).
 * - Existing non-git directory → init-in-place (initialized); existing
 *   content is preserved.
 *
 * Throws when the resolved path is inside an existing git repository or
 * inside any .git directory (nested-repo guard).
 */
export function ensureLoomHome(loomHomePath: string): EnsureResult {
  guardAgainstNesting(loomHomePath);

  const dirExists = fs.existsSync(loomHomePath);

  if (!dirExists) {
    fs.mkdirSync(loomHomePath, { recursive: true });
    gitSafe(loomHomePath, ['init']);
    fs.writeFileSync(path.join(loomHomePath, '.gitignore'), GITIGNORE_CONTENT, 'utf8');
    return { path: loomHomePath, created: true, initialized: true, reused: false };
  }

  if (isGitRepo(loomHomePath)) {
    return { path: loomHomePath, created: false, initialized: false, reused: true };
  }

  // Existing non-git directory → init in place.
  gitSafe(loomHomePath, ['init']);
  return { path: loomHomePath, created: false, initialized: true, reused: false };
}
