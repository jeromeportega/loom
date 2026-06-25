import { execFileSync } from 'node:child_process';
import { minimatch } from 'minimatch';
import type { PolicyEngine } from '../guardrails/PolicyEngine.js';
import type { IntegrationGate } from './IntegrationGate.js';
import { git } from './git.js';
import type {
  AuditRecordFn,
  LandingStorePort,
  RepoMergeRecord,
  RollbackResult,
} from './landingTypes.js';
import { CROSS_REPO_ACTIONS } from './landingTypes.js';
import { collectSkipped, hasConverged } from './rollbackResume.js';

export interface ForwardReverterOptions {
  projectRoot: string;
  store: LandingStorePort;
  policy: PolicyEngine;
  integrationGate: IntegrationGate;
  allowedRemotes: string[];
  /** Maps repoSlug → absolute path to that repo's working tree. */
  repoRoots: Record<string, string>;
  /**
   * Injectable for tests — replaces the real git execution.
   * Receives (cwd, args) and must return stdout as a string.
   */
  _execGit?: (cwd: string, args: string[]) => string;
  /**
   * Injectable for tests — replaces the real gh execution.
   * Receives (args, cwd?) and must return stdout as a string.
   */
  _execGh?: (args: string[], cwd?: string) => string;
  /**
   * Injectable audit recorder — emits CROSS_REPO_ACTIONS events.
   * When absent, audit writes are skipped (backwards-compatible).
   * In production, pass `(e) => auditLog.record(e)`.
   */
  _auditRecord?: AuditRecordFn;
}

/**
 * ForwardReverter: rolls back every already-merged repo for a landing attempt
 * via additive-only forward-revert commits + PRs (ADR-008).
 *
 * - Reverts are applied in reverse dependency order (consumer before producer).
 * - Every git/gh command is checked through PolicyEngine before execution.
 * - A revert PR that fails its own IntegrationGate strands the rollback rather
 *   than bypassing the gate — there is no rollback override.
 * - The operation is idempotent: repos already at 'reverted' are skipped; repos
 *   at 'revert_pending' are resumed (PR was opened, just need merge).
 * - No force-push, no history rewrite, no branch delete, no PR close.
 *
 * Requires gh CLI ≥ 2.0 (uses --json flag for structured output).
 */
export class ForwardReverter {
  private readonly store: LandingStorePort;
  private readonly policy: PolicyEngine;
  private readonly integrationGate: IntegrationGate;
  private readonly allowedRemotes: string[];
  private readonly repoRoots: Record<string, string>;
  private readonly _runGit: (cwd: string, args: string[]) => string;
  private readonly _runGh: (args: string[], cwd?: string) => string;
  private readonly _auditRecord: AuditRecordFn;

