import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicStore, IntegrationBranch } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface SyncOptions {
  /** Defaults to 'main'. */
  mainBranch?: string;
  /** Override for testing; defaults to process.cwd(). */
  projectRoot?: string;
}

/**
 * `loom sync <epic-id>` — merge the latest main into an epic's rolling
 * integration branch on demand.
 *
 * Exit 0: integration branch is or becomes a descendant of main HEAD.
 * Exit 1: merge conflict or git error; branch left clean.
 */
export async function runSync(epicId: string, opts: SyncOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const loomDir = path.join(projectRoot, '.loom');

  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const epicStore = new EpicStore(db);
  const epic = epicStore.get(epicId);

  if (!epic) {
    console.error(`error: epic "${epicId}" not found.`);
    process.exit(1);
  }

  const ib = new IntegrationBranch(projectRoot);
  const wtPath = ib.path(epicId);

  if (!fs.existsSync(wtPath)) {
    console.error(
      `error: no integration worktree found for epic "${epicId}".`,
      '\n       Run the epic first so the integration branch is created.'
    );
    process.exit(1);
  }

  const mainBranch = opts.mainBranch ?? 'main';
  const result = await ib.syncWithMain(epicId, mainBranch);

  if (result.alreadyCurrent) {
    console.log(`epic/${epicId} is already up to date with ${mainBranch}.`);
    return;
  }

  if (result.conflicted) {
    console.error(`error: sync failed for epic "${epicId}".`);
    if (result.diagnostic) {
      console.error(result.diagnostic);
    }
    console.error('The integration branch has been left clean (merge aborted).');
    process.exit(1);
  }

  console.log(`Synced epic/${epicId} with ${mainBranch}: merged ${result.mergedCommits} commit(s).`);
}

export const syncSpec: CommandDescription = {
  name: 'sync',
  summary: "Merge latest main into an epic's rolling integration branch",
  whenToUse:
    "Use when the epic's integration branch has fallen behind main and you want to pull in the latest changes before dispatching more stories.",
  arguments: [
    {
      name: 'epic-id',
      type: 'string',
      required: true,
      description: 'Epic id whose integration branch to sync (e.g. epic-001)',
    },
  ],
  options: [
    {
      name: '--main-branch',
      type: 'string',
      default: 'main',
      description: "Name of the upstream branch to merge from (default: 'main')",
      changesOutputShape: false,
    },
  ],
  output: {
    text: 'Confirmation that the branch is current or reports of commits merged; errors on stderr',
  },
  examples: [
    {
      command: 'loom sync epic-001',
      description: "Merge latest main into epic-001's integration branch",
    },
    {
      command: 'loom sync epic-002 --main-branch develop',
      description: 'Sync using a non-default upstream branch',
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'Integration branch is or becomes current with main' },
    { code: 1, meaning: 'Merge conflict, git error, epic not found, or loom not initialized' },
  ],
  errors: [
    'Epic not found',
    'No integration worktree found — run the epic first',
    'git fetch or merge failed — integration branch left clean',
    'loom is not initialized — run `loom init` first',
  ],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'run'] },
};
