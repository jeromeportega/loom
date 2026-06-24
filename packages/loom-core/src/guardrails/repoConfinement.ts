import fs from 'node:fs';
import path from 'node:path';

/**
 * Thrown by assertConfinedWrite when a target path escapes the worker's own
 * worktree. Confinement itself is structural via WorktreeContext (set at
 * Supervisor.dispatch) + PolicyEngine.checkCrossRepoAccess; this error is the
 * assertion seam for the confinement proof test.
 */
export class ConfinementViolation extends Error {
  constructor(
    readonly targetPath: string,
    readonly ownWorktree: string,
  ) {
    super(
      `Confinement violation: "${targetPath}" escapes own worktree "${ownWorktree}"`,
    );
    this.name = 'ConfinementViolation';
  }
}

/**
 * Assertion seam used by the confinement test (story-058-007).
 *
 * Throws ConfinementViolation when targetPath resolves outside ownWorktree.
 * This is NOT the enforcement path — confinement is structural via:
 *   WorktreeContext.worktreeRoot (set in Supervisor.dispatch, story-058-002)
 *   + PolicyEngine.checkCrossRepoAccess (epic-057, reused unchanged)
 *
 * Use assertConfinedWrite in tests only to make the boundary explicit.
 */
export function assertConfinedWrite(targetPath: string, ownWorktree: string): void {
  let resolved: string;
  try {
    resolved = fs.realpathSync(targetPath);
  } catch {
    resolved = path.resolve(targetPath);
  }

  let own: string;
  try {
    own = fs.realpathSync(ownWorktree);
  } catch {
    own = path.resolve(ownWorktree);
  }

  if (resolved !== own && !resolved.startsWith(own + path.sep)) {
    throw new ConfinementViolation(targetPath, ownWorktree);
  }
}
