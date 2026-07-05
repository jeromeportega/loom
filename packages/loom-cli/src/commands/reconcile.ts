import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { EpicReconciler, EpicFinalizer, EpicStore, PolicyEngine } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

// FinalizeResult is defined in story-066-001's EpicFinalizer. The worktree resolves
// @loom-ai/core from the main repo (via node_modules symlink) which predates that
// story's merge into the epic branch, so the type is declared locally as a structural
// alias rather than imported. The shape matches EpicFinalizer.ts exactly.
interface FinalizeResult {
  url?: string;
  status: 'skipped' | 'merged' | 'partial' | 'failed' | 'gated' | 'publish_pending';
  conflicted: string[];
  merged: string[];
  cleaned: string[];
  note: string;
}

// Structural interface for the resume() method added in story-066-001.
// EpicFinalizer is typed from the main repo's dist which predates resume().
type WithResume = { resume(epicId: string): Promise<FinalizeResult> };

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
      const policy = PolicyEngine.load(loomDir).policyData;
      const finalizer = new EpicFinalizer({
        projectRoot,
        db,
        allowedRemotes: policy.git.allowed_remotes,
        prStrategy: policy.agents.pr_strategy,
      });
      finalizeResult = await (finalizer as unknown as WithResume).resume(epicId);
    }

    console.log('');
    if (finalizeResult.status === 'failed') {
      console.error(`  ${finalizeResult.note}`);
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
    { code: 1, meaning: 'Epic not found, PR not merged, or loom not initialized' },
  ],
  errors: ['Epic not found', 'PR not merged or not found', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['run'], nextSteps: ['status', 'archive'] },
};
