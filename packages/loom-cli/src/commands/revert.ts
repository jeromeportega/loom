import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, EpicReverter, PolicyEngine } from '@loom-ai/core';

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
  const db = openDatabase(loomDir);

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
