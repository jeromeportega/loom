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
