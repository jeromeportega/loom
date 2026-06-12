import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type Database from 'better-sqlite3';
import { EpicStore, AgentStore, AuditLog, LeaseStore } from '../state/index.js';
import { EpicYamlSchema, type Story } from '../types.js';
import { WorktreeManager } from './WorktreeManager.js';
import { StoryHandoff } from './StoryHandoff.js';

export interface StoryRetryOptions {
  projectRoot: string;
  db: Database.Database;
  /**
   * Clean retry: discard the prior attempt's worktree + branch (and the
   * worktrees + branches of every story stacked on it) so the story re-runs
   * from scratch. Default false — a resume retry keeps the branch and feeds the
   * handoff doc back to the worker.
   */
  clean?: boolean;
  /** Optional explanation recorded with the retry. */
  reason?: string;
  /** Injectable for tests. Defaults to a fresh WorktreeManager(projectRoot). */
  worktrees?: WorktreeManager;
  /** Injectable for tests. Defaults to a fresh LeaseStore(db). */
  leaseStore?: LeaseStore;
}

export interface StoryRetryResult {
  /**
   *   - 'ready'    — state is prepped; the caller should now dispatch the epic
   *   - 'rejected' — a guard refused (running story, or a live run holds the epic)
   *   - 'error'    — the story / epic could not be found
   */
  status: 'ready' | 'rejected' | 'error';
  storyId: string;
  epicId?: string;
  /** True when the worktree(s) + branch(es) were torn down for a fresh run. */
  cleaned: boolean;
  /** Stories reset to re-run (the target + any cascaded dependents). */
  resetStories: string[];
  /** Whether a handoff doc will be fed to the resumed worker (resume retry). */
  willResume: boolean;
  message: string;
}

/**
 * Prepares a single story to be retried, then leaves dispatch to the caller
 * (which owns the policy + worker wiring). Shared by the MCP `loom_retry_story`
 * tool and the web Retry button so the guards and teardown logic live in one
 * place.
 *
 * Two modes:
 *   - resume (default): keep the prior attempt's branch + checkpoint commit and
 *     let the handoff doc steer the resumed worker. The Supervisor's
 *     worktree-reuse + handoff-injection do the rest on the next dispatch.
 *   - clean (`clean: true`): tear down the story's worktree + branch and those
 *     of every story stacked on it (transitive dependents), and reset those
 *     stories so they re-run from a rebuilt base.
 *
 * Both modes are guarded: a story that is still `running` is refused (stop it
 * first), and an epic a live supervisor currently holds the dispatch lease for
 * is refused (wait for it, or stop it) so a retry never races a live run.
 */
export class StoryRetryService {
  private epics: EpicStore;
  private agents: AgentStore;
  private audit: AuditLog;
  private worktrees: WorktreeManager;
  private lease: LeaseStore;

  constructor(private opts: StoryRetryOptions) {
    this.epics = new EpicStore(opts.db);
    this.agents = new AgentStore(opts.db);
    this.audit = new AuditLog(opts.db);
    this.worktrees = opts.worktrees ?? new WorktreeManager(opts.projectRoot);
    this.lease = opts.leaseStore ?? new LeaseStore(opts.db);
  }

  prepare(storyId: string): StoryRetryResult {
    const clean = this.opts.clean === true;
    const base = (over: Partial<StoryRetryResult>): StoryRetryResult => ({
      status: 'error',
      storyId,
      cleaned: false,
      resetStories: [],
      willResume: false,
      message: '',
      ...over,
    });

    const agent = this.agents.getByStory(storyId);
    if (!agent) {
      return base({ status: 'error', message: `No agent on record for story "${storyId}".` });
    }
    if (agent.status === 'running') {
      return base({
        status: 'rejected',
        epicId: agent.epic_id,
        message:
          `Story "${storyId}" is still running. Stop it first ` +
          `(loom_stop_agent), then retry.`,
      });
    }

    const epicId = agent.epic_id;
    const epic = this.epics.get(epicId);
    if (!epic) {
      return base({ status: 'error', epicId, message: `Epic "${epicId}" not found.` });
    }

    // A live supervisor dispatching this epic would race the retry into the
    // same idempotent worktree. Refuse rather than double-dispatch.
    if (this.lease.heldByOther(epicId)) {
      const h = this.lease.holder(epicId);
      return base({
        status: 'rejected',
        epicId,
        message:
          `Epic "${epicId}" has an active dispatch run` +
          (h ? ` (pid ${h.pid} on ${h.hostname})` : '') +
          `. Wait for it to finish or stop it, then retry.`,
      });
    }

    const stories = this.loadStories(epicId);
    const resetStories: string[] = [storyId];

    if (clean) {
      // Tear down the target, then every story stacked on its branch, so the
      // whole subtree re-runs from a rebuilt base. Dependents that already
      // SUCCEEDED on top of the now-deleted branch are reset to pending so the
      // Supervisor re-dispatches them instead of reusing their stale agents.
      const dependents = this.transitiveDependents(storyId, stories);
      this.worktrees.remove(storyId, { deleteBranch: true });
      this.clearHandoff(storyId);
      for (const depId of dependents) {
        this.worktrees.remove(depId, { deleteBranch: true });
        this.clearHandoff(depId);
        const depAgent = this.agents.getByStory(depId);
        if (depAgent) this.agents.updateStatus(depAgent.id, 'pending');
        resetStories.push(depId);
      }
    }

    // Make the epic runnable again. selectEpics treats 'in_progress' as
    // resumable; a 'done' or 'rejected' epic is flipped back so its one failed
    // story can be re-attempted.
    this.epics.updateStatus(epicId, 'in_progress');

    this.audit.record({
      agent_id: agent.id,
      action: 'story_retry',
      command: storyId,
      allowed: true,
      detail: {
        epic_id: epicId,
        clean,
        reason: this.opts.reason ?? null,
        reset_stories: resetStories,
        prior_status: agent.status,
      },
    });

    const willResume = !clean;
    return {
      status: 'ready',
      storyId,
      epicId,
      cleaned: clean,
      resetStories,
      willResume,
      message: clean
        ? `Cleaned ${resetStories.length} story(ies) for a fresh retry of "${storyId}". ` +
          `Dispatch ${epicId} to re-run.`
        : `Prepared "${storyId}" to resume from its prior attempt. ` +
          `Dispatch ${epicId} to continue.`,
    };
  }

  private loadStories(epicId: string): Story[] {
    const epic = this.epics.get(epicId);
    if (!epic?.yaml_path) return [];
    const file = path.join(this.opts.projectRoot, epic.yaml_path);
    if (!fs.existsSync(file)) return [];
    try {
      return EpicYamlSchema.parse(yaml.load(fs.readFileSync(file, 'utf8'))).stories;
    } catch {
      return [];
    }
  }

  /** Every story that depends on `storyId`, directly or transitively. */
  private transitiveDependents(storyId: string, stories: Story[]): string[] {
    const out = new Set<string>();
    let frontier = [storyId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const story of stories) {
        if (out.has(story.id) || story.id === storyId) continue;
        if (story.dependencies.some((d) => frontier.includes(d))) {
          out.add(story.id);
          next.push(story.id);
        }
      }
      frontier = next;
    }
    return [...out];
  }

  private clearHandoff(storyId: string): void {
    try {
      fs.rmSync(StoryHandoff.pathFor(this.opts.projectRoot, storyId), { force: true });
    } catch {
      // best-effort
    }
  }
}
