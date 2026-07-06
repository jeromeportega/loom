/**
 * Opt-in proof for the gate dry-run, asserted on the REAL CLI (subprocess,
 * mirroring gatePreflightWiring.test.ts). The gate command is wired to append
 * one line to a marker file each time it actually runs, so the marker's line
 * count IS the execution count. The headline acceptance criterion — the gate
 * command runs zero times unless `--dry-run-gate` is given, and exactly once
 * when it is — is pinned by counting those lines across every entry point.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

// Excludes user-level bin dirs so the `claude` CLI is never found: `loom epic`
// then fails its LLM call *after* any preflight, which is the boundary we want.
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let tmpDir: string;
let marker: string;

function loom(
  args: string[],
  env: Record<string, string> = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [LOOM_CLI, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, LOOM_HOME: path.join(tmpDir, '.loom-home'), ...env },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

/** How many times the gate command has run = lines written to the marker. */
function gateRunCount(): number {
  if (!fs.existsSync(marker)) return 0;
  return fs
    .readFileSync(marker, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dryrun-cli-')));
  execSync('git init -q', { cwd: tmpDir });
  execSync('git config user.email test@loom.dev', { cwd: tmpDir });
  execSync('git config user.name "Loom Test"', { cwd: tmpDir });
  execSync('git config commit.gpgsign false', { cwd: tmpDir });
  loom(['init']);

  marker = path.join(tmpDir, 'gate-ran.log');
  // Configured command always wins over auto-detection (source: 'configured'),
  // so no lockfile is needed for it to be runnable. Single-quoted YAML keeps the
  // backslash literal; the shell's printf turns "\n" into a newline at run time.
  fs.writeFileSync(
    path.join(tmpDir, '.loom', 'policy.yaml'),
    `agents:\n  test_command: 'printf "ran\\n" >> ${marker}'\n`
  );

  // A commit so HEAD exists for `git worktree add --detach ... HEAD`.
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# dry-run cli test\n');
  execSync('git add README.md', { cwd: tmpDir });
  execSync('git commit -q -m init', { cwd: tmpDir });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(marker, { force: true });
});

describe('loom doctor — gate execution behaviour', () => {
  it('plain `loom doctor` does NOT execute the gate command (binary-resolution only, no worktree)', () => {
    loom(['doctor']);
    assert.equal(
      gateRunCount(),
      0,
      'plain doctor must NOT execute the gate command — it only checks that lead binaries resolve on the gate PATH; real execution is `--dry-run-gate` only'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.loom', 'integration')),
      'plain doctor must not create an integration worktree'
    );
  });

  it('`loom doctor --dry-run-gate` runs the gate command EXACTLY once and reports the outcome', () => {
    const result = loom(['doctor', '--dry-run-gate']);
    assert.equal(gateRunCount(), 1, 'the dry-run must execute the gate command exactly once');

    assert.ok(
      result.stdout.includes('Integration gate passed'),
      `expected the gate outcome on stdout, got:\n${result.stdout}`
    );
    assert.ok(
      result.stdout.includes(path.join('.loom', 'integration', 'gate-dryrun-')),
      'the reported worktree path must be under .loom/integration/'
    );

    // No leak: the throwaway worktree is gone afterward.
    const integrationDir = path.join(tmpDir, '.loom', 'integration');
    const leftover = fs.existsSync(integrationDir) ? fs.readdirSync(integrationDir) : [];
    assert.deepEqual(leftover, [], 'the dry-run must not leave a worktree behind');
  });
});

describe('planning paths never execute the gate command', () => {
  it('`loom epic` runs the gate command zero times', () => {
    // Fails later for lack of the claude CLI on the bare PATH — but only AFTER
    // any preflight, so the marker proves the gate command itself never ran.
    loom(['epic', 'Build a tiny demo feature for the dry-run wiring test.'], { PATH: BARE_PATH });
    assert.equal(gateRunCount(), 0, 'loom epic must never execute the gate command');
  });

  it('`loom run` runs the gate command zero times', () => {
    const result = loom(['run']);
    assert.equal(gateRunCount(), 0, 'loom run must never execute the gate command');
    assert.ok(
      result.stdout.includes('No approved epics to run'),
      'sanity: loom run reached the supervisor with no approved epics'
    );
  });
});
