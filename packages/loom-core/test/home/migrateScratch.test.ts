import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migratePlanningScratch } from '../../src/home/migrateScratch.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migrate-scratch-'));
}

function gitInit(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
}

function gitAdd(dir: string, file: string): void {
  execFileSync('git', ['add', file], { cwd: dir, stdio: 'pipe' });
}

function gitCommit(dir: string, msg: string): void {
  execFileSync('git', ['commit', '--allow-empty', '-m', msg], { cwd: dir, stdio: 'pipe' });
}

/** Seed a realistic planning run subtree under srcRoot/<runId>/. */
function seedScratch(srcRoot: string, runId: string): void {
  const runDir = path.join(srcRoot, runId);
  const epicsDir = path.join(runDir, 'epics');
  fs.mkdirSync(epicsDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'project-brief.md'), '# Brief\n');
  fs.writeFileSync(path.join(runDir, 'prd.md'), '# PRD\n');
  fs.writeFileSync(path.join(runDir, 'architecture.md'), '# Arch\n');
  fs.writeFileSync(path.join(epicsDir, `${runId}.yaml`), `epic_id: ${runId}\n`);
}

// ── no source → no-op ────────────────────────────────────────────────────────

describe('migratePlanningScratch — srcRoot does not exist', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('returns migrated:false when srcRoot does not exist', () => {
    const srcRoot = path.join(tmp, 'planning');
    const dstRoot = path.join(tmp, 'dst', 'planning');
    const result = migratePlanningScratch({ srcRoot, dstRoot });
    assert.equal(result.migrated, false);
    assert.equal(result.from, null);
    assert.equal(result.method, null);
    assert.equal(result.to, dstRoot);
  });

  it('returns migrated:false when srcRoot is empty', () => {
    const srcRoot = path.join(tmp, 'empty-planning');
    fs.mkdirSync(srcRoot);
    const dstRoot = path.join(tmp, 'dst2', 'planning');
    const result = migratePlanningScratch({ srcRoot, dstRoot });
    assert.equal(result.migrated, false);
    assert.equal(result.from, null);
    assert.equal(result.method, null);
  });
});

// ── rename path ───────────────────────────────────────────────────────────────

describe('migratePlanningScratch — rename success (FR-7/AC2)', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('moves the runId subtree intact to dstRoot via rename', () => {
    const srcRoot = path.join(tmp, 'planning');
    const dstRoot = path.join(tmp, 'loom-home', 'repos', 'my-repo', 'planning');
    seedScratch(srcRoot, 'epic-001');

    const result = migratePlanningScratch({ srcRoot, dstRoot });

    assert.equal(result.migrated, true);
    assert.equal(result.from, srcRoot);
    assert.equal(result.to, dstRoot);
    assert.equal(result.method, 'rename');

    // All marker files land at loom-home
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-001', 'project-brief.md')));
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-001', 'prd.md')));
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-001', 'architecture.md')));
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-001', 'epics', 'epic-001.yaml')));
  });

  it('removed the moved runId subtree from srcRoot', () => {
    const srcRoot = path.join(tmp, 'planning');
    assert.ok(!fs.existsSync(path.join(srcRoot, 'epic-001')), 'moved dir must be gone from srcRoot');
  });
});

// ── EXDEV copy fallback ──────────────────────────────────────────────────────

describe('migratePlanningScratch — EXDEV copy fallback', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('falls back to copy+delete on EXDEV and reports method:copy', () => {
    const srcRoot = path.join(tmp, 'planning-exdev');
    const dstRoot = path.join(tmp, 'dst-exdev', 'planning');
    seedScratch(srcRoot, 'epic-002');

    // Monkey-patch renameSync to simulate EXDEV on the first rename attempt.
    // Cast to any to avoid PathLike overload friction in the test shim.
    const origRename = (fs.renameSync as (...a: unknown[]) => void).bind(fs);
    let exdevThrown = false;
    (fs as Record<string, unknown>)['renameSync'] = (src: unknown, dst: unknown) => {
      if (!exdevThrown && path.basename(String(src)) === 'epic-002') {
        exdevThrown = true;
        const err = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
        throw err;
      }
      origRename(src, dst);
    };

    let result;
    try {
      result = migratePlanningScratch({ srcRoot, dstRoot });
    } finally {
      (fs as Record<string, unknown>)['renameSync'] = origRename;
    }

    assert.equal(result.migrated, true);
    assert.equal(result.method, 'copy');
    // Files landed at dstRoot
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-002', 'project-brief.md')));
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-002', 'epics', 'epic-002.yaml')));
    // Src entry removed after copy
    assert.ok(!fs.existsSync(path.join(srcRoot, 'epic-002')));
  });
});

// ── LOOM-ON-LOOM SAFETY (the critical case) ──────────────────────────────────

