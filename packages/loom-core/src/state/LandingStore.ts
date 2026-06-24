import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type {
  LandingAttempt,
  LandingAttemptStatus,
  LandingBlocker,
  LandingStorePort,
  MergeRepoFn,
  MergeState,
  RepoMergeRecord,
} from '../orchestrator/landingTypes.js';
import type { RepoStage } from '../orchestrator/CrossRepoCoordinator.js';
import { gitSafe } from '../orchestrator/git.js';
import type { PolicyEngine } from '../guardrails/PolicyEngine.js';

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToAttempt(row: Record<string, unknown>): LandingAttempt {
  return {
    id: row.id as string,
    epicId: row.epic_id as string,
    status: row.status as LandingAttemptStatus,
    baseShas: JSON.parse((row.base_shas as string | null) ?? '{}') as Record<string, string>,
    blocker: row.blocker ? (JSON.parse(row.blocker as string) as LandingBlocker) : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMerge(row: Record<string, unknown>): RepoMergeRecord {
  return {
    attemptId: row.attempt_id as string,
    repoSlug: row.repo_slug as string,
    dependsOn: JSON.parse((row.depends_on as string | null) ?? '[]') as string[],
    prNumber: (row.pr_number as number | null) ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    mergeCommitSha: (row.merge_commit_sha as string | null) ?? null,
    mergeState: row.merge_state as MergeState,
    revertPrUrl: (row.revert_pr_url as string | null) ?? null,
    revertMergeSha: (row.revert_merge_sha as string | null) ?? null,
    mergedAt: (row.merged_at as string | null) ?? null,
    revertedAt: (row.reverted_at as string | null) ?? null,
  };
}

// ─── LandingStore ─────────────────────────────────────────────────────────────

export class LandingStore implements LandingStorePort {
  constructor(private readonly db: Database.Database) {}

  beginAttempt(epicId: string, stages: RepoStage[]): string {
    const { cnt } = this.db
      .prepare('SELECT COUNT(*) as cnt FROM landing_attempts WHERE epic_id = ?')
      .get(epicId) as { cnt: number };
    const attemptId = `landing-${epicId}-${cnt}`;

    // Capture pre-landing HEAD SHA for each repo (best-effort — empty string on git failure)
    const baseShas: Record<string, string> = {};
    for (const stage of stages) {
      const res = gitSafe(stage.repoRoot, ['rev-parse', 'HEAD']);
      baseShas[stage.repoSlug] = res.ok ? res.output : '';
    }

    this.db
      .prepare(
        `INSERT INTO landing_attempts (id, epic_id, status, base_shas, blocker)
         VALUES (?, ?, 'staging', ?, NULL)`,
      )
      .run(attemptId, epicId, JSON.stringify(baseShas));

    const insertMerge = this.db.prepare(
      `INSERT INTO repo_merges (attempt_id, repo_slug, depends_on, merge_state)
       VALUES (?, ?, ?, 'pending')`,
    );
    for (const stage of stages) {
      insertMerge.run(attemptId, stage.repoSlug, JSON.stringify(stage.dependsOnRepos));
    }

    return attemptId;
  }

  recordMerge(
    attemptId: string,
    m: { repoSlug: string; prNumber: number; prUrl: string; mergeCommitSha: string },
  ): void {
    this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_commit_sha = ?,
             pr_number = ?,
             pr_url = ?,
             merge_state = 'merged',
             merged_at = CURRENT_TIMESTAMP
         WHERE attempt_id = ? AND repo_slug = ?`,
      )
      .run(m.mergeCommitSha, m.prNumber, m.prUrl, attemptId, m.repoSlug);
  }

  markRevertPending(attemptId: string, repoSlug: string, revertPrUrl: string): void {
    this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_state = 'revert_pending', revert_pr_url = ?
         WHERE attempt_id = ? AND repo_slug = ?`,
      )
      .run(revertPrUrl, attemptId, repoSlug);
  }

  markReverted(attemptId: string, repoSlug: string, revertMergeSha: string): void {
    this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_state = 'reverted',
             revert_merge_sha = ?,
             reverted_at = CURRENT_TIMESTAMP
         WHERE attempt_id = ? AND repo_slug = ?`,
      )
      .run(revertMergeSha, attemptId, repoSlug);
  }

  pendingReverts(attemptId: string): RepoMergeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM repo_merges
         WHERE attempt_id = ? AND merge_state IN ('merged', 'revert_pending')`,
      )
      .all(attemptId) as Record<string, unknown>[];

    const records = rows.map(rowToMerge);

    // Reverse dependency order: consumers before producers (ADR-005).
    // a.dependsOn.includes(b.repoSlug) → a depends on b → a is consumer → a comes first.
    return records.sort((a, b) => {
      if (a.dependsOn.includes(b.repoSlug)) return -1;
      if (b.dependsOn.includes(a.repoSlug)) return 1;
      return 0;
    });
  }

  getAttempt(attemptId: string): { attempt: LandingAttempt; merges: RepoMergeRecord[] } {
    const attemptRow = this.db
      .prepare('SELECT * FROM landing_attempts WHERE id = ?')
      .get(attemptId) as Record<string, unknown> | undefined;

    if (!attemptRow) {
      throw new Error(`LandingStore.getAttempt: no attempt found for '${attemptId}'`);
    }

    const mergeRows = this.db
      .prepare('SELECT * FROM repo_merges WHERE attempt_id = ?')
      .all(attemptId) as Record<string, unknown>[];

    return {
      attempt: rowToAttempt(attemptRow),
      merges: mergeRows.map(rowToMerge),
    };
  }

  setStatus(
    attemptId: string,
    status: LandingAttemptStatus,
    blocker?: LandingBlocker,
  ): void {
    this.db
      .prepare(
        `UPDATE landing_attempts
         SET status = ?, blocker = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(status, blocker !== undefined ? JSON.stringify(blocker) : null, attemptId);
  }
}

// ─── makeAnchoringMerger ──────────────────────────────────────────────────────

export interface AnchoringMergerDeps {
  policy: PolicyEngine;
  /**
   * Injectable for tests — replaces the real `gh pr merge --squash` execFileSync
   * call so tests can verify SHA capture without shelling out to GitHub.
   */
  _ghMerge?: (prUrl: string) => { number: number; mergeCommitSha: string };
}

/**
 * Returns a MergeRepoFn that performs an active `gh pr merge --squash` and
 * records the resulting SHA in the landing ledger (ADR-004 / FR-5).
 *
 * The SHA is captured from the merge command's JSON output — not from a
 * subsequent poll — so the sequence is deterministic and the anchor is
 * durably written before control returns to the coordinator.
 *
 * Only loom-performed merges get a repo_merges row; concurrent human merges
 * are structurally absent from rollback (AC3).
 */
export function makeAnchoringMerger(
  store: LandingStorePort,
  deps: AnchoringMergerDeps,
): MergeRepoFn {
  return async (stage: RepoStage, attemptId: string): Promise<RepoMergeRecord> => {
    if (!stage.prUrl) {
      throw new Error(
        `makeAnchoringMerger: stage '${stage.repoSlug}' has no prUrl — cannot merge`,
      );
    }

    let prNumber: number;
    let mergeCommitSha: string;

    if (deps._ghMerge) {
      const result = deps._ghMerge(stage.prUrl);
      prNumber = result.number;
      mergeCommitSha = result.mergeCommitSha;
    } else {
      // Active merge via `gh pr merge --squash --json` — SHA is captured from the
      // command result, not polled afterwards (ADR-004). Matches git.ts/execFileSync pattern.
      const raw = execFileSync(
        'gh',
        ['pr', 'merge', stage.prUrl, '--squash', '--json', 'number,mergeCommit'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      const parsed = JSON.parse(raw) as { number: number; mergeCommit: { oid: string } };
      prNumber = parsed.number;
      mergeCommitSha = parsed.mergeCommit.oid;
    }

    store.recordMerge(attemptId, {
      repoSlug: stage.repoSlug,
      prNumber,
      prUrl: stage.prUrl,
      mergeCommitSha,
    });

    return {
      attemptId,
      repoSlug: stage.repoSlug,
      dependsOn: stage.dependsOnRepos,
      prNumber,
      prUrl: stage.prUrl,
      mergeCommitSha,
      mergeState: 'merged',
      revertPrUrl: null,
      revertMergeSha: null,
      mergedAt: new Date().toISOString(),
      revertedAt: null,
    };
  };
}
