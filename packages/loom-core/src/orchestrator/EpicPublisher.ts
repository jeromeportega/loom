import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { EpicStore, AuditLog } from '../state/index.js';

export interface EpicPublisherOptions {
  projectRoot: string;
  db: Database.Database;
  // Injectable PR-open seam (tests). Defaults to probe-then-create via gh. Throws on failure.
  openPr?: (input: { branch: string }) => string | undefined;
  // Injectable resume stub (tests). When the epic is `finalizing`, _publish() delegates here
  // instead of refusing. Production callers bypass EpicPublisher for finalizing epics at the
  // CLI layer (publish.ts routes them to EpicFinalizer.resume() before constructing this class).
  _resume?: (epicId: string) => PublishResult;
}

export type PublishStatus = 'published' | 'refused' | 'failed';

export interface PublishResult {
  status: PublishStatus;
  epicId: string;
  prUrl?: string;
  note: string;
}

// Drives a publish_pending epic to done. Distinct from EpicReconciler (opposite precondition).
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

    // FR-7: accept finalizing epics and route to the injectable resume stub.
    // Production callers bypass EpicPublisher entirely for finalizing epics (publish.ts
    // routes them to EpicFinalizer.resume() before constructing this class). The _resume
    // seam here exists for EpicPublisher-level unit tests that assert the old precondition
    // no longer rejects a finalizing epic.
    if (epic.status === 'finalizing') {
      if (this.opts._resume) {
        return this.opts._resume(epicId);
      }
      return {
        status: 'refused',
        epicId,
        note: `Epic "${epicId}" is finalizing — use \`loom publish ${epicId}\` (CLI wires up resume) or \`loom finalize --resume ${epicId}\`.`,
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
      if (this.opts.openPr) {
        prUrl = this.opts.openPr({ branch: finalizeRef });
      } else {
        // Prod default: probe for an existing PR first so retries are idempotent
        // (if the transaction failed after gh pr create, a second run would get
        // "a pull request for branch X already exists" — the probe prevents that).
        // Assumes the repo default branch is always the epic base (no base_branch in EpicRecord).
        const execOpts = { cwd: this.opts.projectRoot, encoding: 'utf8' as const, timeout: 30_000 };
        let probeUrl: string | undefined;
        try {
          // `gh pr list --head` — NOT `gh pr view --head` (view has no --head flag;
          // it would exit `unknown flag: --head`, the catch would misread it as
          // "no PR", and `gh pr create` would then fail on the already-existing PR).
          const probeOut = execFileSync('gh', ['pr', 'list', '--head', finalizeRef, '--state', 'all', '--json', 'url', '-q', '.[0].url // ""'], execOpts).trim();
          if (probeOut.startsWith('http')) probeUrl = probeOut;
        } catch {
          // No existing PR — will create below
        }
        if (probeUrl) {
          prUrl = probeUrl;
        } else {
          const out = execFileSync('gh', ['pr', 'create', '--head', finalizeRef, '--fill'], execOpts);
          prUrl = out.trim().split('\n').find((l) => l.startsWith('http'));
        }
      }
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

    // Atomic write: recordPrUrl → clearFinalizePhase → audit → updateStatus('done').
    this.opts.db.transaction(() => {
      this.epicStore.recordPrUrl(epicId, prUrl!);
      this.epicStore.clearFinalizePhase(epicId);
      this.audit.record({
        action: 'epic_published',
        command: epicId,
        allowed: true,
        detail: { finalize_ref: finalizeRef, pr_url: prUrl },
      });
      this.epicStore.updateStatus(epicId, 'done');
    })();

    return {
      status: 'published',
      epicId,
      prUrl,
      note: `Epic "${epicId}" published — PR opened at ${prUrl} and status set to done.`,
    };
  }
}
