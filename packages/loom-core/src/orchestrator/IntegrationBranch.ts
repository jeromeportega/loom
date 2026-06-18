import fs from 'node:fs';
import path from 'node:path';
import { git, gitSafe, hasCommits } from './git.js';
import { linkWorkspaceDeps as defaultLinkWorkspaceDeps } from './linkWorkspaceDeps.js';

export interface IntegrationBranchInfo {
  /** The live integration branch, e.g. epic/epic-001. */
  branch: string;
  /** Absolute path to the dedicated integration worktree. */
  path: string;
  /** Current commit the integration branch points at. */
  tip: string;
}

export interface MergeOutcome {
  /** True when the story branch is now part of epic/<id> (merged or already in). */
  ok: boolean;
  /** True when the merge produced a conflict (or otherwise failed). */
  conflict: boolean;
  /** True when git reported "Already up to date" (idempotent reconcile / resume). */
  alreadyMerged: boolean;
  /** Tail of git's output, for the audit log. */
  output: string;
  /**
   * Repo-relative paths left unmerged by a conflict. Empty unless `conflict`.
   * Only populated (the merge state is preserved) when `mergeStory` is called
   * with `leaveConflict: true` — the integrator (PR 3b) needs both the file
   * list and the live conflict markers to attempt a resolution.
   */
  conflictedFiles: string[];
}

/**
 * The rolling integration branch (policy.agents.integration_branch='rolling').
 *
 * Instead of the EpicFinalizer big-bang-merging every story branch at the end,
 * loom keeps a live `epic/<id>` branch in a dedicated worktree. Workers branch
 * from its tip and each story is merged back the moment it completes, so the
 * next worker builds on real integrated code rather than colliding blind.
 *
 * The worktree lives at `.loom/integration/<epic-id>` — deliberately OUTSIDE
 * `.loom/worktrees/` so the orphan-worktree janitor (which prunes any
 * `.loom/worktrees/*` dir with no agent record) never deletes it mid-run.
 *
 * All merges happen in this worktree, never in the operator's main checkout.
 * Single-writer by construction: only the one Supervisor that holds the epic's
 * dispatch lease merges into `epic/<id>`, and it does so serially between
 * worker completions.
 */
export interface IntegrationBranchOptions {
  /** Injectable for testing; defaults to the real linkWorkspaceDeps. */
  linkDeps?: (worktreeRoot: string) => void;
}

export class IntegrationBranch {
  private repoRoot: string;
  private readonly linkDeps: (worktreeRoot: string) => void;

  constructor(repoRoot: string, opts: IntegrationBranchOptions = {}) {
    this.repoRoot = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : repoRoot;
    this.linkDeps = opts.linkDeps ?? defaultLinkWorkspaceDeps;
  }

  branchName(epicId: string): string {
    return `epic/${epicId}`;
  }

  path(epicId: string): string {
    return path.join(this.repoRoot, '.loom', 'integration', epicId);
  }

  /** Current tip of epic/<id>, or null when the branch does not exist yet. */
  tip(epicId: string): string | null {
    const res = gitSafe(this.repoRoot, ['rev-parse', '--verify', '--quiet', this.branchName(epicId)]);
    return res.ok ? res.output : null;
  }

  /**
   * True when `story/<id>` is an ancestor of `epic/<id>` — i.e. the story's
   * branch has already been merged into the integration branch. Used by the
   * supervisor's resume-time reconciliation to decide whether an agent left
   * in the transient 'integrating' status (set by `integrateStory` before a
   * crash) actually finished its merge-back. False when either branch is
   * missing OR the story is not merged; never throws.
   */
  isStoryMerged(epicId: string, storyId: string): boolean {
    const epicBranch = this.branchName(epicId);
    const storyBranch = `story/${storyId}`;
    if (!gitSafe(this.repoRoot, ['rev-parse', '--verify', '--quiet', epicBranch]).ok) {
      return false;
    }
    if (!gitSafe(this.repoRoot, ['rev-parse', '--verify', '--quiet', storyBranch]).ok) {
      return false;
    }
    // `merge-base --is-ancestor` exits 0 when A is an ancestor of B, 1 when
    // not. Other exit codes (e.g. SHA missing) are treated as not-merged.
    return gitSafe(this.repoRoot, [
      'merge-base',
      '--is-ancestor',
      storyBranch,
      epicBranch,
    ]).ok;
  }

