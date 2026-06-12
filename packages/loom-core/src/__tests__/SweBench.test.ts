import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SweBenchLoader } from '../bench/SweBenchLoader.js';
import { SweBenchRunner, writePredictions } from '../bench/SweBenchRunner.js';
import type { SweBenchTask } from '../bench/types.js';

let tmp: string;

const TASK_A = {
  instance_id: 'demo__demo-1',
  repo: 'demo/demo',
  base_commit: 'b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9d0',
  problem_statement: 'Add a divide() function that errors on zero.',
};
const TASK_B = {
  instance_id: 'demo__demo-2',
  repo: 'demo/demo',
  base_commit: 'b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9d0',
  problem_statement: 'Add a multiply() function.',
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bench-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('SweBenchLoader', () => {
  it('loads a bare array of task rows', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify([TASK_A, TASK_B]));
    const tasks = SweBenchLoader.load(file);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].instance_id, 'demo__demo-1');
  });

  it('unwraps the HuggingFace dataset-server `{rows:[{row:...}]}` shape', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ rows: [{ row: TASK_A }, { row: TASK_B }] })
    );
    const tasks = SweBenchLoader.load(file);
    assert.equal(tasks.length, 2);
  });

  it('respects --limit', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify([TASK_A, TASK_B]));
    const tasks = SweBenchLoader.load(file, 1);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].instance_id, 'demo__demo-1');
  });

  it('throws a guidance error when the file is missing', () => {
    assert.throws(
      () => SweBenchLoader.load(path.join(tmp, 'nope.json')),
      /SWE-bench dataset not found/
    );
  });

  it('refuses to load a malformed row', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(file, JSON.stringify([{ instance_id: 'x' /* missing fields */ }]));
    assert.throws(() => SweBenchLoader.load(file));
  });

  it('accepts the real HuggingFace dataset-server shape (string-encoded array columns)', () => {
    // Mimics the actual /rows response: top-level `features` + `rows`,
    // and FAIL_TO_PASS / PASS_TO_PASS arrive as JSON-encoded strings.
    // Regression — the original schema rejected this.
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        features: [{ name: 'repo' }, { name: 'instance_id' }],
        rows: [
          {
            row: {
              ...TASK_A,
              FAIL_TO_PASS: '["test_a"]', // string-encoded, not array
              PASS_TO_PASS: '[]',
              patch: 'diff --git a/x b/x',
              test_patch: 'diff --git a/test b/test',
              version: '5.0',
            },
          },
        ],
      })
    );
    const tasks = SweBenchLoader.load(file);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].instance_id, TASK_A.instance_id);
  });
});

describe('writePredictions', () => {
  it('emits the official SWE-bench predictions shape', () => {
    const out = path.join(tmp, 'predictions.json');
    writePredictions(
      out,
      [
        { instanceId: 'demo__1', patch: 'diff --git a/x b/x', commitCount: 1, durationMs: 100 },
        { instanceId: 'demo__2', patch: '', commitCount: 0, durationMs: 50, error: 'clone failed' },
      ],
      'loom-test'
    );
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(written.length, 2);
    assert.equal(written[0].instance_id, 'demo__1');
    assert.equal(written[0].model_name_or_path, 'loom-test');
    assert.match(written[0].model_patch, /diff/);
    assert.equal(written[1].model_patch, ''); // errored task still emitted
  });
});

