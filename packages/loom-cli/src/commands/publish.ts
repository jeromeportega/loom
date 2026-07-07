import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicPublisher, EpicFinalizer, EpicStore, PolicyEngine } from '@loom-ai/core';
import type { FinalizeResult } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface PublishCommandOptions {
  /** Test seam — injectable PR-open function to avoid real gh invocations. */
  _openPr?: (input: { branch: string }) => string | undefined;
  /**
   * Test seam — injectable resume function for the finalizing path.
   * Production callers omit this; publish.ts constructs a real EpicFinalizer.
   */
  _resume?: (epicId: string) => Promise<FinalizeResult>;
}

export async function runPublish(epicId: string, opts: PublishCommandOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);

  // FR-7: detect finalizing epics and re-enter finalize via EpicFinalizer.resume()
  // rather than refusing them. detectResumePhase (inside resume()) determines the
  // exact remaining phases — open-pr, record-pr, push-and-open, or full-finalize.
  if (epicId.trim()) {
    const epic = new EpicStore(db).get(epicId);
    if (epic?.status === 'finalizing') {
      await handleFinalizing(epicId, db, projectRoot, loomDir, opts);
      return;
    }
  }

  // publish_pending path: EpicPublisher handles precondition checks + direct PR-open.
  const publisher = new EpicPublisher({
    projectRoot,
    db,
    ...(opts._openPr ? { openPr: opts._openPr } : {}),
  });

  const result = publisher.publish(epicId);

  console.log('');
  if (result.status === 'refused') {
    console.error(`  ${result.note}`);
    process.exit(1);
  } else if (result.status === 'failed') {
    console.error(`  ${result.note}`);
    process.exit(1);
  } else if (result.status === 'published') {
    if (result.prUrl) {
      console.log(`  PR: ${result.prUrl}`);
    }
    console.log(`  ${result.note}`);
    console.log('');
  } else {
    console.error(`  Unexpected publish status: ${result.status}`);
    process.exit(1);
  }
}

/**
 * FR-6 / FR-7: drives a finalizing epic to done via EpicFinalizer.resume().
 * resume() calls detectResumePhase, which reads git/gh to determine the exact
 * remaining work (open-pr, record-pr, push-and-open, or full-finalize), then
 * completes only those remaining phases atomically.
 */
async function handleFinalizing(
  epicId: string,
  db: ReturnType<typeof openProjectDatabase>,
  projectRoot: string,
  loomDir: string,
  opts: PublishCommandOptions
): Promise<void> {
  let result: FinalizeResult;
  if (opts._resume) {
    result = await opts._resume(epicId);
  } else {
    const policy = PolicyEngine.load(loomDir).policyData;
    // Full gate/push config (mirrors reconcile.ts) so a full-finalize arm re-runs
    // the integration gate and push gate under policy rather than silently off.
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
      refreshPolicy: () => {
        const live = PolicyEngine.load(loomDir).policyData;
        return {
          allowedRemotes: live.git.allowed_remotes,
          testCommand: live.agents.test_command,
          testCommands: live.agents.test_commands,
          integrationGate: live.agents.integration_gate,
          pushGate: live.agents.push_gate,
          prAttribution: live.agents.pr_attribution,
        };
      },
    });
    result = await finalizer.resume(epicId);
  }

  console.log('');
  if (result.status === 'merged' || result.status === 'partial') {
    if (result.url) console.log(`  PR: ${result.url}`);
    console.log(`  ${result.note}`);
    console.log('');
  } else {
    // skipped (noop-terminal / concurrent lease), failed, gated, publish_pending
    console.error(`  ${result.note}`);
    process.exit(1);
  }
}

export const spec: CommandDescription = {
  name: 'publish',
  audience: 'internal',
  summary: 'Drive a finalizing or publish-pending epic to done',
  whenToUse: 'Use when an epic is stuck in finalizing or publish_pending — the finalizer pushed the branch but the PR step failed, or finalize was interrupted mid-flight. Re-enters EpicFinalizer.resume() so detectResumePhase decides push-vs-open-vs-record. Distinct from reconcile, which verifies an already-merged epic.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [],
  output: { text: 'PR URL and updated status' },
  examples: [
    { command: 'loom publish epic-001', description: 'Resume a finalizing or publish-pending epic to done' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic driven to done (PR opened or already done)' },
    { code: 1, meaning: 'Epic not found, not recoverable, PR open failed, or loom not initialized' },
  ],
  errors: [
    'Epic not found',
    'Epic is not finalizing or publish_pending',
    'No remote configured (noop-terminal)',
    'gh pr create failed',
    'loom is not initialized — run `loom init` first',
  ],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'diff'] },
};
