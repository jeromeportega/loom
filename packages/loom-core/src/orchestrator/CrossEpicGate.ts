import fs from 'node:fs';
import path from 'node:path';
import { gitSafe } from './git.js';
import { IntegrationGate, type GateOutcome } from './IntegrationGate.js';

/**
 * Cross-epic union gate (FR-9/FR-10). Answers the operator's pre-merge
 * question "if I land every open epic together right now, do they conflict and
 * does the suite still pass?" — WITHOUT mutating a single real branch.
 *
 * It composes, never re-implements: it reuses the same `git worktree add
 * --detach` + `finally`-force-remove lifecycle as `runGateDryRun`, and the same
 * `IntegrationGate.run()` the finalizer uses, so timeout / kill / output-tail
 * semantics are inherited verbatim instead of forked.
 *
 * The flow:
 *   1. Resolve the open epic branches (`opts.epics` allowlist else
 *      `git branch --list 'epic/*'`). Zero branches is an operational error
 *      (exitCode 1) — there is nothing to gate.
 *   2. Create a throwaway DETACHED worktree at the default branch's tip.
 *   3. Merge each epic branch in order with `git merge --no-ff`. The FIRST
 *      conflict records the conflicting file list for that pair and STOPS —
 *      the union is already known-incoherent, so running the suite would be
 *      noise. Advisory exitCode 3.
 *   4. If every merge is clean, run the integration-gate command ONCE on the
 *      union tree. A failure (or an unresolvable command — we cannot prove the
 *      union builds) is reported; a pass is exitCode 0.
 *   5. The worktree is ALWAYS force-removed in a `finally`. The real epic
 *      branches are only ever read (resolve + merge-into-a-copy); they are
 *      byte-unchanged before and after.
 *
 * Exit-code contract (mirrors `loom doctor` advisory vs operational split):
 *   0 — all merges clean AND the suite passed.
 *   3 — ADVISORY: a per-pair conflict, OR the union suite failed. The operator
 *       has real work to do, but loom itself ran fine.
 *   1 — OPERATIONAL: loom could not even run the check (no epic branches,
 *       worktree creation failed, gate command unresolvable).
 *
 * Trade-off (the promised scope): the detached union worktree validates
 * "these epics merge + pass TOGETHER, right now," not "they merge against a
 * future-moved default branch." It is a point-in-time coherence probe, not a
 * standing guarantee.
 */
export interface CrossEpicGateOutcome {
  /** 0 clean / 3 advisory (conflict | union-fail) / 1 operational. */
  exitCode: 0 | 1 | 3;
  /**
   * Per-pair merge conflicts. `epicA` is the branch already on the union tip
   * (the default branch for the first conflict, else the last cleanly-merged
   * epic); `epicB` is the branch that failed to merge. Non-empty ⇒ exitCode 3
   * and merging stopped at the first conflict.
   */
  conflicts: Array<{ epicA: string; epicB: string; files: string[] }>;
  /** The integration-gate result — present ONLY when every merge was clean. */
  gate?: GateOutcome;
  /** Absolute path to the throwaway union worktree. */
  worktreePath: string;
  /** True once the worktree has been force-removed and is gone from disk. */
  cleanedUp: boolean;
  /** Human-readable one-liner explaining the outcome (for the CLI render). */
  summary: string;
}

export interface CrossEpicGateDeps {
  /**
   * Test seam: the gate run inside the union worktree. Production callers omit
   * this and get a real `IntegrationGate` — the whole point is that the
   * cross-epic gate inherits the gate's execution semantics verbatim.
   */
  gate?: Pick<IntegrationGate, 'run'>;
  /**
   * Test seam: the open-epic-branch lister. Production omits it and resolves
   * via `git branch --list 'epic/*'`. The allowlist (`opts.epics`) always wins
   * over this when present.
   */
  listEpicBranches?: () => string[];
}

/**
 * Resolve the tip the union worktree branches from: the default branch.
 * Prefers the remote's HEAD symref (origin/HEAD → e.g. origin/main), then a
 * local main/master, then falls back to the current HEAD so a brand-new repo
 * with a non-standard default branch still works.
 */
