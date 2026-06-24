import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveLoomHomePath, resolveRepoStatePaths } from '@loom-ai/core';

// __dirname = packages/loom-cli/dist/__tests__
// CLI entry = packages/loom-cli/dist/index.js
const LOOM_CLI = path.resolve(__dirname, '../index.js');

// Each suite gets its own isolated tmpDir so tests do not share state.
// tmpDir/project/ is the target repo; loom-home lives at tmpDir/loom-home
// (the sibling created by resolveLoomHomePath).
// tmpDir/machine-loom is passed as LOOM_HOME to isolate the machine-level
// ProjectRegistry from the developer's real ~/.loom.

function makeSuite(): {
  tmpDir: () => string;
  projectDir: () => string;
  loomHomeDir: () => string;
  loom: (...args: string[]) => { stdout: string; stderr: string; status: number };
  _setup(prefix: string): void;
  _teardown(): void;
} {
  let _tmpDir = '';
  let _projectDir = '';
  let _loomHomeDir = '';

  return {
    tmpDir: () => _tmpDir,
    projectDir: () => _projectDir,
    loomHomeDir: () => _loomHomeDir,
    loom: (...args: string[]) => {
      const machineHome = path.join(_tmpDir, 'machine-loom');
      try {
        const stdout = execFileSync('node', [LOOM_CLI, ...args], {
          cwd: _projectDir,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
          // Isolate machine-level ProjectRegistry from the developer's real ~/.loom
          env: { ...process.env, LOOM_HOME: machineHome },
        });
        return { stdout, stderr: '', status: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
      }
    },
    // Setup/teardown (called by before/after in each describe block)
    _setup(prefix: string): void {
      _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      _projectDir = path.join(_tmpDir, 'project');
      fs.mkdirSync(_projectDir);
      execFileSync('git', ['init', '-q'], { cwd: _projectDir, timeout: 30_000 });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: _projectDir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: _projectDir });
      // Mirror the subprocess LOOM_HOME env so _loomHomeDir agrees with what the
      // CLI resolves. resolveLoomHomePath currently uses the sibling-dir heuristic
      // and ignores LOOM_HOME, so this is equivalent today — but setting it makes
      // the intent explicit and keeps the paths aligned if that ever changes.
      const machineHome = path.join(_tmpDir, 'machine-loom');
      const prev = process.env.LOOM_HOME;
      process.env.LOOM_HOME = machineHome;
      try {
        _loomHomeDir = resolveLoomHomePath(_projectDir, {});
      } finally {
        if (prev !== undefined) process.env.LOOM_HOME = prev;
        else delete process.env.LOOM_HOME;
      }
    },
    _teardown(): void {
      fs.rmSync(_tmpDir, { recursive: true, force: true });
    },
  };
}

// ─── Suite: fresh migration ───────────────────────────────────────────────────

describe('loom migrate — fresh migration', () => {
  const suite = makeSuite();

  before(() => suite._setup('loom-migrate-fresh-'));
  after(() => suite._teardown());

  it('exits 0 in a fresh git repo with no .loom/ directory', () => {
    const result = suite.loom('migrate');
    assert.equal(result.status, 0, `exit 0 expected; stderr: ${result.stderr}`);
  });

  it('creates loom-home as a git repository', () => {
    assert.ok(
      fs.existsSync(suite.loomHomeDir()),
      `loom-home should exist at ${suite.loomHomeDir()}`
    );
    // Verify it is a git repo
    assert.doesNotThrow(() => {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: suite.loomHomeDir(),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }, 'loom-home must be a git repository after migrate');
  });

  it('creates workspace.yaml in loom-home', () => {
    assert.ok(fs.existsSync(path.join(suite.loomHomeDir(), 'workspace.yaml')));
  });

  it('registers the repo in workspace.yaml with correct path', () => {
    const manifest = yaml.load(
      fs.readFileSync(path.join(suite.loomHomeDir(), 'workspace.yaml'), 'utf8')
    ) as { version: number; repos: Array<{ path: string; slug: string }> };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.repos.length, 1, 'manifest must have exactly one entry');
    const realProjectDir = (() => {
      try { return fs.realpathSync(suite.projectDir()); } catch { return suite.projectDir(); }
    })();
    assert.equal(manifest.repos[0].path, realProjectDir);
    assert.ok(manifest.repos[0].slug.length > 0, 'slug must be non-empty');
  });

  it('reports loom-home location and manifest entry in output', () => {
    // Run again (idempotent — will see "already" messages)
    const result = suite.loom('migrate');
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes(suite.loomHomeDir()),
      'output should name the loom-home path'
    );
    assert.ok(
      result.stdout.includes('workspace.yaml') || result.stdout.includes('manifest'),
      'output should mention the manifest'
    );
  });
});

