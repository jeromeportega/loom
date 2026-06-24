// ── Schema v27 row shapes (table of record for rollback) ─────────────────────
export type LandingAttemptStatus =
  | 'staging' | 'merging' | 'landed'
  | 'rolling_back' | 'rolled_back' | 'blocked' | 'failed';

export type MergeState =
  | 'pending' | 'merged' | 'revert_pending' | 'reverted';

export interface LandingAttempt {
  id: string;                 // 'landing-<epicId>-<seq>'
  epicId: string;
  status: LandingAttemptStatus;
  baseShas: Record<string, string>;   // { repoSlug: pre-landing main SHA }
  blocker: LandingBlocker | null;
  createdAt: string;
  updatedAt: string;
}

export interface RepoMergeRecord {
  attemptId: string;
  repoSlug: string;
  dependsOn: string[];        // producer slugs, dependency order
  prNumber: number | null;
  prUrl: string | null;
  mergeCommitSha: string | null;   // squash commit on main — THE revert anchor (FR-5)
  mergeState: MergeState;
  revertPrUrl: string | null;
  revertMergeSha: string | null;
  mergedAt: string | null;
  revertedAt: string | null;
}

export interface LandingBlocker { repoSlug: string; check: string; reason: string; }

// ── Readiness gate (story-060-001) ───────────────────────────────────────────
import type { GateOutcome } from './IntegrationGate.js';

export interface RepoReadiness {
  repoSlug: string;
  prUrl?: string;
  prOpen: boolean;
  gate: GateOutcome;          // re-used from orchestrator/IntegrationGate.ts
  consumerGateGreen: boolean;
  ready: boolean;
  reason?: string;
}
export interface LandingReadiness {
  epicId: string;
  attemptId: string;
  allReady: boolean;
  repos: RepoReadiness[];
  blocker?: LandingBlocker;
}

// ── Rollback (story-060-003 / 004) ───────────────────────────────────────────
export interface RollbackResult {
  attemptId: string;
  status: 'rolled_back' | 'partial' | 'noop' | 'failed';
  reverted: Array<{ repoSlug: string; revertPrUrl: string; revertMergeSha: string }>;
  skipped: string[];          // slugs already at 'reverted' (idempotency, FR-6)
  stranded?: { repoSlug: string; reason: string };  // revert PR failed its own gate (ADR-008)
}

// ── Surfacing (story-060-005) ─────────────────────────────────────────────────
export interface LandingReport {
  attemptId: string;
  epicId: string;
  status: LandingAttemptStatus;
  blocker?: LandingBlocker;          // populated when status === 'blocked'
  repos: Array<{ repoSlug: string; mergeState: MergeState; prUrl: string | null }>;
  cleanState: boolean;               // true when every repo is 'pending' or 'reverted'
}

// ── Injection seams the coordinator calls (typed here so 001 needs no
//    forward import of LandingStore / ForwardReverter) ─────────────────────────
import type { RepoStage } from './CrossRepoCoordinator.js';

export type MergeRepoFn   = (stage: RepoStage, attemptId: string) => Promise<RepoMergeRecord>;
export type RollbackFn    = (attemptId: string) => Promise<RollbackResult>;

// ── Dependency-inverted port. story-060-002 provides the concrete class. ──────
export interface LandingStorePort {
  beginAttempt(epicId: string, stages: RepoStage[]): string;   // returns attemptId, captures baseShas
  recordMerge(attemptId: string, m: {
    repoSlug: string; prNumber: number; prUrl: string; mergeCommitSha: string;
  }): void;
  markRevertPending(attemptId: string, repoSlug: string, revertPrUrl: string): void;
  markReverted(attemptId: string, repoSlug: string, revertMergeSha: string): void;
  pendingReverts(attemptId: string): RepoMergeRecord[];   // mergeState IN ('merged','revert_pending'), reverse dep order
  getAttempt(attemptId: string): { attempt: LandingAttempt; merges: RepoMergeRecord[] };
  setStatus(attemptId: string, status: LandingAttemptStatus, blocker?: LandingBlocker): void;
}

// ── Audit action types — producers (002/003) emit, consumer (005) renders ─────
export const CROSS_REPO_ACTIONS = {
  STAGED:           'cross_repo.staged',
  MERGED:           'cross_repo.merged',
  BLOCKED:          'cross_repo.blocked',
  ROLLBACK_STARTED: 'cross_repo.rollback_started',
  REVERTED:         'cross_repo.reverted',
  ROLLED_BACK:      'cross_repo.rolled_back',
  STRANDED:         'cross_repo.stranded',
} as const;
