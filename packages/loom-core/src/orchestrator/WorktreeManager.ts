import fs from 'node:fs';
import path from 'node:path';
import { git, gitSafe, hasCommits } from './git.js';
import type { WorkerLogStore } from '../state/WorkerLogStore.js';

export interface WorktreeInfo {
  storyId: string;
  path: string;
  branch: string;
  /** Commit the branch diverged from — used to count the worker's commits. */
  baseSha: string;
}

/**
 * Manages per-story git worktrees under `.loom/worktrees/`. Each story gets an
 * isolated working tree on its own `story/<id>` branch, so concurrent worker
 * agents never touch each other's files or the main working tree.
 */
export class WorktreeManager {
  private repoRoot: string;
  private workerLogs?: WorkerLogStore;

  constructor(repoRoot: string, workerLogs?: WorkerLogStore) {
    // Canonicalize: `git worktree list` reports realpaths, so a symlinked repo
    // root (e.g. macOS /var -> /private/var) would break startsWith() matching.
    this.repoRoot = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : repoRoot;
    this.workerLogs = workerLogs;
  }

  worktreesDir(): string {
    return path.join(this.repoRoot, '.loom', 'worktrees');
  }

  branchName(storyId: string): string {
    return `story/${storyId}`;
  }

  worktreePath(storyId: string): string {
    return path.join(this.worktreesDir(), storyId);
  }

  /**
   * Creates (or returns, if it already exists) the worktree for a story.
   * Idempotent — safe to call on a story that is being retried.
   *
   * @param opts.fromBranch start the story branch from this ref instead of the
   *   repo's current HEAD. The Supervisor uses this so a dependent story's
   *   worktree already contains its dependency's committed work.
   */
  create(storyId: string, opts: { fromBranch?: string } = {}): WorktreeInfo {
    if (!hasCommits(this.repoRoot)) {
      throw new Error(
        'Cannot create a worktree: the repository has no commits yet. ' +
          'Make at least one commit before running loom.'
      );
    }

    const wtPath = this.worktreePath(storyId);
    const branch = this.branchName(storyId);

    if (fs.existsSync(wtPath)) {
      return {
        storyId,
        path: wtPath,
        branch,
        baseSha: gitSafe(this.repoRoot, ['merge-base', branch, 'HEAD']).output,
      };
    }

    fs.mkdirSync(this.worktreesDir(), { recursive: true });

    // Start point: a dependency's branch when given, else the current HEAD.
    // Fall back to HEAD if the requested ref does not resolve.
    let startPoint = 'HEAD';
    if (opts.fromBranch) {
      const resolved = gitSafe(this.repoRoot, ['rev-parse', '--verify', opts.fromBranch]);
      if (resolved.ok) startPoint = opts.fromBranch;
    }
    const baseSha = git(this.repoRoot, ['rev-parse', startPoint]);

    const branchExists = gitSafe(this.repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).ok;

    if (branchExists) {
      // Reuse the existing branch (a prior, possibly interrupted, attempt).
      git(this.repoRoot, ['worktree', 'add', wtPath, branch]);
    } else {
      git(this.repoRoot, ['worktree', 'add', wtPath, '-b', branch, startPoint]);
    }

    return { storyId, path: wtPath, branch, baseSha };
  }

  /** Lists active loom-managed worktrees (those under `.loom/worktrees/`). */
  list(): WorktreeInfo[] {
    const res = gitSafe(this.repoRoot, ['worktree', 'list', '--porcelain']);
    if (!res.ok) return [];

    const infos: WorktreeInfo[] = [];
    let currentPath: string | null = null;
    let currentBranch: string | null = null;

    const flush = (): void => {
      if (currentPath && currentPath.startsWith(this.worktreesDir())) {
        const branch = currentBranch ?? '';
        infos.push({
          storyId: path.basename(currentPath),
          path: currentPath,
          branch,
          baseSha: branch
            ? gitSafe(this.repoRoot, ['merge-base', branch, 'HEAD']).output
            : '',
        });
      }
      currentPath = null;
      currentBranch = null;
    };

    for (const line of res.output.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        currentPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch '.length).trim().replace('refs/heads/', '');
      }
    }
    flush();
    return infos;
  }

  /**
   * Removes a story's worktree. By default the branch is kept so its commits
   * survive for review; pass deleteBranch to drop it too.
   */
  remove(storyId: string, opts: { deleteBranch?: boolean } = {}): void {
    const wtPath = this.worktreePath(storyId);
    if (fs.existsSync(wtPath)) {
      gitSafe(this.repoRoot, ['worktree', 'remove', '--force', wtPath]);
    }
    // Prune any stale administrative entries.
    gitSafe(this.repoRoot, ['worktree', 'prune']);

    if (opts.deleteBranch) {
      gitSafe(this.repoRoot, ['branch', '-D', this.branchName(storyId)]);
    }

    this.workerLogs?.remove(storyId);
  }
}