// ─── Suite: state DB migration ────────────────────────────────────────────────

describe('loom migrate — state DB migration', () => {
  const suite = makeSuite();

  before(() => {
    suite._setup('loom-migrate-db-');
    // Create a fake legacy .loom/loom.db so the migration has something to detect.
    // An empty (non-valid) DB file is sufficient: loom migrate must exit 0 and
    // mention 'state db' regardless of the file's contents.
    const loomDir = path.join(suite.projectDir(), '.loom');
    fs.mkdirSync(loomDir, { recursive: true });
    fs.writeFileSync(path.join(loomDir, 'loom.db'), '');
  });

  after(() => suite._teardown());

  it('detects legacy .loom/loom.db and reports migration (or skips if not a valid DB)', () => {
    // A zero-byte file is a valid empty SQLite database; better-sqlite3 opens it
    // successfully and migration moves it to the destination.
    const result = suite.loom('migrate');
    assert.equal(result.status, 0, `exit 0 expected; stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('state db'),
      `output should mention state db; got: ${result.stdout}`
    );
    // The destination DB must exist after migration — not just mentioned in output.
    const dbPaths = resolveRepoStatePaths(suite.projectDir(), {});
    assert.ok(
      fs.existsSync(dbPaths.dbPath),
      `destination DB must exist at ${dbPaths.dbPath} after migration`
    );
  });
});

// ─── Suite: idempotent no-op re-run ──────────────────────────────────────────

describe('loom migrate — idempotent no-op re-run', () => {
  const suite = makeSuite();
  // Captured in before() after the initial migration; used by the commit-count
  // test so that prior it()-block migrate calls do not pollute the snapshot.
  let logBeforeNoop = '';

  before(() => {
    suite._setup('loom-migrate-noop-');
    // Run once to migrate
    const first = suite.loom('migrate');
    assert.equal(first.status, 0, `first run must succeed; stderr: ${first.stderr}`);
    // Snapshot git log immediately after the initial migration, before any
    // subsequent it()-block invocations, so the before/after comparison is clean.
    try {
      logBeforeNoop = execFileSync('git', ['log', '--oneline'], {
        cwd: suite.loomHomeDir(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      logBeforeNoop = ''; // empty repo (no commits yet) — git log exits non-zero
    }
  });

  after(() => suite._teardown());

  it('exits 0 on second run', () => {
    const result = suite.loom('migrate');
    assert.equal(result.status, 0, `second run must exit 0; stderr: ${result.stderr}`);
  });

  it('reports "nothing to do" on second run', () => {
    const result = suite.loom('migrate');
    assert.ok(
      result.stdout.includes('Nothing to do') || result.stdout.includes('already'),
      `second run should report nothing to do; got: ${result.stdout}`
    );
  });

  it('does not change workspace.yaml on second run', () => {
    const manifestPath = path.join(suite.loomHomeDir(), 'workspace.yaml');
    const before = fs.readFileSync(manifestPath, 'utf8');
    suite.loom('migrate');
    const after = fs.readFileSync(manifestPath, 'utf8');
    assert.equal(before, after, 'workspace.yaml must not change on re-run');
  });

  it('does not create a new commit in loom-home on second run', () => {
    // logBeforeNoop was captured in before() right after the initial migration.
    suite.loom('migrate');
    let logAfter = '';
    try {
      logAfter = execFileSync('git', ['log', '--oneline'], {
        cwd: suite.loomHomeDir(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      logAfter = '';
    }
    assert.equal(logBeforeNoop, logAfter, 'loom-home git log must be unchanged on re-run');
  });
});

// ─── Suite: dry-run makes no changes ─────────────────────────────────────────

describe('loom migrate --dry-run', () => {
  const suite = makeSuite();

  before(() => suite._setup('loom-migrate-dryrun-'));
  after(() => suite._teardown());

  it('exits 0', () => {
    const result = suite.loom('migrate', '--dry-run');
    assert.equal(result.status, 0, `exit 0 expected; stderr: ${result.stderr}`);
  });

  it('does not create loom-home on disk', () => {
    suite.loom('migrate', '--dry-run');
    assert.equal(
      fs.existsSync(suite.loomHomeDir()),
      false,
      'loom-home must NOT be created by --dry-run'
    );
  });

  it('does not create workspace.yaml', () => {
    suite.loom('migrate', '--dry-run');
    assert.equal(
      fs.existsSync(path.join(suite.loomHomeDir(), 'workspace.yaml')),
      false,
      'workspace.yaml must NOT be created by --dry-run'
    );
  });

  it('mentions [dry-run] and loom-home path in output', () => {
    const result = suite.loom('migrate', '--dry-run');
    assert.ok(
      result.stdout.includes('dry-run'),
      `output should mention dry-run; got: ${result.stdout}`
    );
    assert.ok(
      result.stdout.includes(suite.loomHomeDir()),
      'output should name the loom-home path'
    );
  });

  it('mentions "no changes made" in output', () => {
    const result = suite.loom('migrate', '--dry-run');
    assert.ok(
      result.stdout.includes('no changes made'),
      `output should mention no changes made; got: ${result.stdout}`
    );
  });
});

// ─── Suite: default leaves committed history untouched ───────────────────────

describe('loom migrate — default leaves committed .loom_outputs untouched', () => {
  const suite = makeSuite();

  let initialCommitSha = '';

  before(() => {
    suite._setup('loom-migrate-noreloc-');
    const projectDir = suite.projectDir();

    // Commit some .loom_outputs artifacts to the repo
    const outputsDir = path.join(projectDir, '.loom_outputs', 'epic-001');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'brief.md'), '# Brief\n');
    execSync('git add .loom_outputs', { cwd: projectDir });
    execSync('git commit -m "add artifacts"', { cwd: projectDir });

    initialCommitSha = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
  });

  after(() => suite._teardown());

  it('exits 0 without --relocate-committed-artifacts', () => {
    const result = suite.loom('migrate');
    assert.equal(result.status, 0, `exit 0 expected; stderr: ${result.stderr}`);
  });

  it('does not remove .loom_outputs from the working tree', () => {
    suite.loom('migrate');
    assert.ok(
      fs.existsSync(path.join(suite.projectDir(), '.loom_outputs', 'epic-001', 'brief.md')),
      '.loom_outputs must remain intact without --relocate-committed-artifacts'
    );
  });

  it('does not create a new git commit in the target repo', () => {
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();

    suite.loom('migrate');

    const headAfter = execSync('git rev-parse HEAD', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();

    assert.equal(headBefore, headAfter, 'HEAD must not change without --relocate-committed-artifacts');
    assert.equal(headAfter, initialCommitSha, 'must be the same commit as before migrate');
  });
});

// ─── Suite: --relocate-committed-artifacts creates single forward commit ─────

describe('loom migrate --relocate-committed-artifacts', () => {
  const suite = makeSuite();

  let shaBeforeReloc = '';
  let shaAfterReloc = '';
  let priorCommitShas: string[] = [];
  // Captured in before() so tests can assert on the first (real) relocation run's output.
  let relocFirstRunStdout = '';

  before(() => {
    suite._setup('loom-migrate-reloc-');
    const projectDir = suite.projectDir();

    // Make an initial commit so HEAD exists
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Repo\n');
    execSync('git add README.md', { cwd: projectDir });
    execSync('git commit -m "initial commit"', { cwd: projectDir });

    // Commit some .loom_outputs artifacts
    const outputsDir = path.join(projectDir, '.loom_outputs', 'epic-001');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'brief.md'), '# Brief content\n');
    fs.writeFileSync(path.join(outputsDir, 'prd.md'), '# PRD content\n');
    execSync('git add .loom_outputs', { cwd: projectDir });
    execSync('git commit -m "add loom_outputs artifacts"', { cwd: projectDir });

    // Record prior history before relocation
    priorCommitShas = execSync('git log --format=%H', {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);

    shaBeforeReloc = priorCommitShas[0];

    // Run migration with relocation and capture output for assertions below.
    const result = suite.loom('migrate', '--relocate-committed-artifacts');
    if (result.status !== 0) {
      throw new Error('setup: loom migrate --relocate-committed-artifacts failed: ' + result.stderr);
    }
    relocFirstRunStdout = result.stdout;

    shaAfterReloc = execSync('git rev-parse HEAD', {
      cwd: projectDir,
      encoding: 'utf8',
    }).trim();
  });

  after(() => suite._teardown());

  it('creates exactly one new forward commit', () => {
    // After relocation, there must be exactly one more commit than before
    const logAfter = execSync('git log --format=%H', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);

    assert.equal(
      logAfter.length,
      priorCommitShas.length + 1,
      'exactly one new commit must be created'
    );
  });

  it('all prior commits remain unchanged (no history rewrite)', () => {
    const logAfter = execSync('git log --format=%H', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);

    // The new HEAD is at index 0; prior commits follow
    const priorCommitsInLog = logAfter.slice(1);
    for (let i = 0; i < priorCommitShas.length; i++) {
      assert.equal(
        priorCommitsInLog[i],
        priorCommitShas[i],
        `prior commit ${i} must be unchanged (SHA must match)`
      );
    }
  });

  it('HEAD advances beyond the prior HEAD (forward commit, not a rebase)', () => {
    assert.notEqual(shaAfterReloc, shaBeforeReloc, 'HEAD must advance after relocation');
    // The new commit must have the prior HEAD as its parent
    const parent = execSync('git rev-parse HEAD^', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();
    assert.equal(parent, shaBeforeReloc, 'new commit parent must be the prior HEAD');
  });

  it('removes .loom_outputs from the working tree', () => {
    assert.equal(
      fs.existsSync(path.join(suite.projectDir(), '.loom_outputs')),
      false,
      '.loom_outputs must be removed from working tree after relocation'
    );
  });

  it('.loom_outputs is no longer tracked by git', () => {
    const tracked = execSync('git ls-files .loom_outputs', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();
    assert.equal(tracked, '', '.loom_outputs must not be git-tracked after relocation');
  });

  it('artifacts are copied to loom-home namespace', () => {
    // loom-home/repos/<slug>/loom_outputs/ must exist and contain the artifacts
    const entries = fs.readdirSync(path.join(suite.loomHomeDir(), 'repos'));
    assert.ok(entries.length > 0, 'loom-home/repos must have at least one namespace');
    const slug = entries[0];
    const loomOutputsDst = path.join(suite.loomHomeDir(), 'repos', slug, 'loom_outputs');
    assert.ok(fs.existsSync(loomOutputsDst), `loom_outputs must exist at ${loomOutputsDst}`);
    assert.ok(
      fs.existsSync(path.join(loomOutputsDst, 'epic-001', 'brief.md')),
      'brief.md must be copied to loom-home'
    );
  });

  it('first run output reports the relocation of artifacts', () => {
    // relocFirstRunStdout was captured in before() during the actual relocation run.
    assert.ok(
      relocFirstRunStdout.includes('relocated'),
      `first run output should mention 'relocated'; got: ${relocFirstRunStdout}`
    );
  });

  it('second run with --relocate-committed-artifacts reports no artifacts (idempotent)', () => {
    const resultAgain = suite.loom('migrate', '--relocate-committed-artifacts');
    assert.equal(resultAgain.status, 0);
    assert.ok(
      resultAgain.stdout.includes('no committed .loom_outputs') ||
      resultAgain.stdout.includes('nothing'),
      `second run should report no artifacts to relocate; got: ${resultAgain.stdout}`
    );
  });
});

// ─── Suite: dirty working tree refusal ───────────────────────────────────────

describe('loom migrate --relocate-committed-artifacts — dirty working tree refusal', () => {
  const suite = makeSuite();

  before(() => {
    suite._setup('loom-migrate-dirty-');
    const projectDir = suite.projectDir();

    // Commit an initial file so we have a HEAD
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Repo\n');
    execSync('git add README.md', { cwd: projectDir });
    execSync('git commit -m "initial"', { cwd: projectDir });

    // Commit .loom_outputs so there's something to relocate
    const outputsDir = path.join(projectDir, '.loom_outputs', 'epic-001');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'brief.md'), '# Brief\n');
    execSync('git add .loom_outputs', { cwd: projectDir });
    execSync('git commit -m "add artifacts"', { cwd: projectDir });

    // Dirty the working tree: modify a tracked file (creates unstaged changes)
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Modified\n');
  });

  after(() => suite._teardown());

  it('refuses with a non-zero exit code when working tree is dirty', () => {
    const result = suite.loom('migrate', '--relocate-committed-artifacts');
    assert.notEqual(result.status, 0, 'must exit non-zero when working tree is dirty');
  });

  it('emits an explicit precondition failure message mentioning dirty working tree', () => {
    const result = suite.loom('migrate', '--relocate-committed-artifacts');
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('working tree') || combined.includes('uncommitted'),
      `error message must mention dirty working tree; got stdout: ${result.stdout} stderr: ${result.stderr}`
    );
  });

  it('does not modify git history on refusal', () => {
    const headBefore = execSync('git rev-parse HEAD', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();

    suite.loom('migrate', '--relocate-committed-artifacts');

    const headAfter = execSync('git rev-parse HEAD', {
      cwd: suite.projectDir(),
      encoding: 'utf8',
    }).trim();

    assert.equal(headBefore, headAfter, 'HEAD must not change when refusing due to dirty tree');
  });

  it('does not remove .loom_outputs from working tree on refusal', () => {
    suite.loom('migrate', '--relocate-committed-artifacts');
    assert.ok(
      fs.existsSync(path.join(suite.projectDir(), '.loom_outputs', 'epic-001', 'brief.md')),
      '.loom_outputs must remain intact after refusal'
    );
  });
});

// ─── Suite: dry-run with relocate flag ───────────────────────────────────────

describe('loom migrate --dry-run --relocate-committed-artifacts', () => {
  const suite = makeSuite();

  before(() => {
    suite._setup('loom-migrate-dryrun-reloc-');
    const projectDir = suite.projectDir();

    // Create and commit .loom_outputs
    const outputsDir = path.join(projectDir, '.loom_outputs', 'epic-001');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'brief.md'), '# Brief\n');
    execSync('git add .loom_outputs', { cwd: projectDir });
    execSync('git commit -m "add artifacts"', { cwd: projectDir });
  });

  after(() => suite._teardown());

  it('exits 0', () => {
    const result = suite.loom('migrate', '--dry-run', '--relocate-committed-artifacts');
    assert.equal(result.status, 0);
  });

  it('does not remove .loom_outputs', () => {
    suite.loom('migrate', '--dry-run', '--relocate-committed-artifacts');
    assert.ok(
      fs.existsSync(path.join(suite.projectDir(), '.loom_outputs')),
      '.loom_outputs must not be removed by --dry-run'
    );
  });

  it('does not create loom-home', () => {
    suite.loom('migrate', '--dry-run', '--relocate-committed-artifacts');
    assert.equal(fs.existsSync(suite.loomHomeDir()), false);
  });

  it('mentions artifact relocation in output', () => {
    const result = suite.loom('migrate', '--dry-run', '--relocate-committed-artifacts');
    assert.ok(
      result.stdout.includes('artifacts') || result.stdout.includes('.loom_outputs'),
      `output should mention artifacts; got: ${result.stdout}`
    );
  });
});
