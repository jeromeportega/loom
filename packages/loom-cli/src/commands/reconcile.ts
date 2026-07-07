import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicReconciler, EpicFinalizer, EpicStore, AuditLog, PolicyEngine } from '@loom-ai/core';
import type { FinalizeResult } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface ReconcileCommandOptions {
  pr?: string;
  /** Test seam — inject git binary path. Production callers omit this. */
  _gitBin?: string;
  /** Test seam — inject gh binary path. Production callers omit this. */
  _ghBin?: string;
  /**
   * Test seam — inject resume function for finalizing epics. When provided,
   * skips EpicFinalizer construction and policy loading entirely, so tests
   * can exercise the routing logic without a real remote or policy file.
   */
  _resume?: (epicId: string) => FinalizeResult | Promise<FinalizeResult>;
}

/**
 * `loom reconcile <epic-id> [--pr <url>]` — verify a stranded-but-merged epic
 * and flip its status to done.
 *
 * Accepts epics in `finalizing` status: instead of requiring the branch to be
 * pre-merged, it delegates to EpicFinalizer.resume() which detects merge state
 * itself (FR-8). For epics already merged outside loom (in_progress / planned),
 * it uses the existing EpicReconciler ancestry / PR-URL path.
 *
 * Thin operator-facing wrapper around EpicReconciler. Identical logic is
 * exposed via the loom_reconcile_epic MCP tool so the two surfaces can never
 * diverge (ADR-2).
 */
export async function runReconcile(epicId: string, opts: ReconcileCommandOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);

  // FR-8: for epics currently being finalized, delegate to EpicFinalizer.resume()
  // which detects merge state itself (detectResumePhase) rather than requiring
  // the branch to already be merged. Accepts one redundant remote probe as the
  // cost of a single source of truth (ADR-5).
  const epicStore = new EpicStore(db);
  const epic = epicStore.get(epicId);
  if (epic && epic.status === 'finalizing') {
    let finalizeResult: FinalizeResult;
    if (opts._resume) {
      finalizeResult = await opts._resume(epicId);
    } else {
      let policy: ReturnType<typeof PolicyEngine.load>['policyData'];
      try {
        policy = PolicyEngine.load(loomDir).policyData;
      } catch (err) {
        console.error(`  Failed to load policy: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const finalizer = new EpicFinalizer({
        projectRoot,
        db,
        allowedRemotes: policy.git.allowed_remotes,
        prStrategy: policy.agents.pr_strategy,
        pushGate: policy.agents.push_gate,
        integrationGate: policy.agents.integration_gate,
        prAttribution: policy.agents.pr_attribution,
        testCommand: policy.agents.test_command,
        testCommands: policy.agents.test_commands,
        smokeCommand: policy.agents.smoke_command,
        smokeTimeoutMinutes: policy.agents.smoke_timeout_minutes,
        adversarialReviewModel: policy.agents.adversarial_review_model || undefined,
        // Late-bound rebind — re-read from disk so a mid-run policy edit takes effect.
        refreshPolicy: () => {
          const live = PolicyEngine.load(loomDir).policyData;
          return {
            allowedRemotes: live.git.allowed_remotes,
            testCommand: live.agents.test_command,
            testCommands: live.agents.test_commands,
            smokeCommand: live.agents.smoke_command,
            smokeTimeoutMinutes: live.agents.smoke_timeout_minutes,
            integrationGate: live.agents.integration_gate,
            pushGate: live.agents.push_gate,
            prAttribution: live.agents.pr_attribution,
          };
        },
      });
      finalizeResult = await finalizer.resume(epicId);
    }

    const audit = new AuditLog(db);
    console.log('');

    // skipped = noop: resume decided there was nothing to do. Epic stays in
    // finalizing; not an error, but also not reconciled — skip the audit row.
    if (finalizeResult.status === 'skipped') {
      console.log(`  Epic ${epicId} finalization skipped (nothing to do).`);
      console.log('');
      return;
    }

    // Record the attempt unconditionally before branching — CLAUDE.md invariant:
    // all agent actions logged before returning, including failures.
    const succeeded = finalizeResult.status === 'merged';
    audit.record({ action: 'epic_reconciled', command: epicId, allowed: succeeded, detail: { via: 'finalizing', status: finalizeResult.status } });

    if (!succeeded) {
      console.error(`  ${finalizeResult.note}`);
      if (finalizeResult.status === 'publish_pending') {
        console.error('  Run `loom publish` to complete.');
      }
      process.exit(1);
    }
    if (finalizeResult.url) console.log(`  PR: ${finalizeResult.url}`);
    console.log(`  ${finalizeResult.note}`);
    console.log('');
    return;
  }

  const reconciler = new EpicReconciler({
    projectRoot,
    db,
    ...(opts._gitBin ? { gitBin: opts._gitBin } : {}),
    ...(opts._ghBin ? { ghBin: opts._ghBin } : {}),
  });

  const result = reconciler.reconcile(epicId, { prUrl: opts.pr });

  console.log('');
  if (result.status === 'refused') {
    if (result.reason) console.log(`  reason: ${result.reason}`);
    console.log(`  ${result.note}`);
    process.exit(1);
  }
  if (result.status === 'failed') {
    console.log(`  ${result.note}`);
    process.exit(1);
  }
  console.log(`  ${result.note}`);
  console.log('');
}

export const spec: CommandDescription = {
  name: 'reconcile',
  summary: 'Reconcile a stranded-but-merged epic to done',
  whenToUse: 'Use when an epic was merged to main but loom DB still shows it as in-progress. Verifies the PR was merged via gh or git ancestry, then flips status to done.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [
    { name: '--pr', type: 'string', description: 'PR URL to verify via gh (required for squash-merged epics)', changesOutputShape: false },
  ],
  output: { text: 'Verification result and updated status' },
  examples: [
    { command: 'loom reconcile epic-001', description: 'Reconcile epic-001 via git ancestry check' },
    { command: 'loom reconcile epic-001 --pr https://github.com/org/repo/pull/42', description: 'Reconcile with explicit PR URL for squash merges' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic reconciled to done' },
    { code: 1, meaning: 'Epic not found, PR not merged, loom not initialized, or finalize failed / gated / partial / publish_pending' },
  ],
  errors: ['Epic not found', 'PR not merged or not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'archive'] },
};
