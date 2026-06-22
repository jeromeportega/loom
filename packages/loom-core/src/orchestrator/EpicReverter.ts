import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore, AuditLog } from '../state/index.js';
import { gitSafe, defaultRemote, remoteUrl } from './git.js';
import { minimatch } from 'minimatch';

export interface EpicReverterOptions {
  projectRoot: string;
  db: Database.Database;
  /**
   * `policy.git.allowed_remotes` — gates whether `--remote` may touch the
   * upstream. Without an allowlist match the remote teardown is blocked
   * regardless of the operator's flag, same gate the workers and finalizer
   * already honor.
   */
  allowedRemotes: string[];
  /** Override the git binary. Lets tests stub. */
  gitBin?: string;
  /** Override the gh binary. Lets tests stub. */
  ghBin?: string;
}

export interface RevertOptions {
  /**
   * When true, also delete the remote epic branch and close any open PR
   * loom opened for this epic. When false (default), local-only revert —
   * the remote ref + PR survive for the operator to deal with manually.
   * The remote operation requires the project's remote to match
   * allowed_remotes.
   */
  remote?: boolean;
  /** Optional explanation logged with the revert. */
  reason?: string;
}

export interface RevertResult {
  /**
   *   - 'reverted'   — local (and optionally remote) cleanup succeeded
   *   - 'partial'    — local cleanup succeeded but the remote step errored
   *   - 'skipped'    — nothing to revert (epic doesn't exist or already rejected)
   *   - 'failed'     — couldn't load epic / nothing happened
   */
  status: 'reverted' | 'partial' | 'skipped' | 'failed';
  /** Local refs successfully deleted (epic + any leftover story branches). */
  deleted_refs: string[];
  /** Remote refs successfully deleted (only populated when remote=true). */
  deleted_remote_refs: string[];
  /** PR URLs loom attempted to close (and the outcome per URL). */
  pr_closures: Array<{ url: string; closed: boolean; error?: string }>;
  note: string;
}

/**
 * Tears down an epic locally (delete epic + story branches, flip DB state)
 * and optionally on the remote (push -d the epic branch, close the PR).
 * The destructive nature is the whole point of the command — every action
 * is recorded in audit_log so the operator can retrace what got removed.
 */
export class EpicReverter {
  constructor(private opts: EpicReverterOptions) {}

