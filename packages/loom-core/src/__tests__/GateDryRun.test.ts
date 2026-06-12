import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGateDryRun } from '../orchestrator/GateDryRun.js';
import {
  IntegrationGate,
  type GateOutcome,
  type CommandRunner,
} from '../orchestrator/IntegrationGate.js';

let repo: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  // realpath: `git worktree` reports realpaths, so a symlinked tmpdir (macOS
  // /var -> /private/var) would otherwise break path-equality assertions.
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dryrun-')));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# dry-run test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function stubOutcome(over: Partial<GateOutcome> = {}): GateOutcome {
  return {
    ok: true,
    ran: true,
    command: 'stub',
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    output: '',
    amputated: [],
    summary: 'stub passed',
    ...over,
  };
}

describe('runGateDryRun', () => {
  it('creates a detached worktree under .loom/integration/ — never .loom/worktrees/ (janitor safety)', async () => {
    let projectRootSeen = '';
    let existedDuringRun = false;
    let porcelainDuringRun = '';
    const gate = {
      run: async (input: { projectRoot: string }): Promise<GateOutcome> => {
        projectRootSeen = input.projectRoot;
        existedDuringRun = fs.existsSync(input.projectRoot);
        porcelainDuringRun = gitc(['worktree', 'list', '--porcelain']);
        return stubOutcome();
      },
    };

    const outcome = await runGateDryRun({ projectRoot: repo }, { gate });

    const expectedSuffix = path.join('.loom', 'integration', `gate-dryrun-${process.pid}`);
    assert.ok(
      outcome.worktreePath.endsWith(expectedSuffix),
      `worktree path "${outcome.worktreePath}" must end with "${expectedSuffix}"`
    );
    assert.ok(outcome.worktreePath.includes(path.join('.loom', 'integration')));
    assert.ok(
      !outcome.worktreePath.includes(path.join('.loom', 'worktrees')),
      'the dry-run worktree must never live under .loom/worktrees (the janitor reaps those)'
    );

    // The gate saw the live worktree as its projectRoot.
    assert.equal(projectRootSeen, outcome.worktreePath);
    assert.equal(existedDuringRun, true, 'worktree must exist while the gate runs');

    // It was added with --detach: porcelain lists it as detached, with no branch.
    const block = porcelainDuringRun
      .split('\n\n')
      .find((b) => b.includes(`worktree ${outcome.worktreePath}`));
    assert.ok(block, 'the dry-run worktree must appear in `git worktree list`');
    assert.ok(block.includes('detached'), 'the dry-run worktree must be on a detached HEAD');
    assert.ok(!/^branch /m.test(block), 'a detached worktree carries no branch line');
  });

  it('runs the real IntegrationGate with projectRoot = the worktree and returns its outcome verbatim', async () => {
    const cwdMarker = path.join(repo, 'gate-cwd.txt');
    // A configured command always wins; the real default runner spawns it in
    // the worktree, where `pwd` records the cwd the gate actually used.
    const outcome = await runGateDryRun({
      projectRoot: repo,
      testCommand: `pwd > "${cwdMarker}"`,
    });

    assert.equal(outcome.gate.ran, true, 'the real gate executed the configured command');
    assert.equal(outcome.gate.ok, true);
    assert.equal(outcome.gate.command, `pwd > "${cwdMarker}"`);
    assert.equal(outcome.gate.exitCode, 0);

    // `pwd` already emits a realpath; the worktree is gone by now so we compare
    // the recorded string directly (realpathSync on the deleted dir would ENOENT).
    const recordedCwd = fs.readFileSync(cwdMarker, 'utf8').trim();
    assert.equal(
      recordedCwd,
      outcome.worktreePath,
      'the gate command ran with cwd = the throwaway worktree'
    );

    assert.equal(outcome.cleanedUp, true);
    assert.ok(!fs.existsSync(outcome.worktreePath), 'worktree removed after a passing gate');
  });

  it('returns the gate outcome object verbatim (no remapping)', async () => {
    const sentinel = stubOutcome({ ok: false, summary: 'sentinel summary', exitCode: 7 });
    const outcome = await runGateDryRun({ projectRoot: repo }, { gate: { run: async () => sentinel } });
    assert.equal(outcome.gate, sentinel, 'the GateOutcome must be passed through by reference');
  });

  it('removes the worktree in finally on a passing gate (cleanedUp true, directory gone)', async () => {
    const outcome = await runGateDryRun(
      { projectRoot: repo },
      { gate: { run: async () => stubOutcome({ ok: true }) } }
    );
    assert.equal(outcome.cleanedUp, true);
    assert.ok(!fs.existsSync(outcome.worktreePath));
    // No administrative leftovers either.
    assert.ok(!gitc(['worktree', 'list']).includes('gate-dryrun-'));
  });

  it('removes the worktree in finally when the gate times out (unhappy, non-throwing branch)', async () => {
    const outcome = await runGateDryRun(
      { projectRoot: repo },
      { gate: { run: async () => stubOutcome({ ok: false, timedOut: true, summary: 'timed out' }) } }
    );
    assert.equal(outcome.gate.timedOut, true);
    assert.equal(outcome.cleanedUp, true);
    assert.ok(!fs.existsSync(outcome.worktreePath));
  });

  it('removes the worktree in finally even when the gate THROWS, then re-raises', async () => {
    const wtPath = path.join(repo, '.loom', 'integration', `gate-dryrun-${process.pid}`);
    // A real gate whose injected runner throws: gate.run() rejects, exercising
    // the unhappy branch where the worktree must still be reaped.
    const throwingRunner: CommandRunner = () => {
      throw new Error('gate boom');
    };
    const gate = new IntegrationGate({ testCommand: 'anything', runner: throwingRunner });

    await assert.rejects(
      runGateDryRun({ projectRoot: repo, testCommand: 'anything' }, { gate }),
      /gate boom/
    );
    assert.ok(
      !fs.existsSync(wtPath),
      'the worktree must be force-removed even when the gate throws — no leaks'
    );
    assert.ok(!gitc(['worktree', 'list']).includes('gate-dryrun-'));
  });
});
