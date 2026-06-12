import path from 'node:path';
import { PolicyEngine } from '@loom-ai/core';
// Imported by module path, not the barrel: orchestrator/index.ts is owned by
// story-003-002 and does not export GateDryRun (a barrel export is a shared
// follow-up). loom-core exposes this single subpath in its package `exports`.
import { runGateDryRun } from '@loom-ai/core/orchestrator/GateDryRun.js';

/**
 * `loom doctor --dry-run-gate` — the explicit opt-in that actually executes the
 * integration-gate command once, in a throwaway detached worktree, and prints
 * the outcome. This is the ONLY CLI surface that runs the gate command outside a
 * real epic finalization: plain `loom doctor`, `loom epic`, and `loom run` never
 * do.
 */
export async function runGateDryRunCommand(projectRoot: string): Promise<void> {
  const policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;

  console.log('\n  loom doctor --dry-run-gate\n');
  console.log('  Executing the integration gate command once in a throwaway worktree...\n');

  const outcome = await runGateDryRun({
    projectRoot,
    testCommand: policy.agents.test_command,
  });

  console.log(`  worktree:   ${outcome.worktreePath}`);
  console.log(`  cleaned up: ${outcome.cleanedUp ? 'yes' : 'NO — worktree left behind!'}`);
  if (outcome.gate.command) {
    console.log(`  command:    ${outcome.gate.command}`);
  }
  console.log(`  [${outcome.gate.ok ? 'ok  ' : 'FAIL'}] ${outcome.gate.summary}`);

  const tail = outcome.gate.output.trim();
  if (tail.length > 0) {
    console.log('\n  --- command output (tail) ---');
    console.log(tail);
    console.log('  --- end output ---');
  }
  console.log('');
}
