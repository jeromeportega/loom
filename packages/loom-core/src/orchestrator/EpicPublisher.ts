import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { EpicStore, AuditLog } from '../state/index.js';

export interface EpicPublisherOptions {
  projectRoot: string;
  db: Database.Database;
  /**
   * Injectable PR-open seam (tests). Defaults to `gh pr create …`. Returns the
   * captured PR URL (or undefined when gh prints none). A throw is treated as
   * a PR-open failure — epic stays publish_pending, no partial write.
   */
  openPr?: (input: { branch: string }) => string | undefined;
}

export type PublishStatus = 'published' | 'refused' | 'failed';

export interface PublishResult {
  status: PublishStatus;
  epicId: string;
  prUrl?: string;
  note: string;
}

/**
 * Drives a publish_pending epic to done by opening a PR from the already-pushed
 * finalizer-owned ref, then atomically recording the PR URL and flipping status
 * to done. The only place this logic lives — CLI wraps this class (ADR-2).
 *
 * Precondition: epic.status === 'publish_pending'. Any other status is refused
 * with no side effects, keeping the verb distinct from EpicReconciler (which
 * operates on already-merged epics, the opposite precondition).
 */
export class EpicPublisher {
  private readonly epicStore: EpicStore;
  private readonly audit: AuditLog;

  constructor(private readonly opts: EpicPublisherOptions) {
    this.epicStore = new EpicStore(opts.db);
    this.audit = new AuditLog(opts.db);
  }

  publish(epicId: string): PublishResult {
    try {
      return this._publish(epicId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'failed', epicId, note: `Unexpected error during publish: ${msg}` };
    }
  }

  private _publish(epicId: string): PublishResult {
    if (!epicId?.trim()) {
      return {
        status: 'refused',
        epicId,
        note: 'epicId must be a non-empty string.',
      };
    }

    const epic = this.epicStore.get(epicId);
    if (!epic) {
      return {
        status: 'refused',
        epicId,
        note: `Epic "${epicId}" not found.`,
      };
    }

    if (epic.status !== 'publish_pending') {
      return {
        status: 'refused',
        epicId,
        note: `Epic "${epicId}" is not publish_pending (status=${epic.status}); publish only operates on publish_pending epics. Use \`loom reconcile\` for already-merged epics.`,
      };
    }

    if (!epic.finalize_ref) {
      return {
        status: 'refused',
        epicId,
        note: `Epic "${epicId}" has no finalize_ref recorded; cannot determine which branch to open the PR from.`,
      };
    }

    const finalizeRef = epic.finalize_ref;

    let prUrl: string | undefined;
    try {
      prUrl = this.opts.openPr
        ? this.opts.openPr({ branch: finalizeRef })
        : (() => {
            const out = execFileSync(
              'gh',
              ['pr', 'create', '--head', finalizeRef, '--fill'],
              { cwd: this.opts.projectRoot, encoding: 'utf8' }
            );
            return out
              .trim()
              .split('\n')
              .find((l) => l.startsWith('http'));
          })();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        epicId,
        note: `PR open failed for ${finalizeRef}: ${msg}`,
      };
    }

    if (!prUrl) {
      return {
        status: 'failed',
        epicId,
        note: `gh pr create ran for ${finalizeRef} but printed no parseable PR URL.`,
      };
    }

    const capturedUrl = prUrl;

    // Atomic write: recordPrUrl → clearFinalizePhase → audit → updateStatus('done').
    // Order follows ADR-3 write-ordering: epic_pr_url must be durable before done.
    this.opts.db.transaction(() => {
      this.epicStore.recordPrUrl(epicId, capturedUrl);
      this.epicStore.clearFinalizePhase(epicId);
      this.audit.record({
        action: 'epic_published',
        command: epicId,
        allowed: true,
        detail: { finalize_ref: finalizeRef, pr_url: capturedUrl },
      });
      this.epicStore.updateStatus(epicId, 'done');
    })();

    return {
      status: 'published',
      epicId,
      prUrl: capturedUrl,
      note: `Epic "${epicId}" published — PR opened at ${capturedUrl} and status set to done.`,
    };
  }
}
