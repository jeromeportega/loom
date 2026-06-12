import type { AgentStore } from '../state/AgentStore.js';
import type { AgentStatus } from '../types.js';
import { WorktreeManager } from './WorktreeManager.js';

/**
 * Why a loom-managed worktree on disk is considered orphaned (safe to remove):
 *  - 'no-agent'  — a `.loom/worktrees/<id>` dir with no agent record at all
 *                  (a half-created or manually-abandoned tree). The branch is
 *                  kept by default since it may hold un-tracked-by-loom commits.
 *  - 'completed' — the story's latest agent is `done`, so the work is merged.
 *                  EpicFinalizer normally removes these on a clean merge; this
 *                  catches the ones a crash left behind. Branch is dropped too.
 *
 * A `failed` / `blocked` / `running` / `pending` / `pr_open` story is NEVER an
 * orphan: failed and blocked are deliberately KEPT so a resume retry can
 * continue from their checkpoint commit; running/pending/pr_open are in flight.
 */
export type OrphanReason = 'no-agent' | 'completed';

export interface OrphanWorktree {
  storyId: string;
  path: string;
  branch: string;
  reason: OrphanReason;
  /** The latest agent's status, when one exists. */
  status?: AgentStatus;
}

/** Statuses whose worktree must be preserved (resume retry / in flight). */
const PRESERVE: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'failed',
  'blocked',
  'running',
  'pending',
  'pr_open',
]);

/**
 * Finds and prunes orphaned loom worktrees — those on disk under
 * `.loom/worktrees/` that no longer back a live or resumable story. Pure
 * detection (`findOrphans`) is separated from the destructive `prune` so the
 * MCP/CLI surfaces can flag-only or prune on demand, and so it is unit-testable
 * against a real git repo.
 */
export class WorktreeJanitor {
  constructor(
    private worktrees: WorktreeManager,
    private agents: AgentStore
  ) {}

  /** Worktrees on disk that are safe to remove, with the reason for each. */
  findOrphans(): OrphanWorktree[] {
    const orphans: OrphanWorktree[] = [];
    for (const wt of this.worktrees.list()) {
      const agent = this.agents.getByStory(wt.storyId);
      if (!agent) {
        orphans.push({ storyId: wt.storyId, path: wt.path, branch: wt.branch, reason: 'no-agent' });
        continue;
      }
      if (PRESERVE.has(agent.status)) continue;
      if (agent.status === 'done') {
        orphans.push({
          storyId: wt.storyId,
          path: wt.path,
          branch: wt.branch,
          reason: 'completed',
          status: agent.status,
        });
      }
    }
    return orphans;
  }

  /**
   * Removes orphans `findOrphans` reports and returns what was pruned.
   *
   * @param opts.reasons restrict removal to these reasons. The Supervisor's
   *   end-of-run auto-prune passes `['no-agent']` only: a `completed` worktree's
   *   branch may still be needed by the EpicFinalizer (a per-epic merge that
   *   conflicts leaves the story `done` with its work living only on the branch),
   *   so deleting those automatically would discard work. A deliberate
   *   `loom`-side cleanup can pass both reasons.
   * @param opts.deleteBranch override the per-reason default (branch deleted for
   *   `completed`, kept for `no-agent`).
   */
  prune(opts: { reasons?: OrphanReason[]; deleteBranch?: boolean } = {}): OrphanWorktree[] {
    const allow = opts.reasons ? new Set(opts.reasons) : null;
    const pruned: OrphanWorktree[] = [];
    for (const o of this.findOrphans()) {
      if (allow && !allow.has(o.reason)) continue;
      const deleteBranch = opts.deleteBranch ?? o.reason === 'completed';
      this.worktrees.remove(o.storyId, { deleteBranch });
      pruned.push(o);
    }
    return pruned;
  }
}
