import type Database from 'better-sqlite3';
import { AuditLog } from '../state/index.js';
import { IntegrationGate } from './IntegrationGate.js';
import type { GateOutcome } from './IntegrationGate.js';
import type { RepoStage } from './CrossRepoCoordinator.js';

/** Injectable PR-comment function for tests. */
export type PrCommentFn = (prUrl: string, body: string) => Promise<void>;

/**
 * Structural injection interface for a gate runner — narrows the injection
 * point to the `run` method only, eliminating unsafe `as unknown as IntegrationGate`
 * casts in tests. `IntegrationGate` satisfies this interface structurally.
 */
export interface GateRunner {
  run(input: { projectRoot: string; conflicted?: string[] }): Promise<GateOutcome>;
}

export interface RunConsumerGateArgs {
  /** The consumer repo stage (carries dependsOnRepos for fan-in validation). */
  consumer: RepoStage;
  /**
   * ALL producer stages of `consumer` that have already landed.
   * When not all declared dependencies are present with status 'landed', the
   * gate is deferred and returns ran:false. This is the fan-in guard (ADR-003):
   * the gate fires exactly once — triggered when the last dependency lands —
   * never once-per-incoming-edge.
   */
  landedDependencies: RepoStage[];
  /** Absolute path to the consumer repo root — where the integration gate runs. */
  projectRoot: string;
  /**
   * Story IDs of stories whose PRs failed to merge (amputation signal).
   * Forwarded verbatim to IntegrationGate.run for cross-story conflict detection.
   * Per-repo gate mechanics are unchanged (NFR-4) — this field mirrors the
   * existing `conflicted` parameter the gate already accepts.
   */
  conflicted?: string[];
  /** Injectable gate for tests. Defaults to a standard IntegrationGate. */
  gate?: GateRunner;
}

/**
 * Runs the IntegrationGate in the consumer worktree after ALL of its producer
 * dependencies have landed, so the consumer build resolves against the combined
 * landed state of every upstream repo.
 *
 * Fan-in guard: the gate is deferred (ran:false) until every declared dependency
 * appears in `landedDependencies` with status 'landed'. Once all deps are present,
 * the per-repo integration gate runs exactly once per invocation.
 *
 * Stateless — the 'fire exactly once per consumer lifecycle' invariant is the
 * caller's responsibility (ADR-003). Callers must not re-invoke after all deps
 * are already present; a second call with a complete fan-in will fire the gate
 * a second time. The coordinator enforces this by tracking which consumers have
 * already been gated.
 *
 * Per-repo `IntegrationGate.run` mechanics are unchanged (NFR-4): the same gate
 * runner executes in the consumer repo root once the fan-in condition is met,
 * with the `conflicted` amputation signal forwarded verbatim.
 */
export async function runConsumerGate(args: RunConsumerGateArgs): Promise<GateOutcome> {
  const { consumer, landedDependencies, projectRoot } = args;

  // Root repos (no declared dependencies) are not consumers — skip.
  if (consumer.dependsOnRepos.length === 0) {
    return deferredGateOutcome('No dependencies — consumer gate not applicable for a root repo.');
  }

  // Fan-in guard: only fire when ALL declared dependencies are present in
  // landedDependencies with status 'landed' (in-degree-to-zero in the landed sense).
  const allDepsLanded = consumer.dependsOnRepos.every(
    slug => landedDependencies.some(dep => dep.repoSlug === slug && dep.status === 'landed'),
  );

  if (!allDepsLanded) {
    return deferredGateOutcome('Consumer gate deferred — not all dependencies have landed yet.');
  }

  // All dependencies landed — run the per-repo integration gate.
  // Forward conflicted to preserve amputation-detection mechanics (NFR-4).
  const gate = args.gate ?? new IntegrationGate();
  return gate.run({ projectRoot, conflicted: args.conflicted });
}

function deferredGateOutcome(summary: string): GateOutcome {
  return {
    ok: true,
    ran: false,
    timedOut: false,
    durationMs: 0,
    output: '',
    amputated: [],
    summary,
  };
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
  try {
    audit.record({
      action: 'cross_repo.partial_landing',
      command: epicId,
      detail: { producerPrUrl, summary },
    });
  } catch (err) {
    // Audit write failure must not silently swallow the event — emit to stderr
    // so operators can diagnose a missing audit entry without re-running.
    process.stderr.write(
      `[loom] WARNING: failed to write partial_landing audit entry for ${epicId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

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
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('gh', ['pr', 'comment', prUrl, '--body', body], {
      encoding: 'utf8',
    });
  } catch (err) {
    // Best-effort: a comment-post failure must not abort the coordinator after
    // the producer PR has already merged. The audit entry and status are already
    // recorded; loss of the PR comment is observable but non-fatal.
    process.stderr.write(
      `[loom] WARNING: failed to post partial_landing comment on ${prUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
