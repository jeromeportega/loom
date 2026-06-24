import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuditLog } from '../state/index.js';
import { IntegrationGate } from './IntegrationGate.js';
import type { GateOutcome } from './IntegrationGate.js';
import type { RepoStage } from './CrossRepoCoordinator.js';

const execFileAsync = promisify(execFile);

/** Injectable PR-comment function for tests. */
export type PrCommentFn = (prUrl: string, body: string) => Promise<void>;

export interface RunConsumerGateArgs {
  /** Absolute path to the consumer repo root. */
  consumerRoot: string;
  /** The producer stage (status is 'awaiting_merge' — its PR has been merged). */
  producerStage: RepoStage;
  /** Story ids from the consumer's epic that failed to merge (amputation signal). */
  conflicted: string[];
  /** Injectable gate for tests. Defaults to a standard IntegrationGate. */
  gate?: IntegrationGate;
}

/**
 * Runs the IntegrationGate in the consumer worktree AFTER the producer PR has
 * merged so the consumer build resolves the producer's landed interface.
 *
 * Cross-story amputation and regression detection come for free by reusing the
 * existing IntegrationGate.run — no bespoke test runner is needed.
 *
 * `IntegrationGate` is reused unchanged per the shared contract.
 */
export async function runConsumerGate(args: RunConsumerGateArgs): Promise<GateOutcome> {
  const gate = args.gate ?? new IntegrationGate();
  return gate.run({ projectRoot: args.consumerRoot, conflicted: args.conflicted });
}

/**
 * Surfaces a partial-landing failure through three operator channels:
 *
 *   1. **Audit log** — emits `cross_repo.partial_landing` with `command = epicId`
 *      so `loom status` can read it via `audit.latestActionByCommand`.
 *   2. **Loom status** — readable via the audit event above; no separate write
 *      needed (the status command reads the audit log).
 *   3. **Producer PR note** — posts a `gh pr comment` on the producer PR so
 *      reviewers see the partial-landing failure inline.
 *
 * The producer PR is left MERGED — no rollback (out of scope per ADR-007).
 * The consumer PR is blocked by the caller setting `consumerStage.status = 'partial_landing'`.
 */
export async function surfacePartialLanding(
  epicId: string,
  producerPrUrl: string,
  summary: string,
  db: Database.Database,
  prCommentFn: PrCommentFn = defaultPrCommentFn,
): Promise<void> {
  // Channel 1 + 2: audit event (loom status reads via latestActionByCommand).
  const audit = new AuditLog(db);
  audit.record({
    action: 'cross_repo.partial_landing',
    command: epicId,
    detail: { producerPrUrl, summary },
  });

  // Channel 3: note on the producer PR.
  await prCommentFn(producerPrUrl, formatPartialLandingNote(summary));
}

function formatPartialLandingNote(summary: string): string {
  return (
    `⚠️ **Partial Landing Detected** — the consumer repo's integration gate ` +
    `failed after this PR merged.\n\n${summary}\n\n` +
    `Manual remediation is required before the consumer repo's PR can proceed. ` +
    `Consumer stories have been blocked to prevent further divergence.`
  );
}

async function defaultPrCommentFn(prUrl: string, body: string): Promise<void> {
  await execFileAsync('gh', ['pr', 'comment', prUrl, '--body', body], {
    encoding: 'utf8',
  });
}