describe('SweBenchRunner.runOne', () => {
  /**
   * Builds a small local bare repo + an upstream working clone with one
   * commit so the runner can clone it via file://. Lets us exercise the
   * full clone → checkout → diff loop without hitting GitHub.
   */
  function seedLocalRepo(): { cloneUrl: string; baseSha: string } {
    const upstream = path.join(tmp, 'upstream');
    const bare = path.join(tmp, 'demo.git');

    execFileSync('git', ['init', '-q', upstream]);
    execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: upstream });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: upstream });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'README.md'), 'base\n');
    execFileSync('git', ['add', '.'], { cwd: upstream });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: upstream });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: upstream,
      encoding: 'utf8',
    }).trim();

    execFileSync('git', ['clone', '--quiet', '--bare', upstream, bare]);
    return { cloneUrl: `file://${bare}`, baseSha };
  }

  it('clones, hands off to runLoom, captures the diff', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async ({ repoDir }) => {
        // Simulate loom having made a commit on the worktree.
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const v = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'feat: add divide'], { cwd: repoDir });
        return { commitCount: 1 };
      },
    });

    const result = await runner.runOne(task);
    assert.equal(result.instanceId, task.instance_id);
    assert.equal(result.commitCount, 1);
    assert.match(result.patch, /diff --git/);
    assert.match(result.patch, /feature\.ts/);
    assert.equal(result.error, undefined);
  });

  it('returns an empty patch when runLoom errors', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_B, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async () => ({ commitCount: 0, error: 'loom crashed' }),
    });

    const result = await runner.runOne(task);
    assert.equal(result.patch, '');
    assert.equal(result.commitCount, 0);
    assert.equal(result.error, 'loom crashed');
  });

  it('records an error when the clone fails', async () => {
    const runner = new SweBenchRunner({
      cloneUrl: () => 'file:///nope/does-not-exist.git',
      onProgress: () => {},
      runLoom: async () => ({ commitCount: 0 }),
    });

    const result = await runner.runOne(TASK_A);
    assert.ok(result.error, 'expected an error from a missing clone source');
    assert.equal(result.patch, '');
  });

  it('excludes .loom_outputs / .loom / .loom-notes / .claude / .mcp.json / .cursor / CLAUDE.md from the captured diff', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async ({ repoDir }) => {
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });

        // Real application change.
        fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const v = 1;\n');

        // Loom meta-files that should NOT appear in the captured diff.
        fs.mkdirSync(path.join(repoDir, '.loom_outputs', 'epic-001'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, '.loom_outputs', 'epic-001', 'architecture.md'), '# Architecture\n');
        fs.mkdirSync(path.join(repoDir, '.loom'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, '.loom', 'diagnosis.md'), '# scratch\n');
        fs.mkdirSync(path.join(repoDir, '.loom-notes'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, '.loom-notes', 'design.md'), '# notes\n');
        fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, '.claude', 'settings.json'), '{}\n');
        fs.writeFileSync(path.join(repoDir, '.mcp.json'), '{}\n');
        fs.mkdirSync(path.join(repoDir, '.cursor'), { recursive: true });
        fs.writeFileSync(path.join(repoDir, '.cursor', 'mcp.json'), '{}\n');
        fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# CLAUDE\n');

        execFileSync('git', ['add', '-A'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'work + meta'], { cwd: repoDir });
        return { commitCount: 1 };
      },
    });

    const result = await runner.runOne(task);
    assert.match(result.patch, /feature\.ts/);
    assert.ok(!/\.loom_outputs/.test(result.patch), 'patch should not contain .loom_outputs');
    assert.ok(!/\.loom\//.test(result.patch), 'patch should not contain .loom/');
    assert.ok(!/\.loom-notes/.test(result.patch), 'patch should not contain .loom-notes/');
    assert.ok(!/\.claude/.test(result.patch), 'patch should not contain .claude/');
    assert.ok(!/\.mcp\.json/.test(result.patch), 'patch should not contain .mcp.json');
    assert.ok(!/\.cursor/.test(result.patch), 'patch should not contain .cursor/');
    assert.ok(!/CLAUDE\.md/.test(result.patch), 'patch should not contain CLAUDE.md');
  });

  it('falls back to merging story/* branches when no epic branch exists (partial-epic success)', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async ({ repoDir }) => {
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });

        // Story 1 succeeds: commits on its own branch
        execFileSync('git', ['checkout', '-q', '-b', 'story/story-001-001', baseSha], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'feature-a.ts'), 'export const a = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'feat: story-001'], { cwd: repoDir });

        // Story 2 succeeds: commits on a different file
        execFileSync('git', ['checkout', '-q', '-b', 'story/story-001-002', baseSha], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'feature-b.ts'), 'export const b = 2;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'feat: story-002'], { cwd: repoDir });

        // Story 3 failed → no story/story-001-003 branch. EpicFinalizer
        // requires all-stories-success, so no epic/* branch was created.
        // HEAD points at base. Previously this would capture an empty
        // patch; the new fallback should merge stories 1 + 2.

        // Reset HEAD to base so the bench harness sees the "no
        // EpicFinalizer ran" state precisely.
        execFileSync('git', ['checkout', '-q', baseSha], { cwd: repoDir });

        return { commitCount: 2 };
      },
    });

    const result = await runner.runOne(task);
    assert.match(result.patch, /diff --git/);
    assert.match(result.patch, /feature-a\.ts/);
    assert.match(result.patch, /feature-b\.ts/);
    assert.equal(result.error, undefined);
  });

  it('returns an empty patch when only HEAD has commits AND no story branches present', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_B, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async () => ({ commitCount: 0 }),
    });

    const result = await runner.runOne(task);
    assert.equal(result.patch, '');
  });

  it('preserves the tempdir of a failed task when preserveFailures is set', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      preserveFailures: true,
      runLoom: async () => ({ commitCount: 0, error: 'simulated failure' }),
    });

    const result = await runner.runOne(task);
    assert.ok(result.error);
    assert.ok(result.preservedPath, 'expected preservedPath on a failure with preserveFailures=true');
    assert.ok(fs.existsSync(result.preservedPath!), 'preserved tempdir should still exist');

    // Cleanup so the test doesn't leak the dir.
    fs.rmSync(result.preservedPath!, { recursive: true, force: true });
  });

  it('preserves the tempdir when the captured patch is empty (worker-no-commits case)', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      preserveFailures: true,
      runLoom: async () => ({ commitCount: 0 }), // no error, but no commits
    });

    const result = await runner.runOne(task);
    assert.equal(result.error, undefined);
    assert.equal(result.patch, '');
    assert.ok(result.preservedPath, 'empty-patch should preserve when preserveFailures=true');
    assert.ok(fs.existsSync(result.preservedPath!));

    fs.rmSync(result.preservedPath!, { recursive: true, force: true });
  });

  it('cleans up the tempdir of a successful task even with preserveFailures', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    let capturedTmpdir = '';
    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      preserveFailures: true,
      runLoom: async ({ repoDir }) => {
        capturedTmpdir = repoDir;
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const v = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: repoDir });
        return { commitCount: 1 };
      },
    });

    const result = await runner.runOne(task);
    assert.match(result.patch, /diff --git/);
    assert.equal(result.preservedPath, undefined);
    assert.equal(fs.existsSync(capturedTmpdir), false, 'successful task should have cleaned up');
  });

  it('preserves the tempdir of a successful task when preserveAll is set (django-11019-style forensics)', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      preserveAll: true,
      runLoom: async ({ repoDir }) => {
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'feature.ts'), 'export const v = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: repoDir });
        return { commitCount: 1 };
      },
    });

    const result = await runner.runOne(task);
    assert.match(result.patch, /diff --git/);
    assert.ok(
      result.preservedPath,
      'preserveAll should preserve even when loom reports success — for harness-disagrees diagnostics',
    );
    assert.ok(fs.existsSync(result.preservedPath!));

    fs.rmSync(result.preservedPath!, { recursive: true, force: true });
  });

  it('uses the most recent epic/* branch as HEAD when one exists', async () => {
    const { cloneUrl, baseSha } = seedLocalRepo();
    const task: SweBenchTask = { ...TASK_A, base_commit: baseSha };

    const runner = new SweBenchRunner({
      cloneUrl: () => cloneUrl,
      onProgress: () => {},
      runLoom: async ({ repoDir }) => {
        execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: repoDir });
        execFileSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
        // Loom's per-epic PR strategy leaves the work on epic/<id>, not HEAD.
        execFileSync('git', ['checkout', '-b', 'epic/epic-001', '--quiet'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'on-epic.ts'), 'export const v = 1;\n');
        execFileSync('git', ['add', '.'], { cwd: repoDir });
        execFileSync('git', ['commit', '-q', '-m', 'feat'], { cwd: repoDir });
        // Switch HEAD back to base so we exercise the epic/* discovery.
        execFileSync('git', ['checkout', '--quiet', baseSha], { cwd: repoDir });
        return { commitCount: 1 };
      },
    });

    const result = await runner.runOne(task);
    assert.match(result.patch, /on-epic\.ts/);
  });
});
