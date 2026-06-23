import os from 'node:os';
import path from 'node:path';
import type { Policy } from '../types.js';

/**
 * Returns the absolute path to the loom-home repository.
 *
 * Default: sibling directory at the workspace root — the immediate parent of
 * projectRoot joined with 'loom-home' (ADR-2 heuristic).
 *
 * Override: policy.loom_home, with leading '~' expanded to os.homedir().
 */
export function resolveLoomHomePath(
  projectRoot: string,
  policy: Pick<Policy, 'loom_home'>,
): string {
  if (policy.loom_home) {
    const raw = policy.loom_home;
    if (raw.startsWith('~/') || raw === '~') {
      return path.join(os.homedir(), raw.slice(1));
    }
    return raw;
  }
  return path.join(path.dirname(projectRoot), 'loom-home');
}
