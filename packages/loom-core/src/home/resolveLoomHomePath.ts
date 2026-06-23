import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Policy } from '../types.js';

/**
 * Returns the absolute path to the loom-home repository.
 *
 * Default: sibling directory at the workspace root — the immediate parent of
 * projectRoot joined with 'loom-home' (ADR-2 heuristic). projectRoot is
 * resolved through symlinks first so that platform aliases (e.g. /var →
 * /private/var on macOS) always produce the same sibling path regardless of
 * whether the caller holds a symlink path or a real path.
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
  // Resolve symlinks so /var/folders/... (macOS os.tmpdir) and
  // /private/var/folders/... (process.cwd() in subprocesses) produce the
  // same sibling loom-home path.
  const realRoot = (() => { try { return fs.realpathSync(projectRoot); } catch { return projectRoot; } })();
  return path.join(path.dirname(realRoot), 'loom-home');
}
