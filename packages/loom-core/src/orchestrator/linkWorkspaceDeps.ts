import fs from 'node:fs';
import path from 'node:path';

/**
 * Re-points the throwaway integration worktree's @loom-ai/* resolution at its
 * OWN freshly built packages instead of climbing to the parent checkout's stale
 * dist (ADR-1). Creates `<worktreeRoot>/node_modules/@loom-ai/core` and `.../web`
 * as symlinks to `../../packages/{loom-core,loom-web}` respectively. Idempotent.
 */
export function linkWorkspaceDeps(worktreeRoot: string): void {
  const scopeDir = path.join(worktreeRoot, 'node_modules', '@loom-ai');
  fs.mkdirSync(scopeDir, { recursive: true });

  const entries = [
    ['core', 'loom-core'],
    ['web', 'loom-web'],
  ] as const;

  for (const [name, pkg] of entries) {
    const linkPath = path.join(scopeDir, name);
    // Relative so the worktree remains portable if moved.
    const target = path.join('..', '..', 'packages', pkg);

    try {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink() && fs.readlinkSync(linkPath) === target) {
        continue; // already correct
      }
      if (st.isSymbolicLink()) {
        fs.unlinkSync(linkPath);
      } else {
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
    } catch {
      // path does not exist — fall through to create
    }

    fs.symlinkSync(target, linkPath);
  }
}
