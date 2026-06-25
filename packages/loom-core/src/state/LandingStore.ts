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
import { CROSS_REPO_ACTIONS } from '../orchestrator/landingTypes.js';
import type { AuditRecordFn } from '../orchestrator/ForwardReverter.js';
import type { RepoStage } from '../orchestrator/CrossRepoCoordinator.js';
import { gitSafe } from '../orchestrator/git.js';

// Default SHA capture wraps gitSafe so the seam can be overridden in tests
// without adding git I/O as a hidden dependency of every LandingStore test.
function defaultCaptureBaseSha(repoRoot: string): string {
  const res = gitSafe(repoRoot, ['rev-parse', 'HEAD']);
  return res.ok ? res.output : '';
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToAttempt(row: Record<string, unknown>): LandingAttempt {
  let baseShas: Record<string, string>;
  let blocker: LandingBlocker | null;
  try {
    baseShas = JSON.parse((row.base_shas as string | null) ?? '{}') as Record<string, string>;
  } catch (e) {
    throw new Error(`LandingStore: failed to parse base_shas for attempt '${row.id as string}': ${(e as Error).message}`);
  }
  try {
    blocker = row.blocker ? (JSON.parse(row.blocker as string) as LandingBlocker) : null;
  } catch (e) {
    throw new Error(`LandingStore: failed to parse blocker for attempt '${row.id as string}': ${(e as Error).message}`);
  }
  return {
    id: row.id as string,
    epicId: row.epic_id as string,
    status: row.status as LandingAttemptStatus,
    baseShas,
    blocker,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToMerge(row: Record<string, unknown>): RepoMergeRecord {
  let dependsOn: string[];
  try {
    dependsOn = JSON.parse((row.depends_on as string | null) ?? '[]') as string[];
  } catch (e) {
    throw new Error(`LandingStore: failed to parse depends_on for repo_merge id=${row.id as string}: ${(e as Error).message}`);
  }
  return {
    attemptId: row.attempt_id as string,
    repoSlug: row.repo_slug as string,
    dependsOn,
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
  private readonly _captureBaseSha: (repoRoot: string) => string;
  private readonly stmtLatestAttempt: Database.Statement;

  constructor(
    private readonly db: Database.Database,
    captureBaseSha?: (repoRoot: string) => string,
  ) {
    this._captureBaseSha = captureBaseSha ?? defaultCaptureBaseSha;
    this.stmtLatestAttempt = db.prepare(
      'SELECT id FROM landing_attempts WHERE epic_id = ? ORDER BY rowid DESC LIMIT 1',
    );
  }

  beginAttempt(epicId: string, stages: RepoStage[]): string {
    // Capture SHA outside the transaction — I/O ops must not run inside SQLite transactions.
    const baseShas: Record<string, string> = {};
    for (const stage of stages) {
      baseShas[stage.repoSlug] = this._captureBaseSha(stage.repoRoot);
    }

    const insertAttempt = this.db.prepare(
      `INSERT INTO landing_attempts (id, epic_id, status, base_shas, blocker)
       VALUES (?, ?, 'staging', ?, NULL)`,
    );
    const insertMerge = this.db.prepare(
      `INSERT INTO repo_merges (attempt_id, repo_slug, depends_on, merge_state)
       VALUES (?, ?, ?, 'pending')`,
    );

    const attemptId = this.db.transaction((): string => {
      const { cnt } = this.db
        .prepare('SELECT COUNT(*) as cnt FROM landing_attempts WHERE epic_id = ?')
        .get(epicId) as { cnt: number };
      const id = `landing-${epicId}-${cnt}`;

      insertAttempt.run(id, epicId, JSON.stringify(baseShas));
      for (const stage of stages) {
        insertMerge.run(id, stage.repoSlug, JSON.stringify(stage.dependsOnRepos));
      }
      return id;
    })();

    return attemptId;
  }

  recordMerge(
    attemptId: string,
    m: { repoSlug: string; prNumber: number; prUrl: string; mergeCommitSha: string },
  ): void {
    const result = this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_commit_sha = ?,
             pr_number = ?,
             pr_url = ?,
             merge_state = 'merged',
             merged_at = CURRENT_TIMESTAMP
         WHERE attempt_id = ? AND repo_slug = ? AND merge_state = 'pending'`,
      )
      .run(m.mergeCommitSha, m.prNumber, m.prUrl, attemptId, m.repoSlug);
    if (result.changes !== 1) {
      // Row may already be in merged/revert_pending/reverted — treat as idempotent no-op.
      const existing = this.db
        .prepare('SELECT merge_state FROM repo_merges WHERE attempt_id = ? AND repo_slug = ?')
        .get(attemptId, m.repoSlug) as { merge_state: string } | undefined;
      if (!existing) {
        throw new Error(
          `LandingStore.recordMerge: no row found for attempt '${attemptId}' repo '${m.repoSlug}' — call beginAttempt first`,
        );
      }
      // Row exists but not in pending state — idempotent re-call, leave the anchor intact.
    }
  }

  markRevertPending(attemptId: string, repoSlug: string, revertPrUrl: string): void {
    const result = this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_state = 'revert_pending', revert_pr_url = ?
         WHERE attempt_id = ? AND repo_slug = ?`,
      )
      .run(revertPrUrl, attemptId, repoSlug);
    if (result.changes !== 1) {
      throw new Error(
        `LandingStore.markRevertPending: no row found for attempt '${attemptId}' repo '${repoSlug}'`,
      );
    }
  }

  markReverted(attemptId: string, repoSlug: string, revertMergeSha: string): void {
    const result = this.db
      .prepare(
        `UPDATE repo_merges
         SET merge_state = 'reverted',
             revert_merge_sha = ?,
             reverted_at = CURRENT_TIMESTAMP
         WHERE attempt_id = ? AND repo_slug = ?`,
      )
      .run(revertMergeSha, attemptId, repoSlug);
    if (result.changes !== 1) {
      throw new Error(
        `LandingStore.markReverted: no row found for attempt '${attemptId}' repo '${repoSlug}'`,
      );
    }
  }

  pendingReverts(attemptId: string): RepoMergeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM repo_merges
         WHERE attempt_id = ? AND merge_state IN ('merged', 'revert_pending')`,
      )
      .all(attemptId) as Record<string, unknown>[];

    const records = rows.map(rowToMerge);

    // Topological sort (Kahn's BFS) then reverse for consumer-before-producer rollback order
    // (ADR-005). A pairwise comparator is incorrect for chains of 3+ nodes.
    return topoSortReversed(records);
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

  latestAttemptIdForEpic(epicId: string): string | undefined {
    try {
      const row = this.stmtLatestAttempt.get(epicId) as { id: string } | undefined;
      return row?.id;
    } catch (e) {
      // Degrade gracefully only for pre-v27 databases where the table does not exist.
      if (e instanceof Error && e.message.includes('no such table')) return undefined;
      throw e;
    }
  }
}

// ─── Topological sort (Kahn's BFS) ───────────────────────────────────────────

/**
 * Sorts records in forward topological order (producers before consumers) using
 * Kahn's BFS algorithm, then reverses for consumer-before-producer rollback order
 * (ADR-005). Correct for dependency chains of any length — a pairwise comparator
 * is only correct for a single producer/consumer pair.
 */
function topoSortReversed(records: RepoMergeRecord[]): RepoMergeRecord[] {
  if (records.length <= 1) return records;

  const bySlug = new Map(records.map(r => [r.repoSlug, r]));
  const slugSet = new Set(bySlug.keys());

  // Build adjacency (producer → consumers) and in-degree within this record set.
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const r of records) {
    adj.set(r.repoSlug, []);
    inDegree.set(r.repoSlug, 0);
  }
  for (const r of records) {
    for (const dep of r.dependsOn) {
      if (slugSet.has(dep)) {
        adj.get(dep)!.push(r.repoSlug);
        inDegree.set(r.repoSlug, (inDegree.get(r.repoSlug) ?? 0) + 1);
      }
    }
  }

  // BFS from zero-in-degree nodes (pure producers first).
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

  // Cycle guard: if BFS ended with unprocessed nodes, the graph has a cycle.
  // A partial rollback in this case would silently skip repos, so we fail hard.
  if (topo.length !== records.length) {
    throw new Error(
      `LandingStore: cycle detected in repo dependency graph (processed ${topo.length}/${records.length} nodes) — rollback order is incomplete`,
    );
  }

  // Reverse: consumers-first for rollback.
  topo.reverse();
  return topo;
}

// ─── makeAnchoringMerger ──────────────────────────────────────────────────────

const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

export interface AnchoringMergerDeps {
  /**
   * Injectable for tests — replaces the real `gh pr merge --squash` execFileSync
   * call so tests can verify SHA capture without shelling out to GitHub.
   */
  _ghMerge?: (prUrl: string) => { number: number; mergeCommitSha: string };
  /**
   * Injectable audit recorder — emits MERGED after each successful merge.
   * When absent, audit writes are skipped (backwards-compatible).
   * In production, pass `(e) => auditLog.record(e)`.
   */
  _auditRecord?: AuditRecordFn;
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
  const auditRecord: AuditRecordFn = deps._auditRecord ?? (() => undefined);
  return async (stage: RepoStage, attemptId: string): Promise<RepoMergeRecord> => {
    if (!stage.prUrl) {
      throw new Error(
        `makeAnchoringMerger: stage '${stage.repoSlug}' has no prUrl — cannot merge`,
      );
    }

    if (!GITHUB_PR_URL_RE.test(stage.prUrl)) {
      throw new Error(
        `makeAnchoringMerger: prUrl '${stage.prUrl}' is not a valid GitHub PR URL`,
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
      let raw: string;
      try {
        raw = execFileSync(
          'gh',
          ['pr', 'merge', stage.prUrl, '--squash', '--json', 'number,mergeCommit'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
      } catch (err) {
        throw new Error(
          `makeAnchoringMerger: gh pr merge failed for '${stage.repoSlug}': ${(err as Error).message}`,
        );
      }

      let parsed: { number: number; mergeCommit: { oid: string } | null };
      try {
        parsed = JSON.parse(raw) as { number: number; mergeCommit: { oid: string } | null };
      } catch (err) {
        throw new Error(
          `makeAnchoringMerger: failed to parse gh pr merge output for '${stage.repoSlug}'`,
        );
      }

      if (!parsed.mergeCommit?.oid) {
        throw new Error(
          `makeAnchoringMerger: gh pr merge returned no mergeCommit.oid for '${stage.repoSlug}' — merge may be pending or failed`,
        );
      }

      prNumber = parsed.number;
      mergeCommitSha = parsed.mergeCommit.oid;
    }

    store.recordMerge(attemptId, {
      repoSlug: stage.repoSlug,
      prNumber,
      prUrl: stage.prUrl,
      mergeCommitSha,
    });

    auditRecord({
      action: CROSS_REPO_ACTIONS.MERGED,
      command: attemptId,
      detail: { repoSlug: stage.repoSlug, prNumber, prUrl: stage.prUrl, mergeCommitSha },
    });

    // Return the canonically persisted record so mergedAt reflects the DB clock,
    // not a JS Date that diverges in format from SQLite's CURRENT_TIMESTAMP.
    const { merges } = store.getAttempt(attemptId);
    const persisted = merges.find(m => m.repoSlug === stage.repoSlug);
    if (!persisted) {
      throw new Error(
        `makeAnchoringMerger: could not retrieve persisted merge record for '${stage.repoSlug}' in attempt '${attemptId}'`,
      );
    }
    return persisted;
  };
}
