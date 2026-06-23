import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureLoomHome } from '../../src/home/ensureLoomHome.js';
import { isGitRepo, gitSafe } from '../../src/orchestrator/git.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ensure-'));
}

function gitInit(dir: string): void {
  const res = gitSafe(dir, ['init']);
  if (!res.ok) throw new Error(`git init failed: ${res.output}`);
}

function gitCommit(dir: string): void {
  gitSafe(dir, ['config', 'user.email', 'test@loom.test']);
  gitSafe(dir, ['config', 'user.name', 'Loom Test']);
  const sentinel = path.join(dir, 'README.md');
  fs.writeFileSync(sentinel, '# test\n', 'utf8');
  gitSafe(dir, ['add', 'README.md']);
  gitSafe(dir, ['commit', '-m', 'initial']);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ensureLoomHome — case 1: absent directory', () => {
  let tmp: string;
  let target: string;
  let result: ReturnType<typeof ensureLoomHome>;

  before(() => {
    tmp = makeTmp();
    target = path.join(tmp, 'loom-home');
    result = ensureLoomHome(target);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns created:true, initialized:true, reused:false', () => {
    assert.equal(result.created, true);
    assert.equal(result.initialized, true);
    assert.equal(result.reused, false);
  });

  it('returns the correct path', () => {
    assert.equal(result.path, target);
  });

  it('creates a valid git repository', () => {
    assert.ok(isGitRepo(target), 'target must be a git repo after creation');
  });

  it('writes a .gitignore', () => {
    assert.ok(fs.existsSync(path.join(target, '.gitignore')));
  });
});

describe('ensureLoomHome — case 2: existing git repository with commits', () => {
  let tmp: string;
  let target: string;
  let headBefore: string;
  let result: ReturnType<typeof ensureLoomHome>;

  before(() => {
    tmp = makeTmp();
    target = path.join(tmp, 'loom-home');
    fs.mkdirSync(target);
    gitInit(target);
    gitCommit(target);
    headBefore = gitSafe(target, ['rev-parse', 'HEAD']).output;
    result = ensureLoomHome(target);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns reused:true, created:false, initialized:false', () => {
    assert.equal(result.reused, true);
    assert.equal(result.created, false);
    assert.equal(result.initialized, false);
  });

  it('preserves existing HEAD commit (no re-init clobber)', () => {
    const headAfter = gitSafe(target, ['rev-parse', 'HEAD']).output;
    assert.equal(headAfter, headBefore, 'HEAD must not change when reusing an existing repo');
  });
});

describe('ensureLoomHome — case 3: existing non-git directory', () => {
  let tmp: string;
  let target: string;
  let result: ReturnType<typeof ensureLoomHome>;

  before(() => {
    tmp = makeTmp();
    target = path.join(tmp, 'loom-home');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel.txt'), 'do not touch\n', 'utf8');
    result = ensureLoomHome(target);
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns created:false, initialized:true', () => {
    assert.equal(result.created, false);
    assert.equal(result.initialized, true);
  });

  it('leaves the sentinel file intact (init-in-place, non-destructive)', () => {
    const content = fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8');
    assert.equal(content, 'do not touch\n');
  });

  it('result is now a git repository', () => {
    assert.ok(isGitRepo(target));
  });

  it('writes a .gitignore', () => {
    assert.ok(fs.existsSync(path.join(target, '.gitignore')));
  });
});

describe('ensureLoomHome — case 4: idempotency', () => {
  let tmp: string;
  let target: string;

  before(() => {
    tmp = makeTmp();
    target = path.join(tmp, 'loom-home');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('second call returns reused:true and does not re-init', () => {
    ensureLoomHome(target); // first call
    const r2 = ensureLoomHome(target); // second call
    assert.equal(r2.reused, true);
    assert.equal(r2.initialized, false);
    assert.equal(r2.created, false);
  });
});

describe('ensureLoomHome — guard: path inside an existing git repo (projectRoot)', () => {
  let tmp: string;
  let projectRoot: string;
  let nestedTarget: string;

  before(() => {
    tmp = makeTmp();
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(projectRoot);
    gitInit(projectRoot);
    gitCommit(projectRoot); // ensure HEAD exists — some git versions need a commit for rev-parse --show-toplevel
    nestedTarget = path.join(projectRoot, 'loom-home');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('throws a clear error', () => {
    assert.throws(
      () => ensureLoomHome(nestedTarget),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('inside an existing git repository'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('does not create the target directory', () => {
    assert.ok(
      !fs.existsSync(nestedTarget),
      'ensureLoomHome must not create the target directory when the guard fires',
    );
  });
});

describe('ensureLoomHome — guard: path inside a .git directory', () => {
  let tmp: string;
  let projectRoot: string;
  let gitDirTarget: string;

  before(() => {
    tmp = makeTmp();
    projectRoot = path.join(tmp, 'project');
    fs.mkdirSync(projectRoot);
    gitInit(projectRoot);
    gitDirTarget = path.join(projectRoot, '.git', 'loom-home');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('throws a clear error mentioning .git directory', () => {
    assert.throws(
      () => ensureLoomHome(gitDirTarget),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('.git'),
          `expected error to mention .git, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('does not create the nested directory', () => {
    assert.ok(!fs.existsSync(gitDirTarget));
  });
});