describe('migratePlanningScratch — loom-on-loom safety (AC3)', () => {
  let projectRoot: string;
  let srcRoot: string;
  let dstRoot: string;

  before(() => {
    projectRoot = makeTmp();
    srcRoot = path.join(projectRoot, '.loom', 'planning');
    dstRoot = path.join(projectRoot, 'loom-home', 'planning');

    // Set up a git repo in projectRoot
    gitInit(projectRoot);
    gitCommit(projectRoot, 'initial empty commit');

    // Create a committed planning artifact (like epic-040 in the real repo)
    const committedDir = path.join(srcRoot, 'epic-040');
    const committedEpicsDir = path.join(committedDir, 'epics');
    fs.mkdirSync(committedEpicsDir, { recursive: true });
    fs.writeFileSync(path.join(committedDir, 'prd.md'), '# Committed PRD\n');
    fs.writeFileSync(path.join(committedEpicsDir, 'epic-040.yaml'), 'epic_id: epic-040\n');

    // Stage and commit the epic-040 directory
    gitAdd(projectRoot, path.relative(projectRoot, path.join(committedDir, 'prd.md')));
    gitAdd(projectRoot, path.relative(projectRoot, path.join(committedEpicsDir, 'epic-040.yaml')));
    gitCommit(projectRoot, 'add committed planning artifact');

    // Also seed a fresh (untracked) scratch directory
    seedScratch(srcRoot, 'epic-099');
  });

  after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  it('migrates the untracked runId subtree to dstRoot', () => {
    migratePlanningScratch({ srcRoot, dstRoot });
    assert.ok(
      fs.existsSync(path.join(dstRoot, 'epic-099', 'project-brief.md')),
      'untracked scratch must land in dstRoot',
    );
  });

  it('removes the migrated untracked runId from srcRoot', () => {
    assert.ok(
      !fs.existsSync(path.join(srcRoot, 'epic-099')),
      'migrated runId must be removed from srcRoot',
    );
  });

  it('never touches the committed epic-040 directory', () => {
    assert.ok(
      fs.existsSync(path.join(srcRoot, 'epic-040')),
      'committed epic-040 must remain in srcRoot',
    );
    assert.ok(
      fs.existsSync(path.join(srcRoot, 'epic-040', 'prd.md')),
      'committed prd.md must remain intact',
    );
  });

  it('does NOT move epic-040 to dstRoot (it stays in the repo)', () => {
    assert.ok(
      !fs.existsSync(path.join(dstRoot, 'epic-040')),
      'committed epic-040 must NOT appear in dstRoot',
    );
  });
});

// ── Stale removal confirmation (AC3/FR-8) ────────────────────────────────────

describe('migratePlanningScratch — stale removal after confirmed move (AC3/FR-8)', () => {
  let tmp: string;
  before(() => { tmp = makeTmp(); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('the moved runId no longer exists under srcRoot after migration', () => {
    const srcRoot = path.join(tmp, 'planning-stale');
    const dstRoot = path.join(tmp, 'loom-home2', 'planning');
    seedScratch(srcRoot, 'epic-007');

    const result = migratePlanningScratch({ srcRoot, dstRoot });

    assert.equal(result.migrated, true);
    // Stale in-repo entry is gone
    assert.ok(!fs.existsSync(path.join(srcRoot, 'epic-007')));
    // Destination has the data
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-007', 'project-brief.md')));
  });

  it('srcRoot itself is removed when all entries were untracked and migrated', () => {
    // After the previous test, srcRoot exists but is now empty (epic-007 was moved).
    // The migration should have removed the empty srcRoot.
    const srcRoot = path.join(tmp, 'planning-stale');
    assert.ok(
      !fs.existsSync(srcRoot),
      'empty srcRoot must be removed once all untracked entries are migrated',
    );
  });

  it('subsequent call with same srcRoot/dstRoot returns migrated:false (idempotent)', () => {
    const srcRoot = path.join(tmp, 'planning-stale');
    const dstRoot = path.join(tmp, 'loom-home2', 'planning');
    // srcRoot was removed above — does-not-exist path returns migrated:false
    const result = migratePlanningScratch({ srcRoot, dstRoot });
    assert.equal(result.migrated, false);
  });
});

// ── srcRoot retention when git-tracked entries remain ───────────────────────

describe('migratePlanningScratch — srcRoot preserved when git-tracked entries remain', () => {
  let projectRoot: string;
  let srcRoot: string;
  let dstRoot: string;

  before(() => {
    projectRoot = makeTmp();
    srcRoot = path.join(projectRoot, '.loom', 'planning');
    dstRoot = path.join(projectRoot, 'loom-home', 'planning');

    gitInit(projectRoot);
    gitCommit(projectRoot, 'initial empty commit');

    // Commit a planning artifact (stays in repo)
    const committedDir = path.join(srcRoot, 'epic-011');
    fs.mkdirSync(committedDir, { recursive: true });
    fs.writeFileSync(path.join(committedDir, 'prd.md'), '# Committed\n');
    gitAdd(projectRoot, path.relative(projectRoot, path.join(committedDir, 'prd.md')));
    gitCommit(projectRoot, 'add committed artifact');

    // Add an untracked scratch dir
    seedScratch(srcRoot, 'epic-012');
  });

  after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  it('migrates the untracked entry and leaves srcRoot because tracked entries remain', () => {
    migratePlanningScratch({ srcRoot, dstRoot });
    // Untracked epic-012 was migrated
    assert.ok(fs.existsSync(path.join(dstRoot, 'epic-012', 'project-brief.md')));
    // srcRoot still exists because epic-011 (git-tracked) is still there
    assert.ok(
      fs.existsSync(srcRoot),
      'srcRoot must NOT be removed when git-tracked entries remain',
    );
    assert.ok(
      fs.existsSync(path.join(srcRoot, 'epic-011', 'prd.md')),
      'git-tracked epic-011 must still be in srcRoot',
    );
  });
});
