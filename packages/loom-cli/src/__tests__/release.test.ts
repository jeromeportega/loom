/**
 * Tests for `loom release <version>` — story-006-001.
 *
 * All external calls (bump script, git, gh) are injected via test seams so
 * no real git repo, remote, or script execution is required.
 *
 * Test plan:
 *   [AC1] Reuses bump script: shells out to bump-versions.mjs <version>
 *   [AC2/AC3] Branch + PR shape: creates release/v<version>, commits, pushes,
 *             opens PR with --head release/v<version> --base main
 *   [AC2/AC3] Never pushes main: no push refspec is "main"
 *   [AC4] Guard-clean: all captured git invocations pass PolicyEngine.check()
 *         and no --force / --force-with-lease flag appears
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PolicyEngine } from '@loom-ai/core';
import { runRelease, type ReleaseCommandOptions } from '../commands/release.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;
let prevCwd: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-release-test-'));
  prevCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Capture helpers ──────────────────────────────────────────────────────────

interface Captured {
  logs: string[];
  errors: string[];
  exitCode: number | null;
}

async function capture(fn: () => void | Promise<void>): Promise<Captured> {
  const origExit = process.exit as (code?: number) => never;
  const origLog = console.log;
  const origErr = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | null = null;

  (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));

  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit'))) throw e;
  } finally {
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }

  return { logs, errors, exitCode };
}

/** Builds seams that record all invocations and always succeed. */
function makeSeams(version: string) {
  const bumpCalls: Array<{ version: string; cwd: string }> = [];
  const gitCalls: Array<{ cwd: string; args: string[] }> = [];
  const ghCalls: Array<{ args: string[]; cwd: string }> = [];

  const ver = version.startsWith('v') ? version.slice(1) : version;
  const branch = `release/v${ver}`;

  const opts: ReleaseCommandOptions = {
    _runBump: (v: string, cwd: string) => { bumpCalls.push({ version: v, cwd }); },
    _git: (cwd: string, args: string[]) => {
      gitCalls.push({ cwd, args });
      return { ok: true, output: '' };
    },
    _gh: (args: string[], cwd: string) => {
      ghCalls.push({ args, cwd });
      return `https://github.com/org/repo/pull/1`;
    },
  };

  return {
    bumpCalls,
    gitCalls,
    ghCalls,
    // branch exposed so tests can reference it without recomputing
    branch,
    opts,
  };
}

// ─── [AC1] Bump script invocation ────────────────────────────────────────────

describe('runRelease — bump script invocation [AC1]', () => {
  it('calls _runBump with the normalized version (no leading v)', async () => {
    const { bumpCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    assert.equal(bumpCalls.length, 1, 'bump called exactly once');
    assert.equal(bumpCalls[0].version, '1.2.3');
  });

  it('strips leading v before passing to bump script', async () => {
    const { bumpCalls, opts } = makeSeams('v2.0.0');
    await capture(() => runRelease('v2.0.0', opts));
    assert.equal(bumpCalls[0].version, '2.0.0', 'leading v stripped');
  });

  it('exits 1 when bump script throws', async () => {
    const { opts } = makeSeams('1.2.3');
    opts._runBump = () => { throw new Error('semver invalid'); };
    const { exitCode, errors } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /bump-versions/i.test(e)), 'error mentions bump-versions');
  });
});

// ─── Semver validation ────────────────────────────────────────────────────────

describe('runRelease — semver validation', () => {
  it('exits 1 for non-semver input, does not call bump', async () => {
    let bumpCalled = false;
    const { opts } = makeSeams('1.2.3');
    opts._runBump = () => { bumpCalled = true; };
    const { exitCode, errors } = await capture(() => runRelease('latest', opts));
    assert.equal(exitCode, 1);
    assert.equal(bumpCalled, false, 'bump must not be called with invalid semver');
    assert.ok(errors.some((e) => /semver/i.test(e)), 'error mentions semver');
  });

  it('exits 1 for empty string', async () => {
    const { opts } = makeSeams('1.2.3');
    const { exitCode } = await capture(() => runRelease('', opts));
    assert.equal(exitCode, 1);
  });

  it('accepts pre-release semver (e.g. 1.2.3-alpha.1)', async () => {
    const { bumpCalls, opts } = makeSeams('1.2.3-alpha.1');
    await capture(() => runRelease('1.2.3-alpha.1', opts));
    assert.equal(bumpCalls[0].version, '1.2.3-alpha.1');
  });

  it('accepts pre-release with hyphen (e.g. 1.2.3-alpha-1)', async () => {
    const { bumpCalls, opts } = makeSeams('1.2.3-alpha-1');
    await capture(() => runRelease('1.2.3-alpha-1', opts));
    assert.equal(bumpCalls[0].version, '1.2.3-alpha-1');
  });

  it('rejects pre-release with underscore (e.g. 1.2.3-rc_1)', async () => {
    let bumpCalled = false;
    const { opts } = makeSeams('1.2.3');
    opts._runBump = () => { bumpCalled = true; };
    const { exitCode, errors } = await capture(() => runRelease('1.2.3-rc_1', opts));
    assert.equal(exitCode, 1);
    assert.equal(bumpCalled, false, 'bump must not be called with underscore pre-release');
    assert.ok(errors.some((e) => /semver/i.test(e)), 'error mentions semver');
  });
});