  revert(epicId: string, revertOpts: RevertOptions = {}): RevertResult {
    const epicStore = new EpicStore(this.opts.db);
    const agentStore = new AgentStore(this.opts.db);
    const audit = new AuditLog(this.opts.db);
    const gitBin = this.opts.gitBin ?? 'git';
    const ghBin = this.opts.ghBin ?? 'gh';

    const epic = epicStore.get(epicId);
    if (!epic) {
      return {
        status: 'skipped',
        deleted_refs: [],
        deleted_remote_refs: [],
        pr_closures: [],
        note: `Epic "${epicId}" not found — nothing to revert.`,
      };
    }

    // Collect what we're going to touch: the epic branch + every story
    // branch tied to one of this epic's agents. The cleanup at finalize
    // time normally removes the story branches, but we re-target them
    // here in case finalize didn't run or some weren't merged.
    const agents = agentStore.listByEpic(epicId);
    const epicBranch = `epic/${epicId}`;
    const storyBranches = agents.map((a) => `story/${a.story_id}`);
    const targetBranches = [epicBranch, ...storyBranches];

    // Remove lingering worktrees before deleting branches.
    // Order is load-bearing: worktree removal → prune → branch delete.
    // Reversing this order reproduces the original crash.
    const worktreePaths = [
      path.join(this.opts.projectRoot, '.loom', 'integration', epicId),
      ...agents.map((a) =>
        path.join(this.opts.projectRoot, '.loom', 'worktrees', a.story_id),
      ),
    ];
    for (const wt of worktreePaths) {
      const result = gitSafe(this.opts.projectRoot, ['worktree', 'remove', wt]);
      if (!result.ok) {
        // Worktree already gone — treat as success for idempotency.
        const msg = result.output.toLowerCase();
        const alreadyGone =
          msg.includes('is not a working tree') ||
          msg.includes('does not exist') ||
          msg.includes('no such file');
        if (!alreadyGone) {
          // Dirty worktree or unexpected failure — surface it so uncommitted
          // work is not silently discarded.
          throw new Error(`Failed to remove worktree at ${wt}: ${result.output}`);
        }
      }
    }
    // Prune stale worktree metadata after removals, before branch deletes.
    gitSafe(this.opts.projectRoot, ['worktree', 'prune']);

    const deletedRefs: string[] = [];
    for (const branch of targetBranches) {
      // Best-effort: delete may fail because the branch doesn't exist
      // (already cleaned) — that's not an error for revert purposes.
      const exists = gitSafe(this.opts.projectRoot, [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`,
      ]);
      if (!exists.ok) continue;
      const del = execFileSync(gitBin, ['branch', '-D', branch], {
        cwd: this.opts.projectRoot,
        encoding: 'utf8',
      });
      void del;
      deletedRefs.push(branch);
    }

    let status: RevertResult['status'] = 'reverted';
    const deletedRemoteRefs: string[] = [];
    const prClosures: RevertResult['pr_closures'] = [];

    if (revertOpts.remote) {
      const remote = defaultRemote(this.opts.projectRoot);
      const url = remote ? remoteUrl(this.opts.projectRoot, remote) : undefined;
      if (!remote || !url) {
        status = 'partial';
      } else if (!this.remoteAllowed(url)) {
        status = 'partial';
      } else {
        // Remote epic branch: best-effort push -d. Errors here mean either
        // the branch never landed or someone deleted it already — either
        // way the revert is informationally complete.
        try {
          execFileSync(gitBin, ['push', remote, '-d', epicBranch], {
            cwd: this.opts.projectRoot,
            encoding: 'utf8',
          });
          deletedRemoteRefs.push(`${remote}/${epicBranch}`);
        } catch (err) {
          status = 'partial';
          audit.record({
            agent_id: undefined,
            action: 'epic_revert_remote_branch',
            command: epicId,
            allowed: false,
            detail: { error: (err as Error).message },
          });
        }

        // PR closure: pull every audit row that recorded a PR for this
        // epic and ask gh to close each. Per-URL outcome so the operator
        // can retry the failing ones.
        const prUrls = collectPrUrls(audit, epicId);
        for (const prUrl of prUrls) {
          try {
            execFileSync(ghBin, ['pr', 'close', prUrl], {
              cwd: this.opts.projectRoot,
              encoding: 'utf8',
            });
            prClosures.push({ url: prUrl, closed: true });
          } catch (err) {
            prClosures.push({ url: prUrl, closed: false, error: (err as Error).message });
            status = 'partial';
          }
        }
      }
    }

    // Flip epic status — 'rejected' is the existing terminal state for
    // "we don't want this." Carries the operator's reason for the record.
    epicStore.updateStatus(epicId, 'rejected', revertOpts.reason ?? 'reverted by operator');

    audit.record({
      agent_id: undefined,
      action: 'epic_revert',
      command: epicId,
      allowed: true,
      detail: {
        reason: revertOpts.reason ?? null,
        remote: revertOpts.remote === true,
        deleted_refs: deletedRefs,
        deleted_remote_refs: deletedRemoteRefs,
        pr_closures: prClosures,
        status,
      },
    });

    const noteParts = [
      `Reverted ${epicId}.`,
      deletedRefs.length > 0
        ? `Local refs deleted: ${deletedRefs.join(', ')}.`
        : 'No local refs needed deletion.',
    ];
    if (revertOpts.remote) {
      if (deletedRemoteRefs.length > 0) {
        noteParts.push(`Remote refs deleted: ${deletedRemoteRefs.join(', ')}.`);
      }
      if (prClosures.length > 0) {
        const ok = prClosures.filter((p) => p.closed).length;
        noteParts.push(`PRs closed: ${ok}/${prClosures.length}.`);
      }
    }

    return {
      status,
      deleted_refs: deletedRefs,
      deleted_remote_refs: deletedRemoteRefs,
      pr_closures: prClosures,
      note: noteParts.join(' '),
    };
  }

  private remoteAllowed(url: string): boolean {
    if (this.opts.allowedRemotes.length === 0) return false;
    return this.opts.allowedRemotes.some((pattern) => minimatch(url, pattern));
  }
}

/**
 * Scrape every PR URL we ever recorded for this epic out of the audit log.
 * The EpicFinalizer writes 'epic_finalize' rows with prUrl in detail and
 * 'epic_finalize_pr_failed' rows on failure; the per-story-PR path writes
 * 'open_pr' rows. We pick up the success rows here — failed-to-open PRs
 * have no URL to close.
 */
function collectPrUrls(audit: AuditLog, epicId: string): string[] {
  const urls = new Set<string>();
  for (const row of audit.recent(500)) {
    if (row.action !== 'epic_finalize') continue;
    if (!row.detail) continue;
    try {
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      if (row.command === epicId && typeof detail.prUrl === 'string' && detail.prUrl.startsWith('http')) {
        urls.add(detail.prUrl);
      }
    } catch {
      // ignore
    }
  }
  return [...urls];
}
