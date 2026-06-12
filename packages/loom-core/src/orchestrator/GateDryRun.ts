import fs from 'node:fs';
import path from 'node:path';
import { git, gitSafe } from './git.js';
import { IntegrationGate, type GateOutcome } from './IntegrationGate.js';

export interface GateDryRunOutcome {
  /** Absolute path to the throwaway worktree (".loom/integration/gate-dryrun-<pid>"). */
  worktreePath: string;
  /** Verbatim result of IntegrationGate.run() inside that worktree. */
  gate: GateOutcome;
  /** True once the worktree has been force-removed and is gone from disk. */
  cleanedUp: boolean;
}

export interface GateDryRunDeps {
  /**
   * Test seam: the gate run inside the throwaway worktree. Production callers
   * omit this and get a real `IntegrationGate`, which is the whole point — the
   * dry-run inherits the gate's timeout / kill / output-tail semantics verbatim
   * instead of re-implementing command execution.
   */
  gate?: Pick<IntegrationGate, 'run'>;
}

/**
 * Execute the integration-gate command ONCE in a throwaway, detached-HEAD
 * worktree and report what happened. Invoked only on the explicit
 * `loom doctor --dry-run-gate` opt-in — planning (`loom epic` / `loom run`)
 * never reaches this path, so the gate command is never run silently.
 *
 * The worktree is created with the same `git worktree add` path the real gate
 * relies on, but lives under `.loom/integration/` (NOT `.loom/worktrees/`) so
 * the `WorktreeJanitor` — which only reaps story worktrees under
 * `.loom/worktrees/` — never races us for it. We own its full lifecycle and
 * force-remove it in a `finally`, so no dry-run can leak a worktree.
 *
 * Trade-off: a detached HEAD on the current tree validates the command's
 * runnability against what is checked out now, not against a future integrated
 * epic tree. It answers "would this command even start here?", which is exactly
 * what the doctor opt-in promises.
 */
export async function runGateDryRun(
  opts: { projectRoot: string; testCommand?: string; timeoutMs?: number },
  deps: GateDryRunDeps = {}
): Promise<GateDryRunOutcome> {
  const integrationDir = path.join(opts.projectRoot, '.loom', 'integration');
  const worktreePath = path.join(integrationDir, `gate-dryrun-${process.pid}`);

  fs.mkdirSync(integrationDir, { recursive: true });
  git(opts.projectRoot, ['worktree', 'add', '--detach', worktreePath, 'HEAD']);

  // Assigned in the try before the post-finally return; a gate that throws
  // propagates past the finally, so reaching the return implies `gate` is set.
  let gate: GateOutcome | undefined;
  try {
    const runner =
      deps.gate ??
      new IntegrationGate({ testCommand: opts.testCommand, timeoutMs: opts.timeoutMs });
    gate = await runner.run({ projectRoot: worktreePath });
  } finally {
    gitSafe(opts.projectRoot, ['worktree', 'remove', '--force', worktreePath]);
    gitSafe(opts.projectRoot, ['worktree', 'prune']);
  }

  return { worktreePath, gate: gate as GateOutcome, cleanedUp: !fs.existsSync(worktreePath) };
}
