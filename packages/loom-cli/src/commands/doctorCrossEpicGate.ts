import path from 'node:path';
import { PolicyEngine } from '@loom-ai/core';
// Imported by module subpath, not the barrel (mirrors doctorDryRunGate.ts):
// orchestrator/index.ts is owned by another story and does not export
// CrossEpicGate. loom-core exposes this single subpath in its package
// `exports`.
import { runCrossEpicGate } from '@loom-ai/core/orchestrator/CrossEpicGate.js';

/**
 * `loom doctor --cross-epic-gate` — the opt-in that merges every open epic
 * branch into a throwaway union worktree and runs the suite once, to answer
 * "do these epics land together cleanly right now?" without mutating any real
 * branch. `--epics <a,b>` narrows the set to an explicit allowlist instead of
 * the `epic/*` glob.
 *
 * Exit codes mirror runCrossEpicGate: 0 clean, 3 advisory (conflict or union
 * suite failure), 1 operational (no epic branches, worktree creation failed,
 * gate command unresolvable).
 */
export async function runCrossEpicGateCommand(
  projectRoot: string,
  epics?: string[]
): Promise<void> {
  const policy = PolicyEngine.load(path.join(projectRoot, '.loom')).policyData;

  console.log('\n  loom doctor --cross-epic-gate\n');
  console.log('  Merging every open epic branch into a throwaway union worktree...\n');

  const outcome = await runCrossEpicGate({
    projectRoot,
    testCommand: policy.agents.test_command,
    epics,
  });

  console.log(`  worktree:   ${outcome.worktreePath}`);
  console.log(`  cleaned up: ${outcome.cleanedUp ? 'yes' : 'NO — worktree left behind!'}`);

  if (outcome.conflicts.length > 0) {
    for (const c of outcome.conflicts) {
      console.log(`\n  [FAIL] ${c.epicB} conflicts with ${c.epicA}:`);
      for (const f of c.files) console.log(`           - ${f}`);
    }
  } else if (outcome.gate) {
    if (outcome.gate.command) console.log(`  command:    ${outcome.gate.command}`);
    const mark = outcome.exitCode === 0 ? 'ok  ' : 'FAIL';
    console.log(`  [${mark}] ${outcome.gate.summary}`);
    const tail = outcome.gate.output.trim();
    if (tail.length > 0) {
      console.log('\n  --- union suite output (tail) ---');
      console.log(tail);
      console.log('  --- end output ---');
    }
  }

  console.log(`\n  ${outcome.summary}\n`);
  process.exit(outcome.exitCode);
}