function defaultBranchTip(projectRoot: string): string {
  const symref = gitSafe(projectRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symref.ok && symref.output) {
    const name = symref.output.replace(/^refs\/remotes\//, '');
    if (gitSafe(projectRoot, ['rev-parse', '--verify', '--quiet', name]).ok) return name;
  }
  for (const candidate of ['main', 'master']) {
    if (gitSafe(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`]).ok) {
      return candidate;
    }
  }
  return 'HEAD';
}

/**
 * Resolve the open epic branches to gate. The allowlist always wins: each id
 * is mapped to its `epic/<id>` branch (an id already prefixed with `epic/` is
 * passed through). Without an allowlist we enumerate `epic/*`.
 */
function resolveEpicBranches(
  projectRoot: string,
  opts: { epics?: string[] },
  deps: CrossEpicGateDeps
): string[] {
  if (opts.epics && opts.epics.length > 0) {
    return opts.epics
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .map((id) => (id.startsWith('epic/') ? id : `epic/${id}`));
  }
  if (deps.listEpicBranches) return deps.listEpicBranches();
  const res = gitSafe(projectRoot, ['branch', '--list', '--format=%(refname:short)', 'epic/*']);
  if (!res.ok) return [];
  return res.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Repo-relative paths with unmerged (conflicted) index entries in `wt`. */
function unmergedPaths(wt: string): string[] {
  const res = gitSafe(wt, ['diff', '--name-only', '--diff-filter=U']);
  if (!res.ok) return [];
  return res.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export async function runCrossEpicGate(
  opts: { projectRoot: string; testCommand?: string; epics?: string[]; timeoutMs?: number },
  deps: CrossEpicGateDeps = {}
): Promise<CrossEpicGateOutcome> {
  // 1. Resolve the branches BEFORE touching the filesystem — a zero-branch
  //    repo is an operational no-op, not a clean pass (exitCode 1).
  const branches = resolveEpicBranches(opts.projectRoot, opts, deps);
  const integrationDir = path.join(opts.projectRoot, '.loom', 'integration');
  const worktreePath = path.join(integrationDir, `cross-epic-gate-${process.pid}`);

  if (branches.length === 0) {
    return {
      exitCode: 1,
      conflicts: [],
      worktreePath,
      cleanedUp: true,
      summary:
        'No epic branches to gate — nothing matched the allowlist or `epic/*`. ' +
        'Cross-epic gate skipped.',
    };
  }

  // 2. Throwaway DETACHED worktree at the default-branch tip. Creation failure
  //    is operational (exitCode 1). Lives under .loom/integration/ (NOT
  //    .loom/worktrees/) so the WorktreeJanitor never races us for it.
  const tip = defaultBranchTip(opts.projectRoot);
  fs.mkdirSync(integrationDir, { recursive: true });
  const added = gitSafe(opts.projectRoot, ['worktree', 'add', '--detach', worktreePath, tip]);
  if (!added.ok) {
    // No worktree was created, so there is nothing to clean up. Best-effort
    // prune in case a partial admin record was left behind.
    gitSafe(opts.projectRoot, ['worktree', 'prune']);
    return {
      exitCode: 1,
      conflicts: [],
      worktreePath,
      cleanedUp: !fs.existsSync(worktreePath),
      summary: `Could not create the union worktree at ${tip}: ${added.output}`,
    };
  }

  const conflicts: CrossEpicGateOutcome['conflicts'] = [];
  // Assembled in the try; the post-finally return stamps `cleanedUp` once the
  // worktree has actually been reaped (mirrors runGateDryRun's ordering — the
  // existence probe MUST run after the finally, never inside it).
  let result: Omit<CrossEpicGateOutcome, 'cleanedUp'> | undefined;
  try {
    // 3. Sequential `git merge --no-ff`. The first conflict records the pair
    //    and STOPS — the union is already incoherent.
    let unionTip = tip;
    for (const branch of branches) {
      const merge = gitSafe(worktreePath, [
        'merge',
        '--no-ff',
        '-m',
        `cross-epic-gate: merge ${branch}`,
        branch,
      ]);
      if (merge.ok) {
        unionTip = branch;
        continue;
      }
      const files = unmergedPaths(worktreePath);
      // Abort so the worktree index is clean for the force-remove.
      gitSafe(worktreePath, ['merge', '--abort']);
      conflicts.push({ epicA: unionTip, epicB: branch, files });
      break;
    }

    if (conflicts.length > 0) {
      const c = conflicts[0];
      result = {
        exitCode: 3,
        conflicts,
        worktreePath,
        summary:
          `Cross-epic conflict: ${c.epicB} does not merge cleanly onto ${c.epicA} ` +
          `(${c.files.length} file${c.files.length === 1 ? '' : 's'}: ${c.files.join(', ')}). ` +
          'Merging stopped at the first conflict; resolve it before landing these epics together.',
      };
    } else {
      // 4. Every merge clean → run the suite ONCE on the union tree.
      const runner =
        deps.gate ??
        new IntegrationGate({ testCommand: opts.testCommand, timeoutMs: opts.timeoutMs });
      const gate = await runner.run({ projectRoot: worktreePath });

      if (!gate.ran) {
        // A gate that found no command to run cannot prove the union builds —
        // for the cross-epic probe that is an OPERATIONAL failure (exitCode 1),
        // distinct from the finalizer where an undetectable suite degrades to
        // the amputation-only check.
        result = {
          exitCode: 1,
          conflicts,
          gate,
          worktreePath,
          summary:
            'Cross-epic gate could not resolve a test command for the union tree — ' +
            'set policy.agents.test_command so the suite can run. ' +
            `(${gate.summary})`,
        };
      } else if (!gate.ok) {
        result = {
          exitCode: 3,
          conflicts,
          gate,
          worktreePath,
          summary: `All ${branches.length} epic branches merged cleanly, but the union suite failed: ${gate.summary}`,
        };
      } else {
        result = {
          exitCode: 0,
          conflicts,
          gate,
          worktreePath,
          summary: `All ${branches.length} epic branches merge cleanly and the union suite passed: ${gate.summary}`,
        };
      }
    }
  } finally {
    // 5. ALWAYS reap the worktree — clean, conflict, gate-fail, or throw.
    gitSafe(opts.projectRoot, ['worktree', 'remove', '--force', worktreePath]);
    gitSafe(opts.projectRoot, ['worktree', 'prune']);
  }

  // `result` is assigned on every non-throwing path; a gate that throws
  // propagates past the finally (and the worktree is already reaped).
  return { ...(result as Omit<CrossEpicGateOutcome, 'cleanedUp'>), cleanedUp: !fs.existsSync(worktreePath) };
}
