import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkWorkspaceDeps } from '../orchestrator/linkWorkspaceDeps.js';
import { IntegrationBranch } from '../orchestrator/IntegrationBranch.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Temp dir with the expected packages layout. */
function makeWorktreeDir(): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ldep-')));
  fs.mkdirSync(path.join(tmp, 'packages', 'loom-core'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'packages', 'loom-web'), { recursive: true });
  return tmp;
}

function scopeDir(root: string): string {
  return path.join(root, 'node_modules', '@loom-ai');
}

function coreLinkPath(root: string): string {
  return path.join(scopeDir(root), 'core');
}

function webLinkPath(root: string): string {
  return path.join(scopeDir(root), 'web');
}

// ─── Unit: linkWorkspaceDeps helper ──────────────────────────────────────────

describe('linkWorkspaceDeps — unit (filesystem behaviour)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeWorktreeDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('happy path: creates @loom-ai/core and @loom-ai/web as symlinks in node_modules', () => {
    linkWorkspaceDeps(tmp);

    for (const [link, pkg] of [[coreLinkPath(tmp), 'loom-core'], [webLinkPath(tmp), 'loom-web']] as const) {
      assert.ok(fs.existsSync(link), `${path.basename(link)} link must exist`);
      const st = fs.lstatSync(link);
      assert.ok(st.isSymbolicLink(), `${path.basename(link)} must be a symlink`);
      // Must resolve to this worktree's own packages dir, not any parent checkout.
      const resolved = fs.realpathSync(link);
      assert.equal(
        resolved,
        path.join(tmp, 'packages', pkg),
        `${path.basename(link)} must resolve to the worktree's own ${pkg}`
      );
    }
  });

  it('resolution proof: links resolve inside the worktree, not to a parent checkout', () => {
    linkWorkspaceDeps(tmp);

    const coreResolved = fs.realpathSync(coreLinkPath(tmp));
    const webResolved = fs.realpathSync(webLinkPath(tmp));

    // Any path outside the worktree root would indicate stale parent-checkout resolution.
    assert.ok(
      coreResolved.startsWith(tmp + path.sep) || coreResolved === tmp,
      `core must resolve inside the worktree (got ${coreResolved})`
    );
    assert.ok(
      webResolved.startsWith(tmp + path.sep) || webResolved === tmp,
      `web must resolve inside the worktree (got ${webResolved})`
    );
    // Exact targets confirm they hit the worktree's own freshly built packages.
    assert.equal(coreResolved, path.join(tmp, 'packages', 'loom-core'));
    assert.equal(webResolved, path.join(tmp, 'packages', 'loom-web'));
  });

  it('idempotent: re-running when correct links exist does not throw and leaves them correct', () => {
    linkWorkspaceDeps(tmp);
    assert.doesNotThrow(() => linkWorkspaceDeps(tmp));

    assert.equal(fs.realpathSync(coreLinkPath(tmp)), path.join(tmp, 'packages', 'loom-core'));
    assert.equal(fs.realpathSync(webLinkPath(tmp)), path.join(tmp, 'packages', 'loom-web'));
  });

  it('idempotent: replaces a stale symlink (wrong target) without throwing', () => {
    fs.mkdirSync(scopeDir(tmp), { recursive: true });
    // Stale link pointing at an unrelated path.
    fs.symlinkSync('/tmp/stale', coreLinkPath(tmp));

    assert.doesNotThrow(() => linkWorkspaceDeps(tmp));

    const link = coreLinkPath(tmp);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'must be a symlink after replacement');
    assert.equal(fs.realpathSync(link), path.join(tmp, 'packages', 'loom-core'));
  });

  it('idempotent: replaces a real directory at the link path without throwing', () => {
    // A previous npm install may have left a real dir instead of a symlink.
    const linkP = webLinkPath(tmp);
    fs.mkdirSync(linkP, { recursive: true });
    fs.writeFileSync(path.join(linkP, 'stale.js'), '// stale\n');

    assert.doesNotThrow(() => linkWorkspaceDeps(tmp));

    assert.ok(fs.lstatSync(webLinkPath(tmp)).isSymbolicLink(), 'must be a symlink after replacement');
    assert.equal(fs.realpathSync(webLinkPath(tmp)), path.join(tmp, 'packages', 'loom-web'));
  });

  it('boundary: creates node_modules and @loom-ai scope dir when absent (no prior state)', () => {
    // Fresh empty worktree root — no node_modules at all.
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ldep-fresh-')));
    fs.mkdirSync(path.join(fresh, 'packages', 'loom-core'), { recursive: true });
    fs.mkdirSync(path.join(fresh, 'packages', 'loom-web'), { recursive: true });
    try {
      assert.doesNotThrow(() => linkWorkspaceDeps(fresh));
      assert.ok(fs.existsSync(coreLinkPath(fresh)), 'core link must exist without prior node_modules');
      assert.ok(fs.existsSync(webLinkPath(fresh)), 'web link must exist without prior @loom-ai scope');
      // Both must be symlinks, not directories.
      assert.ok(fs.lstatSync(coreLinkPath(fresh)).isSymbolicLink());
      assert.ok(fs.lstatSync(webLinkPath(fresh)).isSymbolicLink());
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

// ─── Integration: wiring into IntegrationBranch.ensure ───────────────────────

describe('IntegrationBranch.ensure() — linkWorkspaceDeps wiring', () => {
  let repo: string;
  let base: string;

  function gitc(args: string[], cwd = repo): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ib-link-')));
    gitc(['init', '-q']);
    gitc(['config', 'user.email', 'test@loom.dev']);
    gitc(['config', 'user.name', 'Loom Test']);
    gitc(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
    gitc(['add', '.']);
    gitc(['commit', '-q', '-m', 'initial']);
    base = gitc(['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('invokes linkWorkspaceDeps with the worktree path on a fresh ensure()', () => {
    const calls: string[] = [];
    const ib = new IntegrationBranch(repo, {
      linkDeps: (wtRoot) => { calls.push(wtRoot); },
    });

    const info = ib.ensure('epic-001', base);

    assert.equal(calls.length, 1, 'linkWorkspaceDeps must be called exactly once');
    assert.equal(calls[0], info.path, 'linkWorkspaceDeps must receive the integration worktree path');
  });

  it('invokes linkWorkspaceDeps again on each ensure() call (idempotent gate re-run)', () => {
    const calls: string[] = [];
    const ib = new IntegrationBranch(repo, {
      linkDeps: (wtRoot) => { calls.push(wtRoot); },
    });

    const info1 = ib.ensure('epic-001', base);
    assert.equal(calls.length, 1);

    // Second ensure() — worktree already exists (resume scenario).
    const info2 = ib.ensure('epic-001', base);
    assert.equal(calls.length, 2, 'linkWorkspaceDeps must be called on each ensure()');
    assert.equal(calls[1], info2.path);
    assert.equal(info1.path, info2.path, 'same worktree path on resume');
  });

  it('linkWorkspaceDeps is called before ensure() returns (preflight ordering)', () => {
    // Verify call order: linkDeps fires inside ensure(), before the returned info
    // is usable — any gate/build starting after ensure() returns will see the links.
    let calledBeforeReturn = false;
    const ib = new IntegrationBranch(repo, {
      linkDeps: () => { calledBeforeReturn = true; },
    });

    ib.ensure('epic-001', base);

    assert.equal(calledBeforeReturn, true, 'linkWorkspaceDeps must have been called before ensure() returned');
  });

  it('does not alter build order: ensure() still returns a valid IntegrationBranchInfo', () => {
    // Smoke-test: adding the preflight must not break the ensure() return value.
    const ib = new IntegrationBranch(repo, { linkDeps: () => { /* no-op spy */ } });
    const info = ib.ensure('epic-001', base);

    assert.equal(info.branch, 'epic/epic-001');
    assert.equal(info.tip, base);
    assert.ok(fs.existsSync(info.path), 'worktree must exist');
  });
});