  /**
   * Creates `epic/<id>` at `baseSha` (if absent) and its dedicated worktree (if
   * absent), checked out to the branch. Idempotent: on resume it REUSES an
   * existing branch + worktree rather than resetting — a `branch -f` here would
   * discard every story already merged. Defensively clears a half-finished
   * merge a crash may have left in the worktree so the next merge starts clean.
   */
  ensure(epicId: string, baseSha: string): IntegrationBranchInfo {
    if (!hasCommits(this.repoRoot)) {
      throw new Error('Cannot create an integration branch: the repository has no commits yet.');
    }
    const branch = this.branchName(epicId);
    const wtPath = this.path(epicId);

    const branchExists = gitSafe(this.repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).ok;
    if (!branchExists) {
      const created = gitSafe(this.repoRoot, ['branch', branch, baseSha]);
      if (!created.ok) {
        throw new Error(`Could not create ${branch} at ${baseSha}: ${created.output}`);
      }
    }

    // A valid integration worktree is the ROOT of its own worktree — not merely
    // "inside a work tree" (any subdir of the main repo, e.g. a stale
    // `.loom/integration/<id>` dir, reports that). Compare the resolved
    // top-level: a real linked worktree returns wtPath; a plain subdir returns
    // the main repo root, so it falls through to the rebuild path below.
    const worktreeReady = ((): boolean => {
      if (!fs.existsSync(wtPath)) return false;
      const top = gitSafe(wtPath, ['rev-parse', '--show-toplevel']);
      if (!top.ok) return false;
      try {
        return fs.realpathSync(top.output) === fs.realpathSync(wtPath);
      } catch {
        return false;
      }
    })();
    if (worktreeReady) {
      // Crash recovery: abort any in-progress merge and drop stray changes so a
      // resumed run starts from a clean epic tip. Best-effort.
      gitSafe(wtPath, ['merge', '--abort']);
      gitSafe(wtPath, ['reset', '--hard', branch]);
    } else {
      // A leftover directory that is NOT a valid worktree (a crash between
      // mkdir and `worktree add`, or a stale manual copy) would make
      // `worktree add` refuse to populate a non-empty dir and strand the epic
      // on every retry. Prune stale admin records and clear it so we recover.
      if (fs.existsSync(wtPath)) {
        gitSafe(this.repoRoot, ['worktree', 'prune']);
        fs.rmSync(wtPath, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(wtPath), { recursive: true });
      const add = gitSafe(this.repoRoot, ['worktree', 'add', wtPath, branch]);
      if (!add.ok) {
        throw new Error(`Could not add integration worktree at ${wtPath}: ${add.output}`);
      }
    }

    // Point @loom-ai/* at this worktree's own packages so the gate build resolves
    // freshly built dist here, not the parent checkout's stale copy (ADR-1).
    this.linkDeps(wtPath);

    return { branch, path: wtPath, tip: git(this.repoRoot, ['rev-parse', branch]) };
  }

  /**
   * Merges `story/<storyId>` into `epic/<id>` inside the integration worktree
   * with a `--no-ff` merge commit. "Already up to date" (resume / reconcile) is
   * reported as a successful no-op.
   *
   * On conflict the default is to ABORT so the worktree stays clean and the
   * story's work remains on its own branch (the 3a loud-block path). When
   * `leaveConflict` is set the merge is LEFT in place — MERGE_HEAD intact, the
   * conflict markers in the working tree — so the integrator (3b) can attempt a
   * resolution; the conflicted file list is returned in either case.
   */
  mergeStory(
    epicId: string,
    storyId: string,
    title: string,
    opts: { leaveConflict?: boolean } = {}
  ): MergeOutcome {
    const wtPath = this.path(epicId);
    const storyBranch = `story/${storyId}`;
    const res = gitSafe(wtPath, [
      'merge',
      '--no-ff',
      '-m',
      `Merge ${storyId}: ${title}`,
      storyBranch,
    ]);
    if (res.ok) {
      return {
        ok: true,
        conflict: false,
        alreadyMerged: /already up to date/i.test(res.output),
        output: res.output.slice(-512),
        conflictedFiles: [],
      };
    }
    const conflictedFiles = this.unmergedPaths(epicId);
    if (!opts.leaveConflict) {
      // Abort so subsequent merges (and the worktree) are not left mid-conflict.
      gitSafe(wtPath, ['merge', '--abort']);
    }
    return {
      ok: false,
      conflict: true,
      alreadyMerged: false,
      output: res.output.slice(-512),
      conflictedFiles,
    };
  }

  /** Repo-relative paths with unmerged (conflicted) index entries, if any. */
  unmergedPaths(epicId: string): string[] {
    const res = gitSafe(this.path(epicId), ['diff', '--name-only', '--diff-filter=U']);
    if (!res.ok) return [];
    return res.output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  /**
   * True when any of `files` still carries a git conflict marker. Git considers
   * a path "resolved" the moment it is `git add`ed regardless of content, so an
   * agent that staged a file with markers still left would otherwise slip
   * through — this reads the actual bytes. Missing files (resolved by deletion)
   * count as clean.
   */
  hasConflictMarkers(epicId: string, files: string[]): boolean {
    const wtPath = this.path(epicId);
    // Covers the standard three markers AND the `|||||||` baseline marker git
    // emits under merge.conflictstyle=diff3/zdiff3 — an agent that strips the
    // outer three but leaves the orphaned baseline block must still be rejected.
    const marker = /^(<{7}|\|{7}|={7}|>{7})/m;
    for (const rel of files) {
      const abs = path.join(wtPath, rel);
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (marker.test(content)) return true;
    }
    return false;
  }

  /**
   * Stages everything and commits the in-progress merge with `message`. Used by
   * the integrator once an agent has resolved the conflict markers. `--no-verify`
   * keeps a target repo's pre-commit hook from rejecting the merge commit — the
   * integration gate, not the hook, is the authoritative correctness check here.
   */
  commitResolved(epicId: string, message: string): { ok: boolean; output: string } {
    const wtPath = this.path(epicId);
    const add = gitSafe(wtPath, ['add', '-A']);
    if (!add.ok) return { ok: false, output: add.output.slice(-512) };
    const res = gitSafe(wtPath, ['commit', '--no-verify', '-m', message]);
    return { ok: res.ok, output: res.output.slice(-512) };
  }

  /** Aborts an in-progress merge in the integration worktree (best-effort). */
  abortMerge(epicId: string): void {
    gitSafe(this.path(epicId), ['merge', '--abort']);
  }

  /** Hard-resets the integration worktree (and the epic branch) to `sha`. */
  reset(epicId: string, sha: string): void {
    gitSafe(this.path(epicId), ['reset', '--hard', sha]);
  }

  /** Removes the integration worktree, keeping the `epic/<id>` branch. */
  remove(epicId: string): void {
    const wtPath = this.path(epicId);
    if (fs.existsSync(wtPath)) {
      gitSafe(this.repoRoot, ['worktree', 'remove', '--force', wtPath]);
    }
    gitSafe(this.repoRoot, ['worktree', 'prune']);
  }

  /** Removes the worktree AND deletes the branch — for an epic that merged nothing. */
  removeBranch(epicId: string): void {
    this.remove(epicId);
    gitSafe(this.repoRoot, ['branch', '-D', this.branchName(epicId)]);
  }
}
