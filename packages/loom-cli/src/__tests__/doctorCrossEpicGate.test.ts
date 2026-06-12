/**
 * End-to-end wiring proof for `loom doctor --cross-epic-gate` (+ `--epics`),
 * asserted on the REAL CLI subprocess (mirrors doctorDryRunGate.test.ts). This
 * pins that the option is registered on `doctor` (no new top-level command),
 * that the exit-code contract surfaces through the process (0 clean / 3
 * advisory / 1 operational), and that `--epics` narrows the branch set. The
 * gate command is a real `printf` so no cursor-agent / network runs.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOOM_CLI = path.resolve(__dirname, '../index.js');

let tmpDir: string;

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

function gitc(args: string[]): void {
  execSync(`git ${args.join(' ')}`, { cwd: tmpDir });
}

/** Creates `epic/<id>` with a unique commit on `file`, then returns to main. */
function makeEpicBranch(id: string, file: string, content: string): void {
  gitc(['checkout', '-q', '-b', `epic/${id}`]);
  fs.writeFileSync(path.join(tmpDir, file), content);
  gitc(['add', file]);
  execSync(`git commit -q -m "epic ${id}"`, { cwd: tmpDir });
  gitc(['checkout', '-q', 'main']);
}

before(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-xepic-cli-')));
  execSync('git init -q -b main', { cwd: tmpDir });
  execSync('git config user.email test@loom.dev', { cwd: tmpDir });
  execSync('git config user.name "Loom Test"', { cwd: tmpDir });
  execSync('git config commit.gpgsign false', { cwd: tmpDir });
  loom(['init']);
  // A green, always-resolvable gate command (configured wins over detection).
  fs.writeFileSync(
    path.join(tmpDir, '.loom', 'policy.yaml'),
    `agents:\n  test_command: 'printf "ok\\n"'\n`
  );
  fs.writeFileSync(path.join(tmpDir, 'README.md'), '# base\n');
  execSync('git add README.md', { cwd: tmpDir });
  execSync('git commit -q -m init', { cwd: tmpDir });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loom doctor --cross-epic-gate (CLI wiring)', () => {
  it('no epic branches → exit 1 (operational), and never leaves an integration worktree', () => {
    const r = loom(['doctor', '--cross-epic-gate']);
    assert.equal(r.status, 1, 'zero epic branches is an operational exit 1');
    assert.match(r.stdout, /no epic branches/i);
    const integrationDir = path.join(tmpDir, '.loom', 'integration');
    const leftover = fs.existsSync(integrationDir) ? fs.readdirSync(integrationDir) : [];
    assert.deepEqual(leftover, [], 'no worktree may leak');
  });

  it('two clean epics + green gate → exit 0, worktree cleaned up', () => {
    makeEpicBranch('clean-a', 'a.txt', 'A\n');
    makeEpicBranch('clean-b', 'b.txt', 'B\n');
    const r = loom(['doctor', '--cross-epic-gate']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /union suite passed/i);
    const integrationDir = path.join(tmpDir, '.loom', 'integration');
    const leftover = fs.existsSync(integrationDir) ? fs.readdirSync(integrationDir) : [];
    assert.deepEqual(leftover, [], 'the throwaway worktree must be removed');
    // Clean up branches for the next case.
    gitc(['branch', '-D', 'epic/clean-a']);
    gitc(['branch', '-D', 'epic/clean-b']);
  });

  it('two epics that conflict on a file → exit 3 (advisory) with the conflicting file named', () => {
    makeEpicBranch('conf-a', 'shared.txt', 'A-side\n');
    makeEpicBranch('conf-b', 'shared.txt', 'B-side\n');
    const r = loom(['doctor', '--cross-epic-gate']);
    assert.equal(r.status, 3, `a mechanical conflict is advisory exit 3, got ${r.status}\n${r.stdout}`);
    assert.match(r.stdout, /shared\.txt/, 'the conflicting file is reported');
    assert.match(r.stdout, /conflict/i);
    gitc(['branch', '-D', 'epic/conf-a']);
    gitc(['branch', '-D', 'epic/conf-b']);
  });

  it('--epics restricts to exactly the allowlisted branches (a third epic/* branch is ignored)', () => {
    // Three epic/* branches exist; the allowlist names only two of them. The
    // summary must report a 2-branch union, proving the glob was NOT used.
    makeEpicBranch('keep-a', 'ka.txt', 'KA\n');
    makeEpicBranch('keep-b', 'kb.txt', 'KB\n');
    makeEpicBranch('skip-c', 'kc.txt', 'KC\n');

    const r = loom(['doctor', '--cross-epic-gate', '--epics', 'keep-a,keep-b']);
    assert.equal(r.status, 0, `allowlist of clean epics → exit 0, got ${r.status}\n${r.stdout}`);
    assert.match(r.stdout, /All 2 epic branches/, 'exactly the 2 allowlisted branches were gated');

    gitc(['branch', '-D', 'epic/keep-a']);
    gitc(['branch', '-D', 'epic/keep-b']);
    gitc(['branch', '-D', 'epic/skip-c']);
  });
});
