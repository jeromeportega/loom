import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { EpicStore, AuditLog } from '../state/index.js';

export interface EpicReconcilerOptions {
  projectRoot: string;
  db: Database.Database;
  baseBranch?: string;
  gitBin?: string;
  ghBin?: string;
}

export type ReconcileStatus = 'reconciled' | 'noop' | 'refused' | 'failed';

export type ReconcileRefusalReason =
  | 'not_merged'
  | 'unverifiable_offline'
  | 'tool_unavailable'
  | 'ref_mismatch'
  | 'no_epic_branch'
  | 'epic_not_found';

export interface ReconcileResult {
  status: ReconcileStatus;
  epicId: string;
  prUrl?: string;
  reason?: ReconcileRefusalReason;
  /** Human-readable outcome; carries the --pr squash hint on ancestry false-negatives. */
  note: string;
}

type ExecOutcome =
  | { kind: 'ok'; output: string }
  | { kind: 'nok'; output: string }
  | { kind: 'enoent' }
  | { kind: 'error'; message: string };

function tryExec(bin: string, args: string[], cwd: string): ExecOutcome {
  try {
    const output = execFileSync(bin, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { kind: 'ok', output: (output as string).trim() };
  } catch (err) {
    const e = err as Error & { code?: string; status?: number; stderr?: string; stdout?: string };
    if (e.code === 'ENOENT') return { kind: 'enoent' };
    if (typeof e.status === 'number') {
      return { kind: 'nok', output: (e.stderr || e.stdout || '').trim() };
    }
    return { kind: 'error', message: e.message ?? 'unknown error' };
  }
}

/**
 * Reconciles a stranded-but-merged epic to done. The only place reconcile
 * logic lives — CLI and MCP wrap this class. Mirrors EpicReverter's
 * constructor-options shape.
 */
export class EpicReconciler {
  constructor(private opts: EpicReconcilerOptions) {}

  reconcile(epicId: string, opts?: { prUrl?: string }): ReconcileResult {
    const epicStore = new EpicStore(this.opts.db);
    const audit = new AuditLog(this.opts.db);
    const baseBranch = this.opts.baseBranch ?? 'main';
    const gitBin = this.opts.gitBin ?? 'git';
    const ghBin = this.opts.ghBin ?? 'gh';
    const epicBranch = `epic/${epicId}`;

    const epic = epicStore.get(epicId);
    if (!epic) {
      return {
        status: 'refused',
        epicId,
        reason: 'epic_not_found',
        note: `Epic "${epicId}" not found.`,
      };
    }

    // ADR-5: idempotent noop — already done or PR URL already recorded
    if (epic.status === 'done' || epic.epic_pr_url != null) {
      return {
        status: 'noop',
        epicId,
        note: `Epic "${epicId}" is already reconciled (status=${epic.status}).`,
      };
    }

    if (opts?.prUrl) {
      return this.viaUrl(epicId, opts.prUrl, epicBranch, baseBranch, ghBin, epicStore, audit);
    }
    return this.viaAncestry(epicId, epicBranch, baseBranch, gitBin, epicStore, audit);
  }

  private viaUrl(
    epicId: string,
    prUrl: string,
    epicBranch: string,
    baseBranch: string,
    ghBin: string,
    epicStore: EpicStore,
    audit: AuditLog
  ): ReconcileResult {
    const res = tryExec(
      ghBin,
      ['pr', 'view', prUrl, '--json', 'state,headRefName,baseRefName'],
      this.opts.projectRoot
    );

    if (res.kind === 'enoent') {
      return {
        status: 'refused',
        epicId,
        reason: 'tool_unavailable',
        note: 'gh binary not found. Ensure gh is installed and on PATH.',
      };
    }
    if (res.kind !== 'ok') {
      const detail = res.kind === 'error' ? res.message : res.output;
      return {
        status: 'refused',
        epicId,
        reason: 'unverifiable_offline',
        note: `gh pr view failed: ${detail}`,
      };
    }

    let prData: { state: string; headRefName: string; baseRefName: string };
    try {
      prData = JSON.parse(res.output) as typeof prData;
    } catch {
      return {
        status: 'refused',
        epicId,
        reason: 'unverifiable_offline',
        note: 'gh pr view returned unparseable output.',
      };
    }

    if (prData.state !== 'MERGED') {
      return {
        status: 'refused',
        epicId,
        reason: 'not_merged',
        note: `PR is not merged (state=${prData.state}).`,
      };
    }

    if (prData.headRefName !== epicBranch || prData.baseRefName !== baseBranch) {
      return {
        status: 'refused',
        epicId,
        reason: 'ref_mismatch',
        note: `PR refs mismatch: expected head=${epicBranch} base=${baseBranch}, got head=${prData.headRefName} base=${prData.baseRefName}.`,
      };
    }

    this.commit(epicId, prUrl, 'pr-url', 'gh pr view', prData.headRefName, prData.baseRefName, epicStore, audit);
    return {
      status: 'reconciled',
      epicId,
      prUrl,
      note: `Epic "${epicId}" reconciled via PR ${prUrl}.`,
    };
  }

  private viaAncestry(
    epicId: string,
    epicBranch: string,
    baseBranch: string,
    gitBin: string,
    epicStore: EpicStore,
    audit: AuditLog
  ): ReconcileResult {
    const verifyBranch = tryExec(
      gitBin,
      ['rev-parse', '--verify', `refs/heads/${epicBranch}`],
      this.opts.projectRoot
    );

    if (verifyBranch.kind === 'enoent') {
      return {
        status: 'refused',
        epicId,
        reason: 'tool_unavailable',
        note: 'git binary not found. Ensure git is installed and on PATH.',
      };
    }
    if (verifyBranch.kind === 'error') {
      return {
        status: 'refused',
        epicId,
        reason: 'unverifiable_offline',
        note: `git rev-parse failed: ${verifyBranch.message}`,
      };
    }
    if (verifyBranch.kind === 'nok') {
      return {
        status: 'refused',
        epicId,
        reason: 'no_epic_branch',
        note: `Epic branch "${epicBranch}" does not exist locally.`,
      };
    }

    const isAncestor = tryExec(
      gitBin,
      ['merge-base', '--is-ancestor', epicBranch, baseBranch],
      this.opts.projectRoot
    );

    if (isAncestor.kind === 'enoent') {
      return {
        status: 'refused',
        epicId,
        reason: 'tool_unavailable',
        note: 'git binary not found.',
      };
    }
    if (isAncestor.kind === 'error') {
      return {
        status: 'refused',
        epicId,
        reason: 'unverifiable_offline',
        note: `git merge-base failed: ${isAncestor.message}`,
      };
    }
    if (isAncestor.kind === 'nok') {
      return {
        status: 'refused',
        epicId,
        reason: 'not_merged',
        // FR-12: squash-merge hint on ancestry false-negatives
        note: `Epic branch "${epicBranch}" is not an ancestor of "${baseBranch}". If this epic was squash-merged, re-run with --pr <url>.`,
      };
    }

    this.commit(epicId, undefined, 'ancestry', 'git merge-base', epicBranch, baseBranch, epicStore, audit);
    return {
      status: 'reconciled',
      epicId,
      note: `Epic "${epicId}" reconciled via git ancestry.`,
    };
  }

  /**
   * Ordered write on a verified merge (FR-9):
   * recordPrUrl → clearFinalizePhase → audit(epic_reconciled) → updateStatus(done)
   */
  private commit(
    epicId: string,
    prUrl: string | undefined,
    path: 'pr-url' | 'ancestry',
    verifiedVia: string,
    headRef: string,
    baseRef: string,
    epicStore: EpicStore,
    audit: AuditLog
  ): void {
    if (prUrl) epicStore.recordPrUrl(epicId, prUrl);
    epicStore.clearFinalizePhase(epicId);
    audit.record({
      action: 'epic_reconciled',
      command: epicId,
      allowed: true,
      detail: {
        path,
        pr_url: prUrl ?? null,
        verified_via: verifiedVia,
        head_ref: headRef,
        base_ref: baseRef,
      },
    });
    epicStore.updateStatus(epicId, 'done');
  }
}
