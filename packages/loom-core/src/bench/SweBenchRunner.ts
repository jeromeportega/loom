import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SweBenchTask, SweBenchTaskResult } from './types.js';

export interface SweBenchRunnerOptions {
  /**
   * Per-task callback that runs loom end-to-end inside the given repo
   * directory (already checked out at base_commit). The runner separates
   * git orchestration from loom orchestration so it can be tested with
   * a deterministic stub and so future runners (eg. cursor-backend) can
   * reuse the cloning logic.
   */
  runLoom: (ctx: {
    repoDir: string;
    task: SweBenchTask;
  }) => Promise<{ commitCount: number; error?: string }>;
  /** Override for `git`. Lets tests inject a stub. */
  gitBin?: string;
  /** Override for the clone host. Lets tests inject a local file:// clone. */
  cloneUrl?: (repo: string) => string;
  /** Stdout sink for progress lines. Defaults to console.log. */
  onProgress?: (line: string) => void;
  /**
   * When set, tasks that fail to produce a patch (errored OR empty patch)
   * keep their tempdir on disk and report the path in the result. Lets the
   * operator `cd` in and inspect the worker state for the django-11019-style
   * "Worker exited with code 1 and made no commits" mystery cases.
   * Successful tasks always clean up; preserve only kicks in on failure.
   */
  preserveFailures?: boolean;
  /**
   * When set, every task's tempdir is preserved regardless of loom's own
   * pass/fail signal. This catches the loom-passes-but-bench-fails class:
   * a non-empty patch that the official SWE-bench harness later reports as
   * unresolved (eg. django-11019, where the wider rewrite passed the named
   * tests but broke adjacent ones). `preserveFailures` is a strict subset.
   */
  preserveAll?: boolean;
}

/**
 * Runs SWE-bench tasks one at a time. The lifecycle:
 *   1. Clone the repo into a temp dir.
 *   2. Checkout the base commit.
 *   3. Hand off to `runLoom` (which chains `loom init` + `loom epic` + `loom approve` + `loom run`).
 *   4. Capture `git diff base_commit..HEAD` as the prediction.
 *
 * Each task gets its own tempdir; cleanup is best-effort.
 */
export class SweBenchRunner {
  constructor(private opts: SweBenchRunnerOptions) {}

  async runOne(task: SweBenchTask): Promise<SweBenchTaskResult> {
    const start = Date.now();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-swe-'));
    const log = this.opts.onProgress ?? ((l: string) => console.log(l));
    log(`  → ${task.instance_id}  (${task.repo}@${task.base_commit.slice(0, 7)})`);

    // Build the result, then decide whether to clean up or preserve.
    // Doing cleanup in a finally-block would race with the failure check.
    let result: SweBenchTaskResult;
    try {
      this.clone(task, tmpRoot);
      this.checkout(tmpRoot, task.base_commit);

      const { commitCount, error } = await this.opts.runLoom({
        repoDir: tmpRoot,
        task,
      });
      if (error) {
        result = {
          instanceId: task.instance_id,
          patch: '',
          commitCount,
          durationMs: Date.now() - start,
          error,
        };
      } else {
        const patch = this.captureDiff(tmpRoot, task.base_commit);
        result = {
          instanceId: task.instance_id,
          patch,
          commitCount,
          durationMs: Date.now() - start,
        };
      }
    } catch (err) {
      result = {
        instanceId: task.instance_id,
        patch: '',
        commitCount: 0,
        durationMs: Date.now() - start,
        error: (err as Error).message,
      };
    }

    const isFailure = !!result.error || result.patch.length === 0;
    if (this.opts.preserveAll) {
      result.preservedPath = tmpRoot;
      log(`    ⓘ ${task.instance_id} preserved at ${tmpRoot} (preserveAll)`);
    } else if (this.opts.preserveFailures && isFailure) {
      result.preservedPath = tmpRoot;
      log(`    ⓘ ${task.instance_id} failed — preserved at ${tmpRoot}`);
    } else {
      this.cleanup(tmpRoot);
    }
    return result;
  }

