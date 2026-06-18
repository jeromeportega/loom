import type { CommandDescription } from '../describe/schema.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitSafe } from '@loom-ai/core';

export interface ReleaseCommandOptions {
  /** Test seam — injectable bump script runner. Production callers omit this. */
  _runBump?: (version: string, cwd: string) => void;
  /** Test seam — injectable lockfile refresh runner. Production callers omit this. */
  _runNpmInstall?: (cwd: string) => void;
  /** Test seam — type is typeof gitSafe so any signature drift surfaces at compile time. */
  _git?: typeof gitSafe;
  /** Test seam — injectable gh runner. Returns captured output (e.g. PR URL). */
  _gh?: (args: string[], cwd: string) => string | undefined;
}

// Never pushes main directly; creates release/v<version>, commits, pushes, and opens a PR.
export function runRelease(version: string, opts: ReleaseCommandOptions = {}): void {
  const projectRoot = process.cwd();

  // Normalize: strip leading 'v' so internal logic always works with bare semver.
  const ver = version.startsWith('v') ? version.slice(1) : version;

  // Validate semver: pre-release and build-metadata allow alphanumeric, dots, and hyphens only.
  // Underscores are not valid per semver 2.0; hyphens (e.g. 1.2.3-alpha-1) are.
  if (!/^\d+\.\d+\.\d+(-[-a-zA-Z0-9.]+)?(\+[-a-zA-Z0-9.]+)?$/.test(ver)) {
    console.error('  Invalid version — must be semver, e.g. 1.2.3');
    process.exit(1);
  }

  const branch = `release/v${ver}`;
  const commitMsg = `chore(release): v${ver}`;

  const runBump = opts._runBump ?? defaultRunBump;
  const runNpmInstall = opts._runNpmInstall ?? defaultRunNpmInstall;
  const runGit = opts._git ?? gitSafe;
  const runGh = opts._gh ?? defaultRunGh;

  // 1. Bump all workspace package.json versions via the existing script.
  try {
    runBump(ver, projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  bump-versions failed: ${msg}`);
    process.exit(1);
  }

  // 2. Create the release branch before refreshing the lockfile so any mutation is
  //    isolated to this branch, not the caller's working branch.
  const checkoutResult = runGit(projectRoot, ['checkout', '-b', branch]);
  if (!checkoutResult.ok) {
    console.error(`  Failed to create branch ${branch}: ${checkoutResult.output}`);
    process.exit(1);
  }

  // 2b. Refresh the lockfile to reflect the bumped versions.
  //     --package-lock-only rewrites package-lock.json without touching node_modules.
  //     Release is already an online operation (opens a PR via gh), so registry access is accepted.
  try {
    runNpmInstall(projectRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Lockfile refresh failed — run \`npm install --package-lock-only\` manually and retry: ${msg}`);
    process.exit(1);
  }

  // 3a. Stage version-bump files and the refreshed lockfile.
  const addResult = runGit(projectRoot, ['add', '--', 'package.json', 'packages/*/package.json', 'package-lock.json']);
  if (!addResult.ok) {
    console.error(`  Failed to stage version-bump files: ${addResult.output}`);
    process.exit(1);
  }

  // 3b. Commit staged changes only — no -a flag so unrelated dirty files are excluded.
  const commitResult = runGit(projectRoot, ['commit', '-m', commitMsg]);
  if (!commitResult.ok) {
    console.error(`  Failed to commit: ${commitResult.output}`);
    process.exit(1);
  }

  // 4. Push the release branch. Never pushes main; release/v* passes the guard.
  const pushResult = runGit(projectRoot, ['push', '-u', 'origin', branch]);
  if (!pushResult.ok) {
    console.error(`  Failed to push ${branch}: ${pushResult.output}`);
    process.exit(1);
  }

  // 5. Open the PR against main.
  const prArgs = [
    'pr', 'create',
    '--head', branch,
    '--base', 'main',
    '--title', commitMsg,
    '--body', 'Automated release PR — bumps all workspace package versions. Merge this PR, then tag the merge commit.',
  ];
  const prUrl = runGh(prArgs, projectRoot);
  if (!prUrl) {
    console.error('  Failed to open PR — run `gh pr create` manually or check gh auth.');
    process.exit(1);
  }

  console.log('');
  console.log(`  PR: ${prUrl}`);
  console.log(`  Release ${ver} pushed as ${branch}. Merge the PR, then tag the merge commit.`);
  console.log('');
}

function defaultRunNpmInstall(cwd: string): void {
  execFileSync('npm', ['install', '--package-lock-only'], { cwd, stdio: 'inherit' });
}

function defaultRunBump(version: string, cwd: string): void {
  const scriptPath = path.join(cwd, 'scripts', 'bump-versions.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`bump-versions script not found at ${scriptPath}`);
  }
  execFileSync('node', [scriptPath, version], { cwd, stdio: 'inherit' });
}

function defaultRunGh(args: string[], cwd: string): string | undefined {
  try {
    const output = execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const lines = output.split('\n').filter(Boolean);
    return lines[lines.length - 1] || undefined;
  } catch {
    return undefined;
  }
}

export const spec: CommandDescription = {
  name: 'release',
  audience: 'internal',
  summary: 'Bump versions and open a release PR against main',
  whenToUse:
    'Use to cut a guard-compatible release: bumps all workspace versions via bump-versions.mjs, creates release/v<version>, commits, pushes, and opens a PR against main. Never pushes main directly. Post-merge step (operator): git tag v<version> <merge-sha> && git push origin v<version>.',
  arguments: [
    {
      name: 'version',
      type: 'string',
      required: true,
      description: 'Semver to release (e.g. 1.2.3 or v1.2.3)',
    },
  ],
  options: [],
  output: { text: 'PR URL for the release branch' },
  examples: [
    {
      command: 'loom release 1.2.3',
      description: 'Bump to 1.2.3, push release/v1.2.3, open PR against main',
    },
    {
      command: 'loom release v1.2.3',
      description: 'Same as above (leading v is stripped)',
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'Release branch pushed and PR opened' },
    { code: 1, meaning: 'Invalid semver, bump script failed, git operation failed, or gh PR creation failed' },
  ],
  errors: [
    'Invalid semver version string',
    'bump-versions.mjs not found or exited non-zero',
    'git checkout -b failed (branch already exists)',
    'git add failed (unexpected git error)',
    'git commit failed (nothing to commit or other error)',
    'git push failed (no remote configured or authentication error)',
    'gh pr create failed (missing auth token or gh not installed)',
  ],
  relationships: { prerequisites: [], nextSteps: [] },
};