  constructor(opts: ForwardReverterOptions) {
    this.store = opts.store;
    this.policy = opts.policy;
    this.integrationGate = opts.integrationGate;
    this.allowedRemotes = opts.allowedRemotes;
    this.repoRoots = opts.repoRoots;
    this._runGit = opts._execGit ?? ((cwd, args) => git(cwd, args));
    this._runGh = opts._execGh ?? ((args, cwd) =>
      execFileSync('gh', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      }).trim()
    );
    this._auditRecord = opts._auditRecord ?? (() => undefined);
  }

  /**
   * Rolls back all already-merged repos for `attemptId` in reverse dep order.
   * Returns a RollbackResult describing what was reverted, skipped, or stranded.
   */
  async rollback(attemptId: string): Promise<RollbackResult> {
    // Sort inside ForwardReverter so the ordering guarantee is self-contained
    // and does not depend implicitly on the store's implementation (AC2 / blocker).
    const pending = topoSortForRollback(this.store.pendingReverts(attemptId));

    // Repos already at 'reverted' won't appear in pendingReverts (FR-6).
    // Collect them separately so the caller can see what was skipped.
    const { merges: allMerges } = this.store.getAttempt(attemptId);
    const alreadyReverted = collectSkipped(allMerges);

    if (pending.length === 0 && alreadyReverted.length === 0) {
      return { attemptId, status: 'noop', reverted: [], skipped: [] };
    }
    if (hasConverged(allMerges)) {
      // All repos already reverted — write the converged status durably so a
      // re-run after a partial failure sees 'rolled_back', not 'failed' (FR-6).
      this.store.setStatus(attemptId, 'rolled_back');
      return { attemptId, status: 'rolled_back', reverted: [], skipped: alreadyReverted };
    }

    this.store.setStatus(attemptId, 'rolling_back');
    this._auditRecord({
      action: CROSS_REPO_ACTIONS.ROLLBACK_STARTED,
      command: attemptId,
      detail: { pendingCount: pending.length, alreadyRevertedCount: alreadyReverted.length },
    });

    const reverted: RollbackResult['reverted'] = [];
    const skipped: string[] = [...alreadyReverted];

    // Outer try/catch: any unexpected throw (git conflict, network, policy) must
    // transition the attempt to 'failed' so callers see a terminal state.
    try {
      for (const record of pending) {
        const repoRoot = this.repoRoots[record.repoSlug];
        if (!repoRoot) {
          throw new Error(
            `ForwardReverter: no repoRoot for slug '${record.repoSlug}' in attempt '${attemptId}'`,
          );
        }

        let revertPrUrl: string;

        if (record.mergeState === 'merged') {
          if (!record.mergeCommitSha) {
            throw new Error(
              `ForwardReverter: no mergeCommitSha for '${record.repoSlug}' in attempt '${attemptId}'`,
            );
          }

          // Sanitize before embedding in git ref names (invalid git-ref chars → '-').
          const safeAttemptId = sanitizeRefSegment(attemptId);
          const safeSlug = sanitizeRefSegment(record.repoSlug);
          const revertBranch = `revert/${safeAttemptId}/${safeSlug}`;

          // Resolve and validate the push remote against allowedRemotes.
          const remoteName = this.resolveAllowedRemote(repoRoot, record.repoSlug, attemptId);

          // Resolve the repo's actual default branch (falls back to 'main').
          const defaultBranch = this.resolveDefaultBranch(repoRoot, remoteName);

          // Create revert branch. Build args first so policyCheck and execution match exactly.
          const checkoutArgs = ['checkout', '-b', revertBranch];
          this.policyCheck(`git ${checkoutArgs.join(' ')}`);
          this._runGit(repoRoot, checkoutArgs);

          // Revert the merge commit (additive-only — no history rewrite).
          const revertArgs = ['revert', '--no-edit', '-m', '1', record.mergeCommitSha];
          this.policyCheck(`git ${revertArgs.join(' ')}`);
          this._runGit(repoRoot, revertArgs);

          // Push the revert branch.
          const pushArgs = ['push', remoteName, revertBranch];
          this.policyCheck(`git ${pushArgs.join(' ')}`);
          this._runGit(repoRoot, pushArgs);

          // Open a PR for the revert.
          const prTitle = `revert: rollback ${record.repoSlug} for ${attemptId}`;
          const prBody = `Automated forward-revert for landing attempt ${attemptId} (additive-only; no force-push).`;
          const prCreateArgs = [
            'pr', 'create',
            '--base', defaultBranch,
            '--head', revertBranch,
            '--title', prTitle,
            '--body', prBody,
            '--json', 'url',
          ];
          this.policyCheck(`gh pr create --base ${defaultBranch} --head ${revertBranch}`);
          const prCreateOut = this._runGh(prCreateArgs, repoRoot);

          revertPrUrl = this.parsePrUrl(prCreateOut, record.repoSlug, attemptId);
          this.store.markRevertPending(attemptId, record.repoSlug, revertPrUrl);

        } else if (record.mergeState === 'revert_pending') {
          if (!record.revertPrUrl) {
            throw new Error(
              `ForwardReverter: revert_pending but no revertPrUrl for '${record.repoSlug}' in attempt '${attemptId}'`,
            );
          }
          revertPrUrl = record.revertPrUrl;
        } else {
          skipped.push(record.repoSlug);
          continue;
        }

        // Run the repo's integration gate on the current (revert) branch.
        // If the gate fails, strand rather than bypass (ADR-008).
        const gateOutcome = await this.integrationGate.run({ projectRoot: repoRoot });
        if (!gateOutcome.ok) {
          this.store.setStatus(attemptId, 'failed');
          this._auditRecord({
            action: CROSS_REPO_ACTIONS.STRANDED,
            command: attemptId,
            detail: { repoSlug: record.repoSlug, reason: gateOutcome.summary },
          });
          return {
            attemptId,
            status: 'partial',
            reverted,
            skipped,
            stranded: { repoSlug: record.repoSlug, reason: gateOutcome.summary },
          };
        }

        // Merge the revert PR — squash only, never force-push.
        const prMergeArgs = ['pr', 'merge', revertPrUrl, '--squash', '--json', 'number,mergeCommit'];
        this.policyCheck(`gh pr merge ${revertPrUrl} --squash`);
        const mergeOut = this._runGh(prMergeArgs, repoRoot);

        const revertMergeSha = this.parseMergeSha(mergeOut, record.repoSlug, attemptId);
        this.store.markReverted(attemptId, record.repoSlug, revertMergeSha);

        reverted.push({ repoSlug: record.repoSlug, revertPrUrl, revertMergeSha });
        this._auditRecord({
          action: CROSS_REPO_ACTIONS.REVERTED,
          command: attemptId,
          detail: { repoSlug: record.repoSlug, revertPrUrl, revertMergeSha },
        });
      }
    } catch (err) {
      // Best-effort status update — if the store itself is broken, swallow that error.
      try { this.store.setStatus(attemptId, 'failed'); } catch { /* ignored */ }
      this._auditRecord({
        action: CROSS_REPO_ACTIONS.ROLLBACK_FAILED,
        command: attemptId,
        detail: { reason: (err as Error).message },
      });
      throw err;
    }

    this.store.setStatus(attemptId, 'rolled_back');
    this._auditRecord({
      action: CROSS_REPO_ACTIONS.ROLLED_BACK,
      command: attemptId,
      detail: { reverted: reverted.length, skipped: skipped.length },
    });
    return { attemptId, status: 'rolled_back', reverted, skipped };
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  private policyCheck(rawCommand: string): void {
    const result = this.policy.check(rawCommand);
    if (!result.allowed) {
      throw new Error(
        `ForwardReverter: policy blocked '${rawCommand}': ${result.reason ?? '(no reason)'}`,
      );
    }
  }

  /**
   * Finds the first git remote whose URL matches an allowedRemotes pattern
   * and returns its name. Throws if none matches.
   *
   * URLs are normalised (trimmed, .git suffix stripped) before matching so
   * that patterns like 'https://github.com/org/*' match both
   * 'https://github.com/org/repo' and 'https://github.com/org/repo.git'.
   */
  private resolveAllowedRemote(
    repoRoot: string,
    repoSlug: string,
    attemptId: string,
  ): string {
    const remoteList = this._runGit(repoRoot, ['remote']);
    const remotes = remoteList
      .split('\n')
      .map(r => r.trim())
      .filter(Boolean);

    if (remotes.length === 0) {
      throw new Error(
        `ForwardReverter: no git remote found for repo '${repoSlug}' in attempt '${attemptId}'`,
      );
    }

    for (const remoteName of remotes) {
      const rawUrl = this._runGit(repoRoot, ['remote', 'get-url', remoteName]).trim();
      // Normalise: strip trailing .git so patterns need not list both variants.
      const url = rawUrl.replace(/\.git$/, '');
      if (this.allowedRemotes.some(pattern => minimatch(url, pattern))) {
        return remoteName;
      }
    }

    throw new Error(
      `ForwardReverter: no remote for repo '${repoSlug}' matches allowedRemotes in attempt '${attemptId}'`,
    );
  }

  /**
   * Resolves the repo's actual default branch by inspecting the remote tracking
   * HEAD ref. Falls back to 'main' if the ref is not set (common in shallow
   * clones and newly initialised repos).
   */
  private resolveDefaultBranch(repoRoot: string, remoteName: string): string {
    try {
      const ref = this._runGit(
        repoRoot,
        ['symbolic-ref', '--short', `refs/remotes/${remoteName}/HEAD`],
      ).trim();
      if (ref) {
        // 'origin/main' → 'main'; strip the remote prefix.
        return ref.replace(new RegExp(`^${remoteName}/`), '') || 'main';
      }
    } catch {
      // symbolic-ref fails when the tracking ref is not configured.
    }
    return 'main';
  }

  private parsePrUrl(raw: string, repoSlug: string, attemptId: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { url?: string };
        if (parsed.url) return parsed.url;
      } catch {
        // Fall through to error
      }
      throw new Error(
        `ForwardReverter: could not parse PR URL from gh pr create output for '${repoSlug}' in '${attemptId}'`,
      );
    }
    // Some gh versions print the URL as plain text.
    if (trimmed.startsWith('http')) return trimmed;
    throw new Error(
      `ForwardReverter: unexpected gh pr create output for '${repoSlug}' in '${attemptId}': ${trimmed}`,
    );
  }

  private parseMergeSha(raw: string, repoSlug: string, attemptId: string): string {
    try {
      const parsed = JSON.parse(raw.trim()) as {
        number: number;
        mergeCommit: { oid: string } | null;
      };
      if (parsed.mergeCommit?.oid) return parsed.mergeCommit.oid;
    } catch {
      // Fall through to error
    }
    throw new Error(
      `ForwardReverter: could not parse merge SHA from gh pr merge output for '${repoSlug}' in '${attemptId}'`,
    );
  }
}

