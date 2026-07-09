import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PolicyEngine,
  resolveLoomHomePath,
  resolveRepoStatePaths,
  prepareRepoState,
  registerRepo,
  readManifest,
} from '@loom-ai/core';

function loadPolicy(loomDir: string): { loom_home?: string } {
  try {
    return PolicyEngine.load(loomDir).policyData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Non-ENOENT (parse failure, validation error): warn but proceed with defaults
    // so migrate does not silently use a wrong loom_home path.
    process.stderr.write(`warning: failed to load policy.yaml: ${(err as Error).message}\n`);
    return {};
  }
}

type LoomHomeStatus = 'missing' | 'non-git' | 'git';

function detectLoomHomeStatus(loomHomePath: string): LoomHomeStatus {
  if (!fs.existsSync(loomHomePath)) return 'missing';
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: loomHomePath,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return 'git';
  } catch {
    return 'non-git';
  }
}

/**
 * Count untracked planning entries that would be migrated.
 * Mirrors the detection logic in migratePlanningScratch — skip git-tracked entries
 * and entries already present at the destination. Uses a single git ls-files call
 * (matching the CWD used by migratePlanningScratch's isGitTrackedEntry) rather
 * than one subprocess per entry.
 */
function countMigrableEntries(scratchSrcRoot: string, planningRoot: string): number {
  if (!fs.existsSync(scratchSrcRoot)) return 0;
  const entries = fs.readdirSync(scratchSrcRoot);
  if (entries.length === 0) return 0;

  // Single git ls-files call — same CWD as migratePlanningScratch's isGitTrackedEntry.
  let trackedEntries: Set<string>;
  try {
    const result = execFileSync('git', ['ls-files', ...entries], {
      cwd: scratchSrcRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Extract top-level names from the returned paths (handles nested paths).
    trackedEntries = new Set(
      result.trim().split('\n').filter(Boolean).map(p => p.split('/')[0])
    );
  } catch {
    trackedEntries = new Set(); // git unavailable or not a git repo — treat all as untracked
  }

  let count = 0;
  for (const entry of entries) {
    if (trackedEntries.has(entry)) continue; // git-tracked — migratePlanningScratch skips these
    if (fs.existsSync(path.join(planningRoot, entry))) continue; // already at destination
    count++;
  }
  return count;
}

function getCommittedLoomOutputs(projectRoot: string): string[] {
  try {
    const result = execFileSync('git', ['ls-files', '.loom_outputs'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns true when there are no staged or unstaged changes to tracked files.
 * Untracked files are ignored (they cannot be folded into a `git rm` commit).
 */
function isWorkingTreeClean(projectRoot: string): boolean {
  try {
    const result = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Lines starting with '??' are untracked — they cannot be committed by git rm.
    // Anything else (M, A, D, R, C, U, …) represents tracked-file changes.
    const trackedChanges = result.split('\n').filter(l => l && !l.startsWith('??'));
    return trackedChanges.length === 0;
  } catch {
    return false;
  }
}

function copyDirRecursive(src: string, dst: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      copyDirRecursive(path.join(src, child), path.join(dst, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

/**
 * Returns true when both user.email and user.name are configured in git.
 * Used to decide whether to supply a fallback identity via -c flags on commit.
 */
function hasGitIdentity(projectRoot: string): boolean {
  try {
    execFileSync('git', ['config', 'user.email'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    execFileSync('git', ['config', 'user.name'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

export function runMigrate(opts: {
  dryRun?: boolean;
  relocateCommittedArtifacts?: boolean;
}): void {
  const { dryRun = false, relocateCommittedArtifacts = false } = opts;

  const projectRoot = (() => {
    try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); }
  })();
  const loomDir = path.join(projectRoot, '.loom');
  const policy = loadPolicy(loomDir);

  const loomHome = resolveLoomHomePath(projectRoot, policy);
  const dbPaths = resolveRepoStatePaths(projectRoot, policy);

  // ─── Pre-detect state (same resolution/detection logic for real run and dry-run) ─
  const loomHomeStatus = detectLoomHomeStatus(loomHome);

  const srcDbPath = path.join(loomDir, 'loom.db');
  const srcDbExists = fs.existsSync(srcDbPath);
  const dstDbExists = fs.existsSync(dbPaths.dbPath);
  // DB will migrate when source exists, destination does not, and they are not the same file.
  const dbWillMigrate = srcDbExists && !dstDbExists &&
    path.resolve(srcDbPath) !== path.resolve(dbPaths.dbPath);

  const scratchSrcRoot = path.join(loomDir, 'planning');
  const migrableCount = countMigrableEntries(scratchSrcRoot, dbPaths.planningRoot);

  // Manifest: check if repo's real path is already registered.
  const realProjectRoot = (() => {
    try { return fs.realpathSync(projectRoot); } catch { return projectRoot; }
  })();
  const manifestBefore = readManifest(loomHome);
  const alreadyInManifest = manifestBefore.repos.some(r => r.path === realProjectRoot);

  // Committed artifact relocation
  const committedOutputs = relocateCommittedArtifacts
    ? getCommittedLoomOutputs(projectRoot)
    : [];

  // Compute once; reused in both the dry-run preview and the live precondition check.
  const workingTreeClean = isWorkingTreeClean(projectRoot);

  // ─── Precondition check (before any operations) ─────────────────────────────
  if (relocateCommittedArtifacts && !dryRun && committedOutputs.length > 0) {
    if (!workingTreeClean) {
      process.stderr.write(
        '\nerror: working tree has uncommitted changes.\n' +
        '--relocate-committed-artifacts requires a clean working tree to avoid\n' +
        'folding unrelated changes into the git rm commit.\n' +
        'Commit or stash your changes first, then re-run:\n' +
        '  loom migrate --relocate-committed-artifacts\n\n'
      );
      process.exit(1);
    }
  }

  // ─── Dry-run path ────────────────────────────────────────────────────────────
  if (dryRun) {
    console.log('');
    console.log('  loom migrate --dry-run');
    console.log('');

    if (loomHomeStatus === 'missing') {
      console.log(`  loom-home  would create at ${loomHome} (git init)`);
    } else if (loomHomeStatus === 'non-git') {
      console.log(`  loom-home  would git init existing directory at ${loomHome}`);
    } else {
      console.log(`  loom-home  already exists: ${loomHome}`);
    }

    if (dbWillMigrate) {
      console.log(`  state db   would migrate: .loom/loom.db → ${dbPaths.dbPath}`);
    } else if (!srcDbExists) {
      console.log(`  state db   no legacy .loom/loom.db found (nothing to migrate)`);
    } else {
      console.log(`  state db   already at loom-home (no migration needed)`);
    }

    if (migrableCount > 0) {
      console.log(`  planning   would migrate ${migrableCount} entr${migrableCount === 1 ? 'y' : 'ies'} → ${dbPaths.planningRoot}`);
    } else {
      console.log(`  planning   nothing to migrate`);
    }

    if (!alreadyInManifest) {
      console.log(`  manifest   would register repo in ${path.join(loomHome, 'workspace.yaml')}`);
    } else {
      console.log(`  manifest   already registered in workspace.yaml`);
    }

    if (relocateCommittedArtifacts) {
      if (committedOutputs.length === 0) {
        console.log(`  artifacts  no committed .loom_outputs to relocate`);
      } else if (!workingTreeClean) {
        console.log(`  artifacts  WARN: working tree is dirty — would refuse to relocate committed artifacts`);
        console.log(`             (commit or stash your changes first, then re-run without --dry-run)`);
      } else {
        const dst = path.join(dbPaths.namespaceDir, 'loom_outputs');
        console.log(`  artifacts  would relocate ${committedOutputs.length} file(s) → ${dst}`);
        console.log(`             would create single forward commit (git rm + git commit)`);
      }
    }

    console.log('');
    console.log('  (no changes made — re-run without --dry-run to apply)');
    console.log('');
    return;
  }

  // ─── Actual run ──────────────────────────────────────────────────────────────
  console.log('');

  // 1. Ensure loom-home + run state/scratch migration (canonical path with locking)
  const { namespaceDir } = prepareRepoState(projectRoot, policy);

  if (loomHomeStatus === 'missing') {
    console.log(`  loom-home  ${loomHome} (created)`);
  } else if (loomHomeStatus === 'non-git') {
    console.log(`  loom-home  ${loomHome} (git initialized)`);
  } else {
    console.log(`  loom-home  ${loomHome}`);
  }

  if (dbWillMigrate) {
    console.log(`  state db   migrated → ${dbPaths.dbPath}`);
  } else if (!srcDbExists && !dstDbExists) {
    console.log(`  state db   no legacy db (nothing to migrate)`);
  } else {
    console.log(`  state db   already at loom-home`);
  }

  if (migrableCount > 0) {
    console.log(`  planning   ${migrableCount} entr${migrableCount === 1 ? 'y' : 'ies'} migrated → ${dbPaths.planningRoot}`);
  } else {
    console.log(`  planning   nothing to migrate`);
  }

  // 2. Register in workspace manifest (idempotent)
  const entry = registerRepo(loomHome, projectRoot);
  if (!alreadyInManifest) {
    console.log(`  manifest   registered as ${entry.slug} in ${path.join(loomHome, 'workspace.yaml')}`);
  } else {
    console.log(`  manifest   already registered as ${entry.slug} — run loom projects to see all registered repos`);
  }

  // 3. Relocate committed .loom_outputs artifacts (opt-in)
  if (relocateCommittedArtifacts) {
    if (committedOutputs.length === 0) {
      console.log(`  artifacts  no committed .loom_outputs to relocate`);
    } else {
      // Copy to loom-home under repos/<slug>/loom_outputs/
      const loomOutputsSrc = path.join(projectRoot, '.loom_outputs');
      const loomOutputsDst = path.join(namespaceDir, 'loom_outputs');
      if (fs.existsSync(loomOutputsSrc)) {
        try {
          copyDirRecursive(loomOutputsSrc, loomOutputsDst);
        } catch (err) {
          throw new Error(
            `failed to copy artifacts from ${loomOutputsSrc} to ${loomOutputsDst}: ` +
            `${(err as Error).message}`
          );
        }
      }

      // Remove from working tree and index
      execFileSync('git', ['rm', '-r', '.loom_outputs'], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Create a single forward commit (no history rewrite).
      // -c user.{email,name}: supply a fallback identity via flag (not written to
      //   .git/config) when the repo has no configured git identity.
      // Signing policy is deliberately NOT overridden — the repo's own signing
      // config applies, honouring any branch-protection requirement (AC: no
      // guardrail weakened).
      const commitMessage =
        `loom migrate: relocate .loom_outputs artifacts to loom-home\n\n` +
        `Moved ${committedOutputs.length} file(s) to ${loomOutputsDst}.\n` +
        `This is a forward commit — no prior commits are rewritten.`;
      const commitArgs = [
        ...(!hasGitIdentity(projectRoot)
          ? ['-c', 'user.email=loom@loom.local', '-c', 'user.name=loom']
          : []),
        'commit', '-m', commitMessage,
      ];
      try {
        execFileSync('git', commitArgs, {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (commitErr) {
        // git rm -r already deleted working-tree files and staged the deletions.
        // Restore both the index and working tree to HEAD so the repo is left in a
        // clean, recoverable state. Artifacts are still safe in loom-home.
        try {
          execFileSync(
            'git',
            ['restore', '--source=HEAD', '--staged', '--worktree', '.loom_outputs'],
            { cwd: projectRoot, stdio: 'ignore' }
          );
        } catch { /* best-effort restore */ }
        throw new Error(
          `failed to commit artifact relocation — working-tree and index restored to HEAD. ` +
          `Artifacts are intact in loom-home at ${loomOutputsDst}. ` +
          `Re-run loom migrate --relocate-committed-artifacts to retry. ` +
          `Cause: ${(commitErr as Error).message}`
        );
      }

      console.log(`  artifacts  ${committedOutputs.length} file(s) relocated → ${loomOutputsDst}`);
      console.log(`             single forward commit created (no history rewrite)`);
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const isNoop =
    loomHomeStatus === 'git' &&
    !dbWillMigrate &&
    migrableCount === 0 &&
    alreadyInManifest &&
    (!relocateCommittedArtifacts || committedOutputs.length === 0);

  console.log('');
  if (isNoop) {
    console.log('  Nothing to do — already up to date.');
  } else {
    console.log('  Done.');
  }
  console.log('');
}

export const spec: CommandDescription = {
  name: 'migrate',
  audience: 'internal',
  summary: 'Explicitly migrate this repo into the loom-home workspace (idempotent)',
  whenToUse:
    'Run inside a target repo to ensure loom-home exists, migrate legacy state and ' +
    'planning scratch, and register the repo in the workspace manifest. Safe to re-run ' +
    'on an already-migrated repo — reports "nothing to do". Use --dry-run to preview ' +
    'every action without changing anything.',
  arguments: [],
  options: [
    {
      name: '--dry-run',
      type: 'boolean',
      description: 'Preview all actions without making any changes on disk, in state, or in git',
      changesOutputShape: false,
    },
    {
      name: '--relocate-committed-artifacts',
      type: 'boolean',
      description:
        'Remove committed .loom_outputs artifacts from the target repo via a single forward ' +
        'git commit (git rm + commit, no history rewrite) and copy them to loom-home. ' +
        'Refused when the working tree is dirty to avoid folding unrelated changes into the commit.',
      changesOutputShape: false,
    },
  ],
  output: {
    text:
      'Progress report naming the loom-home location, what was migrated, and the manifest entry. ' +
      'Reports "nothing to do" when already up to date.',
  },
  examples: [
    { command: 'loom migrate', description: 'Migrate this repo into the loom-home workspace' },
    { command: 'loom migrate --dry-run', description: 'Preview migration actions without making any changes' },
    {
      command: 'loom migrate --relocate-committed-artifacts',
      description: 'Also relocate committed .loom_outputs artifacts to loom-home via a forward commit',
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'Migration completed or nothing to do' },
    {
      code: 1,
      meaning:
        'Working tree is dirty when --relocate-committed-artifacts is requested, or an unrecoverable error occurred',
    },
  ],
  errors: [
    'working tree has uncommitted changes — commit or stash before using --relocate-committed-artifacts',
  ],
  relationships: {
    prerequisites: ['init'],
    nextSteps: ['status', 'epic'],
  },
};
