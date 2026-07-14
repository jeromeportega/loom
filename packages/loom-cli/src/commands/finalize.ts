import type { CommandDescription } from '../describe/schema.js';
import type { FinalizeResult } from '@loom-ai/core';
import fs from 'node:fs';
import path from 'node:path';
import {
  EpicFinalizer,
  EpicStore,
  PolicyEngine,
  PR_STRATEGY,
  PUSH_GATE,
  INTEGRATION_GATE,
  PR_ATTRIBUTION,
  SMOKE_TIMEOUT_MINUTES,
} from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

const RECOVERABLE_STATUSES = ['finalizing', 'publish_pending'] as const;

export interface FinalizeCommandOptions {
  resume?: boolean;
  /** Test seam — injectable finalizer; skips real EpicFinalizer construction. */
  _finalizer?: { resume: (epicId: string) => Promise<FinalizeResult> };
}

export async function runFinalize(epicId: string, opts: FinalizeCommandOptions = {}): Promise<void> {
  if (!opts.resume) {
    console.error('Usage: loom finalize --resume <epic-id>');
    console.error('The --resume flag is required to re-enter a stranded finalize.');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const epicStore = new EpicStore(db);
  const epic = epicStore.get(epicId);

  if (!epic) {
    console.error(`  Epic ${epicId} not found.`);
    process.exit(1);
  }

  if (!(RECOVERABLE_STATUSES as readonly string[]).includes(epic.status)) {
    console.error(
      `  Epic ${epicId} is in status '${epic.status}', which is not a recoverable finalize state.`
    );
    console.error(`  Only epics with status 'finalizing' or 'publish_pending' can be resumed.`);
    process.exit(1);
  }

  let result: FinalizeResult;
  try {
    if (opts._finalizer) {
      result = await opts._finalizer.resume(epicId);
    } else {
      const policy = PolicyEngine.load(loomDir).policyData;
      // Construct with the full gate/push config (mirrors reconcile.ts). If resume
      // takes the full-finalize arm it re-runs the gate and push — omitting these
      // would silently disable the integration gate and push gate, bypassing policy.
      const ef = new EpicFinalizer({
        projectRoot,
        db,
        allowedRemotes: policy.git.allowed_remotes,
        prStrategy: PR_STRATEGY,
        pushGate: PUSH_GATE,
        integrationGate: INTEGRATION_GATE,
        testCommands: policy.agents.test_commands,
        smokeCommand: policy.agents.smoke_command,
        smokeTimeoutMinutes: SMOKE_TIMEOUT_MINUTES,
        prAttribution: PR_ATTRIBUTION,
        testCommand: policy.agents.test_command,
        adversarialReviewModel: policy.agents.adversarial_review_model || undefined,
        // Late-bound rebind — re-read from disk so a mid-run policy edit takes effect.
        refreshPolicy: () => {
          const live = PolicyEngine.load(loomDir).policyData;
          return {
            allowedRemotes: live.git.allowed_remotes,
            testCommand: live.agents.test_command,
            testCommands: live.agents.test_commands,
            smokeCommand: live.agents.smoke_command,
            smokeTimeoutMinutes: SMOKE_TIMEOUT_MINUTES,
            integrationGate: INTEGRATION_GATE,
            pushGate: PUSH_GATE,
            prAttribution: PR_ATTRIBUTION,
          };
        },
      });
      result = await ef.resume(epicId);
    }
  } catch (err) {
    console.error(`  Finalize failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // resume() owns the done write — it flips status to 'done' atomically inside the
  // state machine, gated on a recorded PR URL. The CLI never writes 'done' itself:
  // doing so could set status=done with epic_pr_url=NULL, violating the
  // done ⇒ epic_pr_url invariant the Supervisor done-gate exists to protect.
  if (result.status === 'merged') {
    console.log('');
    if (result.url) {
      console.log(`  PR: ${result.url}`);
    }
    console.log(`  ${result.note}`);
    console.log('');
  } else if (result.status === 'skipped') {
    console.error(`  ${result.note}`);
    console.error(
      `  Ensure policy.git.allowed_remotes includes the push target and gh is available.`
    );
    process.exit(1);
  } else {
    console.error(`  ${result.note}`);
    process.exit(1);
  }
}

export const spec: CommandDescription = {
  name: 'finalize',
  audience: 'internal',
  summary: 'Resume a stranded finalize and drive the epic to done',
  whenToUse:
    "Use when an epic is stuck in 'finalizing' or 'publish_pending' — re-enters the finalize state machine from the current phase and drives the epic to done without redoing merged work.",
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [
    {
      name: '--resume',
      type: 'boolean',
      description: 'Re-enter finalize for the named epic (required)',
      changesOutputShape: false,
    },
  ],
  output: { text: 'PR URL and updated status' },
  examples: [
    {
      command: 'loom finalize --resume epic-001',
      description: "Resume a stranded finalize for epic-001 and drive it to done",
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic resumed and driven to done' },
    {
      code: 1,
      meaning:
        'Epic not found, not in a recoverable state, no usable remote, or loom not initialized',
    },
  ],
  errors: [
    'Epic not found',
    "Epic is not in a recoverable finalize state (must be 'finalizing' or 'publish_pending')",
    'No usable remote configured in policy.git.allowed_remotes',
    'loom is not initialized — run `loom init` first',
    '--resume flag is required',
  ],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'diff'] },
};
