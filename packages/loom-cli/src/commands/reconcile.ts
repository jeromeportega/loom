import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, EpicReconciler } from '@loom-ai/core';

export interface ReconcileCommandOptions {
  pr?: string;
  /** Test seam — inject git binary path. Production callers omit this. */
  _gitBin?: string;
  /** Test seam — inject gh binary path. Production callers omit this. */
  _ghBin?: string;
}

/**
 * `loom reconcile <epic-id> [--pr <url>]` — verify a stranded-but-merged epic
 * and flip its status to done.
 *
 * Thin operator-facing wrapper around EpicReconciler. Identical logic is
 * exposed via the loom_reconcile_epic MCP tool so the two surfaces can never
 * diverge (ADR-2).
 */
export function runReconcile(epicId: string, opts: ReconcileCommandOptions = {}): void {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openDatabase(loomDir);
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
    { code: 1, meaning: 'Epic not found, PR not merged, or loom not initialized' },
  ],
  errors: ['Epic not found', 'PR not merged or not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'archive'] },
};
