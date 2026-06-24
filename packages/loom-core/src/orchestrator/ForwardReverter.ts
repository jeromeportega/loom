import { execFileSync } from 'node:child_process';
import { minimatch } from 'minimatch';
import type { PolicyEngine } from '../guardrails/PolicyEngine.js';
import type { IntegrationGate } from './IntegrationGate.js';
import { git } from './git.js';
import type {
  LandingStorePort,
  RollbackResult,
} from './landingTypes.js';

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
 */
export class ForwardReverter {
  private readonly store: LandingStorePort;
  private readonly policy: PolicyEngine;
  private readonly integrationGate: IntegrationGate;
  private readonly allowedRemotes: string[];
  private readonly repoRoots: Record<string, string>;
  private readonly _runGit: (cwd: string, args: string[]) => string;
  private readonly _runGh: (args: string[], cwd?: string) => string;

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
  }

  /**
   * Rolls back all already-merged repos for `attemptId` in reverse dep order.
   * Returns a RollbackResult describing what was reverted, skipped, or stranded.
   */
  async rollback(attemptId: string): Promise<RollbackResult> {
    const pending = this.store.pendingReverts(attemptId);

    // Repos already at 'reverted' won't appear in pendingReverts (FR-6).
    // Collect them separately so the caller can see what was skipped.
    const { merges: allMerges } = this.store.getAttempt(attemptId);
    const alreadyReverted = allMerges
      .filter(m => m.mergeState === 'reverted' && m.mergeCommitSha !== null)
      .map(m => m.repoSlug);

    if (pending.length === 0 && alreadyReverted.length === 0) {
      return { attemptId, status: 'noop', reverted: [], skipped: [] };
    }
    if (pending.length === 0) {
      return { attemptId, status: 'rolled_back', reverted: [], skipped: alreadyReverted };
    }

    this.store.setStatus(attemptId, 'rolling_back');

    const reverted: RollbackResult['reverted'] = [];
    const skipped: string[] = [...alreadyReverted];

    for (const record of pending) {
      if (record.mergeState === 'reverted') {
        skipped.push(record.repoSlug);
        continue;
      }

      const repoRoot = this.repoRoots[record.repoSlug];
      if (!repoRoot) {
        this.store.setStatus(attemptId, 'failed');
        throw new Error(
          `ForwardReverter: no repoRoot for slug '${record.repoSlug}' in attempt '${attemptId}'`,
        );
      }

      let revertPrUrl: string;

      if (record.mergeState === 'merged') {
        if (!record.mergeCommitSha) {
          this.store.setStatus(attemptId, 'failed');
          throw new Error(
            `ForwardReverter: no mergeCommitSha for '${record.repoSlug}' in attempt '${attemptId}'`,
          );
        }

        const revertBranch = `revert/${attemptId}/${record.repoSlug}`;

        // Resolve and validate the push remote against allowedRemotes.
        const remoteName = this.resolveAllowedRemote(repoRoot, record.repoSlug, attemptId);

        // Create revert branch.
        this.policyCheck(`git checkout -b ${revertBranch}`);
        this._runGit(repoRoot, ['checkout', '-b', revertBranch]);

        // Revert the merge commit (additive-only — no history rewrite).
        this.policyCheck(`git revert --no-edit -m 1 ${record.mergeCommitSha}`);
        this._runGit(repoRoot, ['revert', '--no-edit', '-m', '1', record.mergeCommitSha]);

        // Push the revert branch.
        this.policyCheck(`git push ${remoteName} ${revertBranch}`);
        this._runGit(repoRoot, ['push', remoteName, revertBranch]);

        // Open a PR for the revert.
        this.policyCheck(`gh pr create --base main --head ${revertBranch}`);
        const prCreateOut = this._runGh(
          [
            'pr', 'create',
            '--base', 'main',
            '--head', revertBranch,
            '--title', `revert: rollback ${record.repoSlug} for ${attemptId}`,
            '--body', `Automated forward-revert for landing attempt ${attemptId} (additive-only; no force-push).`,
            '--json', 'url',
          ],
          repoRoot,
        );

        revertPrUrl = this.parsePrUrl(prCreateOut, record.repoSlug, attemptId);
        this.store.markRevertPending(attemptId, record.repoSlug, revertPrUrl);

      } else if (record.mergeState === 'revert_pending') {
        if (!record.revertPrUrl) {
          this.store.setStatus(attemptId, 'failed');
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
        return {
          attemptId,
          status: 'partial',
          reverted,
          skipped,
          stranded: { repoSlug: record.repoSlug, reason: gateOutcome.summary },
        };
      }

      // Merge the revert PR — squash only, never force-push.
      this.policyCheck(`gh pr merge ${revertPrUrl} --squash`);
      const mergeOut = this._runGh(
        ['pr', 'merge', revertPrUrl, '--squash', '--json', 'number,mergeCommit'],
        repoRoot,
      );

      const revertMergeSha = this.parseMergeSha(mergeOut, record.repoSlug, attemptId);
      this.store.markReverted(attemptId, record.repoSlug, revertMergeSha);

      reverted.push({ repoSlug: record.repoSlug, revertPrUrl, revertMergeSha });
    }

    this.store.setStatus(attemptId, 'rolled_back');
    return { attemptId, status: 'rolled_back', reverted, skipped };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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
      const url = this._runGit(repoRoot, ['remote', 'get-url', remoteName]);
      if (this.allowedRemotes.some(pattern => minimatch(url, pattern))) {
        return remoteName;
      }
    }

    throw new Error(
      `ForwardReverter: no remote for repo '${repoSlug}' matches allowedRemotes in attempt '${attemptId}'`,
    );
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