  /**
   * Removes the per-task tempdir. Loom runs create git worktrees under
   * `.loom/worktrees/` whose internal file handles may not be fully
   * released the instant `runLoom` resolves — so a naive `rmSync` can
   * race and throw ENOTEMPTY on a worktree subdirectory.
   *
   * Two-stage cleanup:
   *   1. Best-effort `git worktree remove --force` on every worktree
   *      under `.loom/worktrees/`. Drops the worktree admin records
   *      so the directories are safe to delete without git complaining.
   *   2. `fs.rmSync` with retries — the v14.14+ `maxRetries` /
   *      `retryDelay` options handle transient ENOTEMPTY by retrying
   *      the removal instead of bailing.
   */
  private cleanup(tmpRoot: string): void {
    const worktreesDir = path.join(tmpRoot, '.loom', 'worktrees');
    if (fs.existsSync(worktreesDir)) {
      try {
        for (const entry of fs.readdirSync(worktreesDir)) {
          const wt = path.join(worktreesDir, entry);
          try {
            execFileSync(this.opts.gitBin ?? 'git', ['worktree', 'remove', '--force', wt], {
              cwd: tmpRoot,
              stdio: 'ignore',
            });
          } catch {
            // The worktree command may fail (e.g. wt was already removed,
            // or git can't find the parent) — fall through; rmSync below
            // will handle the cleanup with retries.
          }
        }
      } catch {
        // readdirSync failed — fall through to rmSync.
      }
    }
    try {
      fs.rmSync(tmpRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      // After retries: log and move on. Leftover tempdirs are
      // /tmp-resident and get cleared on reboot; never fail a bench
      // run because cleanup raced.
    }
  }

  private clone(task: SweBenchTask, dest: string): void {
    const url = this.opts.cloneUrl
      ? this.opts.cloneUrl(task.repo)
      : `https://github.com/${task.repo}.git`;
    execFileSync(this.opts.gitBin ?? 'git', ['clone', '--quiet', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private checkout(repoDir: string, sha: string): void {
    execFileSync(this.opts.gitBin ?? 'git', ['checkout', '--quiet', sha], {
      cwd: repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /**
   * Returns the unified diff from `base..HEAD`, with loom-internal artifacts
   * filtered out (`.loom/`, `.loom_outputs/`, `.loom-notes/`). When loom
   * ran in per-epic PR mode the EpicFinalizer commits planning artifacts into
   * `.loom_outputs/<epic-id>/` — that is correct for normal loom use (a
   * delivered record alongside the code) but pollutes a SWE-bench prediction,
   * which should be application code only.
   *
   * Pathspec `:(exclude)<path>` is git's documented way to exclude directories
   * from a diff; it correctly recurses into the named dir without needing a
   * wildcard.
   *
   * Also resolves HEAD to the most recent `refs/heads/epic/*` branch when
   * present — per-epic PR strategy leaves work on `epic/<id>`, not HEAD.
   */
  private captureDiff(repoDir: string, base: string): string {
    const head = this.resolveHead(repoDir, base);
    try {
      return execFileSync(
        this.opts.gitBin ?? 'git',
        [
          'diff',
          `${base}..${head}`,
          '--',
          // Loom meta-directories — never part of the actual code change.
          ':(exclude).loom',
          ':(exclude).loom_outputs',
          ':(exclude).loom-notes',
          // Loom integration files written by `loom init`.
          ':(exclude).claude',
          ':(exclude).mcp.json',
          ':(exclude).cursor',
          ':(exclude)CLAUDE.md',
        ],
        {
          cwd: repoDir,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024, // big diffs are real
        }
      );
    } catch {
      return '';
    }
  }

  private resolveHead(repoDir: string, base: string): string {
    // (1) Per-epic PR strategy — work lives on epic/<id>.
    try {
      const branches = execFileSync(
        this.opts.gitBin ?? 'git',
        ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/epic/'],
        { cwd: repoDir, encoding: 'utf8' }
      ).trim();
      const first = branches.split('\n')[0]?.trim();
      if (first && first.length > 0) return first;
    } catch {
      // No epic/* branches — fall through to story-branch merge.
    }

    // (2) Partial-epic-success fallback. EpicFinalizer requires every story
    // to succeed before it builds the epic branch; if one story failed the
    // others' commits are stranded on story/<id> branches. For the bench,
    // we want WHATEVER work the worker produced — surface it by merging
    // every story branch with commits past `base` onto a synthetic
    // `swe-bench-capture` branch, in dependency order. Conflict-on-merge
    // skips the conflicting branch and continues (rare for SWE-bench
    // tasks where each story touches different surface area). Returns the
    // synthetic branch name when at least one merge succeeded.
    try {
      const storyBranches = execFileSync(
        this.opts.gitBin ?? 'git',
        [
          'for-each-ref',
          '--format=%(refname:short)',
          '--sort=committerdate',
          'refs/heads/story/',
        ],
        { cwd: repoDir, encoding: 'utf8' }
      )
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const branchesWithCommits = storyBranches.filter((br) => {
        try {
          const cnt = execFileSync(
            this.opts.gitBin ?? 'git',
            ['rev-list', '--count', `${base}..${br}`],
            { cwd: repoDir, encoding: 'utf8' }
          ).trim();
          return parseInt(cnt, 10) > 0;
        } catch {
          return false;
        }
      });

      if (branchesWithCommits.length > 0) {
        const synthetic = 'swe-bench-capture';
        // Create / reset the synthetic branch at base.
        execFileSync(this.opts.gitBin ?? 'git', ['checkout', '-q', base], { cwd: repoDir });
        execFileSync(this.opts.gitBin ?? 'git', ['checkout', '-q', '-B', synthetic], { cwd: repoDir });
        execFileSync(this.opts.gitBin ?? 'git', ['config', 'user.email', 'bench@loom.local'], { cwd: repoDir });
        execFileSync(this.opts.gitBin ?? 'git', ['config', 'user.name', 'loom-bench'], { cwd: repoDir });
        let merged = 0;
        for (const br of branchesWithCommits) {
          try {
            execFileSync(
              this.opts.gitBin ?? 'git',
              ['merge', '--no-ff', '--no-edit', '-q', br],
              { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] }
            );
            merged += 1;
          } catch {
            // Conflict — abort this merge and move on. The other story
            // branches' work still surfaces in the captured diff.
            try {
              execFileSync(this.opts.gitBin ?? 'git', ['merge', '--abort'], {
                cwd: repoDir,
                stdio: 'ignore',
              });
            } catch {
              /* nothing to abort if the merge errored before starting */
            }
          }
        }
        if (merged > 0) return synthetic;
      }
    } catch {
      // No story/* branches either — fall through.
    }

    return 'HEAD';
  }
}

/**
 * Serializes a list of task results into the official SWE-bench predictions
 * shape. Tasks that errored before loom produced a patch are still emitted
 * (with an empty patch) so the official harness sees them as unresolved
 * rather than missing.
 */
export function writePredictions(
  outputPath: string,
  results: SweBenchTaskResult[],
  modelName = 'loom'
): void {
  const predictions = results.map((r) => ({
    instance_id: r.instanceId,
    model_patch: r.patch,
    model_name_or_path: modelName,
  }));
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(predictions, null, 2) + '\n');
}
