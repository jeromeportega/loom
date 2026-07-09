import type { CommandDescription } from '../describe/schema.js';
import type { FinalizeResult } from '@loom-ai/core';
import fs from 'node:fs';
import path from 'node:path';
import { EpicFinalizer, EpicStore, PolicyEngine } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';
import { runReconcile } from './reconcile.js';

export interface RecoverCommandOptions {
  pr?: string;
  /** Test seam: injectable resume function; skips real EpicFinalizer construction */
  _resume?: (epicId: string) => FinalizeResult | Promise<FinalizeResult>;
}

export async function runRecover(epicId: string, opts?: RecoverCommandOptions): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  try {
    const epicStore = new EpicStore(db);
    const epic = epicStore.get(epicId);

    if (!epic) {
      console.error(`  Epic ${epicId} not found.`);
      process.exit(1);
    }

    if (epic.status === 'finalizing' || epic.status === 'publish_pending') {
      if (opts?.pr) {
        console.warn('  Note: --pr is only used on the reconcile path; ignored for finalizing/publish_pending epics.');
      }

      let result: FinalizeResult;
      try {
        if (opts?._resume) {
          result = await opts._resume(epicId);
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
            adversarialReviewModel: policy.agents.adversarial_review_model ?? undefined,
            refreshPolicy: () => {
              const live = PolicyEngine.load(loomDir).policyData;
              return {
                allowedRemotes: live.git.allowed_remotes,
                prStrategy: live.agents.pr_strategy,
                testCommand: live.agents.test_command,
                testCommands: live.agents.test_commands,
                smokeCommand: live.agents.smoke_command,
                smokeTimeoutMinutes: live.agents.smoke_timeout_minutes,
                integrationGate: live.agents.integration_gate,
                pushGate: live.agents.push_gate,
                prAttribution: live.agents.pr_attribution,
                adversarialReviewModel: live.agents.adversarial_review_model ?? undefined,
              };
            },
          });
          result = await finalizer.resume(epicId);
        }
      } catch (err) {
        console.error(`  Recover failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      console.log('');
      if (result.status === 'merged') {
        if (result.url) console.log(`  PR: ${result.url}`);
        console.log(`  ${result.note}`);
        console.log('');
        return;
      }
      if (result.status === 'partial') {
        // partial = epic not cleanly done; some story branches had conflicts needing manual intervention
        if (result.url) console.error(`  PR: ${result.url}`);
        console.error(`  ${result.note}`);
        if (result.conflicted?.length) {
          console.error(`  Conflicted: ${result.conflicted.join(', ')}`);
        }
        process.exit(1);
      }
      if (result.status === 'skipped') {
        const currentEpic = epicStore.get(epicId);
        const currentStatus = currentEpic?.status ?? 'unknown';
        if (currentStatus === 'done') {
          console.log(`  Epic ${epicId} already done — no action needed.`);
          console.log('');
          return;
        }
        console.error(`  ${result.note}`);
        console.error(`  Ensure policy.git.allowed_remotes includes the push target and gh is available.`);
        process.exit(1);
      }
      if (result.status === 'publish_pending') {
        console.error(`  ${result.note}`);
        console.error(`  Run \`loom recover ${epicId}\` to retry the publish step.`);
        process.exit(1);
      }
      // gated, failed, or any future status
      console.error(`  ${result.note}`);
      process.exit(1);
    }

    // Default: delegate to reconcile for merged-outside-loom and all other states
    await runReconcile(epicId, { pr: opts?.pr });
  } finally {
    if (db.open) db.close();
  }
}

export const spec: CommandDescription = {
  name: 'recover',
  summary: 'Drive a stuck epic to done (auto-detects finalizing, publish_pending, or merged-outside-loom state)',
  whenToUse: 'Use when an epic is stranded: in finalizing, publish_pending, or merged outside loom.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-042)' },
  ],
  options: [
    { name: '--pr', type: 'string', description: 'PR URL for merged-outside-loom path', changesOutputShape: false },
  ],
  output: { text: 'Recovery result and updated status' },
  examples: [
    { command: 'loom recover epic-042', description: 'Auto-detect state and drive epic-042 to done' },
    { command: 'loom recover epic-042 --pr https://github.com/org/repo/pull/99', description: 'Recover with explicit PR URL for squash-merged epics' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic driven to done' },
    { code: 1, meaning: 'Epic not found, finalization blocked, or loom not initialized' },
  ],
  errors: ['Epic not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'archive'] },
};