// ─── [AC2/AC3] Branch + PR shape ─────────────────────────────────────────────

describe('runRelease — branch and PR shape [AC2, AC3]', () => {
  it('creates branch release/v<version>', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    const checkout = gitCalls.find(
      (c) => c.args[0] === 'checkout' && c.args.includes('-b')
    );
    assert.ok(checkout, 'git checkout -b called');
    assert.ok(
      checkout.args.includes('release/v1.2.3'),
      `expected release/v1.2.3 in args, got: ${checkout.args.join(' ')}`
    );
  });

  it('stages version-bump files with git add before committing', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    const add = gitCalls.find((c) => c.args[0] === 'add');
    assert.ok(add, 'git add called');
    assert.ok(add.args.includes('--'), '-- separator present');
    assert.ok(add.args.includes('package.json'), 'root package.json staged');
    assert.ok(
      add.args.includes('packages/*/package.json'),
      'workspace package.json glob staged'
    );
    // git add must precede git commit
    const addIdx = gitCalls.findIndex((c) => c.args[0] === 'add');
    const commitIdx = gitCalls.findIndex((c) => c.args[0] === 'commit');
    assert.ok(addIdx < commitIdx, 'git add comes before git commit');
  });

  it('commits with message "chore(release): v<version>" using -m (not -am)', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    const commit = gitCalls.find((c) => c.args[0] === 'commit');
    assert.ok(commit, 'git commit called');
    assert.ok(
      commit.args.includes('chore(release): v1.2.3'),
      `commit message not found, args: ${commit.args.join(' ')}`
    );
    assert.ok(!commit.args.includes('-am'), 'must not use -am (stages only explicit files)');
    assert.ok(!commit.args.includes('-a'), 'must not use -a flag');
  });

  it('pushes release/v<version> with -u origin', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    const push = gitCalls.find((c) => c.args[0] === 'push');
    assert.ok(push, 'git push called');
    assert.ok(push.args.includes('-u'), '-u flag present');
    assert.ok(push.args.includes('origin'), 'remote is origin');
    assert.ok(
      push.args.includes('release/v1.2.3'),
      `push target not release/v1.2.3, args: ${push.args.join(' ')}`
    );
  });

  it('opens PR with --head release/v<version> --base main --title --body', async () => {
    const { ghCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    assert.equal(ghCalls.length, 1, 'gh called exactly once');
    const args = ghCalls[0].args;
    assert.ok(args.includes('pr'), 'gh pr subcommand');
    assert.ok(args.includes('create'), 'gh pr create');
    assert.ok(args.includes('--head'), '--head flag present');
    assert.ok(args.includes('release/v1.2.3'), '--head value is release/v1.2.3');
    assert.ok(args.includes('--base'), '--base flag present');
    assert.ok(args.includes('main'), '--base main');
    const titleIdx = args.indexOf('--title');
    assert.ok(titleIdx >= 0, '--title flag present');
    assert.equal(args[titleIdx + 1], 'chore(release): v1.2.3', '--title value correct');
    assert.ok(args.includes('--body'), '--body flag present');
  });

  it('prints the PR URL in output', async () => {
    const { opts } = makeSeams('1.2.3');
    const { logs } = await capture(() => runRelease('1.2.3', opts));
    assert.ok(logs.some((l) => l.includes('https://github.com/org/repo/pull/1')), 'PR URL printed');
  });

  it('exits 0 (no process.exit) on success', async () => {
    const { opts } = makeSeams('1.2.3');
    const { exitCode } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, null, 'no process.exit on success');
  });

  it('exits 1 when git checkout fails', async () => {
    const { opts } = makeSeams('1.2.3');
    let checkoutCalled = false;
    opts._git = (cwd, args) => {
      if (args[0] === 'checkout') {
        checkoutCalled = true;
        return { ok: false, output: 'branch already exists' };
      }
      return { ok: true, output: '' };
    };
    const { exitCode } = await capture(() => runRelease('1.2.3', opts));
    assert.ok(checkoutCalled, 'checkout was attempted');
    assert.equal(exitCode, 1);
  });

  it('exits 1 when git add fails', async () => {
    const { opts } = makeSeams('1.2.3');
    opts._git = (cwd, args) => {
      if (args[0] === 'add') return { ok: false, output: 'git add error' };
      return { ok: true, output: '' };
    };
    const { exitCode, errors } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /stage/i.test(e)), 'error mentions staging');
  });

  it('exits 1 when git commit fails (e.g. nothing to commit)', async () => {
    const { opts } = makeSeams('1.2.3');
    opts._git = (cwd, args) => {
      if (args[0] === 'commit') return { ok: false, output: 'nothing to commit' };
      return { ok: true, output: '' };
    };
    const { exitCode, errors } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /commit/i.test(e)), 'error mentions commit');
  });

  it('exits 1 when git push fails', async () => {
    const { opts } = makeSeams('1.2.3');
    opts._git = (cwd, args) => {
      if (args[0] === 'push') return { ok: false, output: 'no remote' };
      return { ok: true, output: '' };
    };
    const { exitCode } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, 1);
  });

  it('exits 1 when gh returns undefined (PR creation fails)', async () => {
    const { opts } = makeSeams('1.2.3');
    opts._gh = () => undefined;
    const { exitCode, errors } = await capture(() => runRelease('1.2.3', opts));
    assert.equal(exitCode, 1);
    assert.ok(errors.some((e) => /pr/i.test(e)), 'error mentions PR');
  });
});