// ── Module-private helpers ─────────────────────────────────────────────────────

/**
 * Replace characters that are invalid in git ref names with '-'.
 * Keeps alphanumeric, '.', '_', '-'. Collapses sequences of invalid chars.
 */
function sanitizeRefSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Topological sort (Kahn's BFS), reversed for consumer-before-producer rollback
 * order (ADR-005). Operates on the `dependsOn` field of each record.
 *
 * Performing this sort inside ForwardReverter (rather than relying solely on
 * the store's implementation) ensures AC2 is guaranteed here, independently
 * of store behaviour.
 */
function topoSortForRollback(records: RepoMergeRecord[]): RepoMergeRecord[] {
  if (records.length <= 1) return records;

  const bySlug = new Map(records.map(r => [r.repoSlug, r]));
  const slugSet = new Set(bySlug.keys());

  // Build adjacency (producer → consumers) and in-degree within this record set.
  const adj = new Map<string, string[]>(records.map(r => [r.repoSlug, []]));
  const inDegree = new Map<string, number>(records.map(r => [r.repoSlug, 0]));

  for (const r of records) {
    for (const dep of r.dependsOn) {
      if (slugSet.has(dep)) {
        adj.get(dep)!.push(r.repoSlug);
        inDegree.set(r.repoSlug, (inDegree.get(r.repoSlug) ?? 0) + 1);
      }
    }
  }

  // Kahn's BFS — producers first.
  const queue: string[] = [];
  for (const [slug, deg] of inDegree) {
    if (deg === 0) queue.push(slug);
  }

  const topo: RepoMergeRecord[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topo.push(bySlug.get(cur)!);
    for (const neighbor of adj.get(cur) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (topo.length !== records.length) {
    throw new Error(
      `ForwardReverter: cycle detected in repo dependency graph (processed ${topo.length}/${records.length} nodes) — rollback order is incomplete`,
    );
  }

  return topo.reverse();
}
