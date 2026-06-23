import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicReverter, PolicyEngine } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface RevertCommandOptions {
  remote?: boolean;
  reason?: string;
}

/**
 * `loom revert <epic-id>` — tear down an epic locally (and optionally on
 * the remote). Local-only by default; --remote also deletes the upstream
 * epic branch and closes any open PRs loom opened for the epic.
 *
 * Operator-facing wrapper around EpicReverter; the heavy lifting + audit
 * logging lives there so an MCP tool can reuse it later.
 */
export function runRevert(epicId: string, opts: RevertCommandOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const policy = PolicyEngine.load(loomDir).policyData;
  const db = openProjectDatabase(projectRoot);

  const reverter = new EpicReverter({
    projectRoot,
    db,
    allowedRemotes: policy.git.allowed_remotes,
  });

  const result = reverter.revert(epicId, {
    remote: opts.remote === true,
    reason: opts.reason,
  });

  console.log('');
  if (result.status === 'failed' || result.status === 'skipped') {
    console.log(`  ${result.note}`);
    if (result.status === 'failed') process.exit(1);
    return;
  }

  console.log(`  ${result.note}`);
  if (result.deleted_refs.length > 0) {
    console.log('');
    console.log('  Local refs deleted:');
    for (const ref of result.deleted_refs) console.log(`    ${ref}`);
  }
  if (opts.remote) {
    if (result.deleted_remote_refs.length > 0) {
      console.log('');
      console.log('  Remote refs deleted:');
      for (const ref of result.deleted_remote_refs) console.log(`    ${ref}`);
    }
    if (result.pr_closures.length > 0) {
      console.log('');
      console.log('  PR closures:');
      for (const pr of result.pr_closures) {
        console.log(`    ${pr.closed ? '✓' : '✗'} ${pr.url}${pr.error ? '  (' + pr.error + ')' : ''}`);
      }
    }
  }
  if (result.status === 'partial') {
    console.log('');
    console.log('  Partial — some remote actions failed; re-run with --remote after addressing the errors above.');
    process.exit(1);
  }
  console.log('');
}

export const spec: CommandDescription = {
  name: 'revert',
  summary: 'Tear down an epic: delete branches and flip DB status',
  whenToUse: 'Use to fully undo an epic: deletes the epic and story branches locally, flips DB status. Add --remote to also delete the upstream branch and close the PR.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [
    { name: '--remote', type: 'boolean', description: 'Also delete the remote epic branch and close any loom-opened PR', changesOutputShape: false },
    { name: '--reason', type: 'string', description: 'Explanation recorded with the revert in audit_log', changesOutputShape: false },
  ],
  output: { text: 'Summary of deleted branches and updated DB status' },
  examples: [
    { command: 'loom revert epic-001', description: 'Tear down epic-001 locally' },
    { command: 'loom revert epic-001 --remote', description: 'Tear down epic-001 and delete the remote branch' },
    { command: 'loom revert epic-001 --reason "Cancelled"', description: 'Revert with an audit note' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Epic reverted successfully' },
    { code: 1, meaning: 'Epic not found, remote deletion failed, or loom not initialized' },
  ],
  errors: ['Epic not found', 'Remote deletion failed — check allowed_remotes in policy', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'epic'] },
};