// ─── [AC2/AC3] Never pushes main ──────────────────────────────────────────────

describe('runRelease — never pushes main [AC2, AC3]', () => {
  it('no push refspec is "main"', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));
    const pushes = gitCalls.filter((c) => c.args[0] === 'push');
    for (const push of pushes) {
      assert.ok(
        !push.args.includes('main'),
        `push command must not include "main", got: ${push.args.join(' ')}`
      );
      // Also check refspec form src:dest
      for (const arg of push.args) {
        if (arg.includes(':')) {
          const dest = arg.split(':')[1];
          assert.notEqual(dest, 'main', `push refspec dest must not be "main", got: ${arg}`);
        }
      }
    }
  });

  it('only one push is made, targeting release/v<version>', async () => {
    const { gitCalls, opts } = makeSeams('3.0.1');
    await capture(() => runRelease('3.0.1', opts));
    const pushes = gitCalls.filter((c) => c.args[0] === 'push');
    assert.equal(pushes.length, 1, 'exactly one git push');
    assert.ok(pushes[0].args.includes('release/v3.0.1'), 'push targets release/v3.0.1');
  });
});

// ─── [AC4] Guard-clean ────────────────────────────────────────────────────────

describe('runRelease — guard-clean [AC4]', () => {
  const engine = new PolicyEngine(PolicyEngine.defaultPolicy());

  it('all git invocations pass PolicyEngine.check()', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));

    for (const { args } of gitCalls) {
      // Reconstruct the command string PolicyEngine would evaluate.
      // Quote args that contain spaces or special chars.
      const parts = ['git', ...args].map((a) => (a.includes(' ') ? `"${a}"` : a));
      const raw = parts.join(' ');
      const result = engine.check(raw);
      assert.ok(
        result.allowed,
        `git ${args.join(' ')} was blocked by PolicyEngine: ${result.reason ?? 'no reason'}`
      );
    }
  });

  it('no git invocation contains --force or --force-with-lease', async () => {
    const { gitCalls, opts } = makeSeams('1.2.3');
    await capture(() => runRelease('1.2.3', opts));

    const forbidden = ['--force', '--force-with-lease'];
    for (const { args } of gitCalls) {
      for (const flag of forbidden) {
        assert.ok(
          !args.includes(flag),
          `git ${args.join(' ')} must not include ${flag}`
        );
        // Also check --force=value forms
        assert.ok(
          !args.some((a) => a.startsWith(`${flag}=`)),
          `git ${args.join(' ')} must not include ${flag}=...`
        );
      }
    }
  });

  it('release/v* push passes PolicyEngine (not a protected branch)', () => {
    const raw = 'git push -u origin release/v1.2.3';
    const result = engine.check(raw);
    assert.ok(result.allowed, `"${raw}" should be allowed by PolicyEngine`);
  });

  it('direct push to main is blocked by PolicyEngine (regression guard)', () => {
    const raw = 'git push origin main';
    const result = engine.check(raw);
    assert.equal(result.allowed, false, 'push to main must be blocked');
    assert.equal(result.rule, 'git.protected_branches');
  });

  it('push --force is blocked by PolicyEngine (regression guard)', () => {
    const raw = 'git push --force origin release/v1.2.3';
    const result = engine.check(raw);
    assert.equal(result.allowed, false, '--force must be blocked');
    assert.equal(result.rule, 'git.forbidden_flags');
  });

  it('push --force-with-lease is blocked by PolicyEngine (regression guard)', () => {
    const raw = 'git push --force-with-lease origin release/v1.2.3';
    const result = engine.check(raw);
    assert.equal(result.allowed, false, '--force-with-lease must be blocked');
    assert.equal(result.rule, 'git.forbidden_flags');
  });
});
