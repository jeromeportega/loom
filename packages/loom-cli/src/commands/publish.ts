import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, EpicPublisher } from '@loom-ai/core';

export interface PublishCommandOptions {
  /** Test seam — injectable PR-open function to avoid real gh invocations. */
  _openPr?: (input: { branch: string }) => string | undefined;
}

/**
 * `loom publish <epic-id>` — open the PR from a publish_pending epic's
 * already-pushed finalizer ref and flip status to done.
 *
 * Distinct from `loom reconcile`: reconcile verifies an *already-merged* epic
 * that loom missed; publish opens the PR for an epic whose finalizer pushed the
 * branch but the PR step failed. The two commands have mutually exclusive
 * preconditions and must never overlap.
 */
export function runPublish(epicId: string, opts: PublishCommandOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
  const publisher = new EpicPublisher({
    projectRoot,
    db,
    ...(opts._openPr ? { openPr: opts._openPr } : {}),
  });

  const result = publisher.publish(epicId);

  console.log('');
  if (result.status === 'refused') {
    console.log(`  ${result.note}`);
    process.exit(1);
  } else if (result.status === 'failed') {
    console.log(`  ${result.note}`);
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

export const spec: CommandDescription = {
  name: 'publish',
  summary: 'Open the PR for a publish-pending epic and flip it to done',
  whenToUse: 'Use when an epic is stuck in publish_pending — the finalizer pushed the branch but the PR step failed. Reads the saved finalize_ref, opens the PR via gh, then atomically records the PR URL and sets status to done. Distinct from reconcile, which verifies an already-merged epic.',
  arguments: [
    { name: 'epic-id', type: 'string', required: true, description: 'Epic id (e.g. epic-001)' },
  ],
  options: [],
  output: { text: 'PR URL and updated status' },
  examples: [
    { command: 'loom publish epic-001', description: 'Open PR for epic-001 from its saved finalize_ref and mark it done' },
  ],
  exitCodes: [
    { code: 0, meaning: 'PR opened and epic flipped to done' },
    { code: 1, meaning: 'Epic not found, not publish_pending, PR open failed, or loom not initialized' },
  ],
  errors: [
    'Epic not found',
    'Epic is not publish_pending — use loom reconcile for already-merged epics',
    'No finalize_ref recorded on epic',
    'gh pr create failed',
    'loom is not initialized — run `loom init` first',
  ],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'archive'] },
};
