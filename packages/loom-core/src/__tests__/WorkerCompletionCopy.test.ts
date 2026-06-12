import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliWorker } from '../orchestrator/BaseCliWorker.js';
import type { WorkerAssignment } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const STORY: Story = {
  id: 'story-001-001',
  title: 'Add something',
  description: 'desc',
  acceptance_criteria: ['works'],
  estimated_complexity: 'small',
  dependencies: [],
};

/**
 * Commits one file per spawn so `countCommits` sees a non-empty diff. With
 * `commit:false` it exits cleanly without committing — the audit-story shape
 * (commitCount === 0).
 */
class CopyWorker extends BaseCliWorker {
  constructor(
    opts: ConstructorParameters<typeof BaseCliWorker>[0],
    private readonly commit: boolean
  ) {
    super(opts);
  }
  protected binary(): string {
    return 'true';
  }
  protected agentArgs(): string[] {
    return [];
  }
  protected spawnAgent(
    assignment: WorkerAssignment
  ): Promise<{ code: number | null; output: string; timedOut: boolean; producedOutput: boolean }> {
    if (this.commit) {
      const file = path.join(assignment.worktreePath, 'change.ts');
      fs.writeFileSync(file, 'export const x = 1;\n');
      gitc(['add', '-A'], assignment.worktreePath);
      gitc(['commit', '-q', '-m', 'work'], assignment.worktreePath);
    }
    return Promise.resolve({ code: 0, output: 'done\n', timedOut: false, producedOutput: true });
  }
}

describe('BaseCliWorker — DAG-accurate completion copy', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-copy-'));
    gitc(['init', '-q'], repo);
    gitc(['config', 'user.email', 'test@loom.dev'], repo);
    gitc(['config', 'user.name', 'Loom Test'], repo);
    gitc(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
    gitc(['add', '.'], repo);
    gitc(['commit', '-q', '-m', 'initial'], repo);
    baseSha = gitc(['rev-parse', 'HEAD'], repo);
    gitc(['checkout', '-q', '-b', 'story/story-001-001'], repo);
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function assignment(overrides: Partial<WorkerAssignment> = {}): WorkerAssignment {
    return {
      storyId: STORY.id,
      epicId: 'epic-001',
      story: STORY,
      worktreePath: repo,
      branchName: 'story/story-001-001',
      baseSha,
      projectRoot: repo,
      skills: [],
      ...overrides,
    };
  }

  // Any phrasing that would imply a real downstream story exists.
  const downstreamClaim = /downstream|dependent stor|build on this/i;

  it('terminal + changed code (hasDependents=false, commitCount>0): acknowledges code, names no downstream', async () => {
    const worker = new CopyWorker({ openPr: false }, true);
    const result = await worker.run(assignment({ hasDependents: false }));

    assert.equal(result.status, 'done');
    assert.ok(result.commitCount > 0, 'the worker committed code');
    assert.ok(
      /implemented .*commit/i.test(result.summary),
      'copy acknowledges code changed'
    );
    assert.ok(
      !/dependent stor|build on this/i.test(result.summary),
      'terminal story names no nonexistent downstream story'
    );
    assert.ok(
      /no downstream stories depend/i.test(result.summary),
      'copy truthfully states it is terminal'
    );
  });

  it('terminal + no code (commitCount=0): reflects no-code, still no downstream claim', async () => {
    const worker = new CopyWorker({ openPr: false }, false);
    const result = await worker.run(assignment({ hasDependents: false }));

    assert.equal(result.status, 'done');
    assert.equal(result.commitCount, 0);
    assert.ok(
      /without code changes/i.test(result.summary),
      'copy reflects that no code changed'
    );
    assert.ok(
      !/dependent stor|build on this/i.test(result.summary),
      'no false downstream claim for a terminal no-code story'
    );
  });

  it('has-dependents (hasDependents=true): copy may reference downstream work', async () => {
    const worker = new CopyWorker({ openPr: false }, true);
    const result = await worker.run(assignment({ hasDependents: true }));

    assert.equal(result.status, 'done');
    assert.ok(
      downstreamClaim.test(result.summary),
      'copy references the downstream work that truthfully exists'
    );
  });

  it('hasDependents unset (mock/bench path): degrades safely — no crash, no false downstream claim', async () => {
    const worker = new CopyWorker({ openPr: false }, true);
    // No hasDependents on the assignment at all (additive/optional field).
    const result = await worker.run(assignment());

    assert.equal(result.status, 'done');
    assert.ok(result.commitCount > 0);
    assert.ok(
      /implemented .*commit/i.test(result.summary),
      'still reports the work it did'
    );
    assert.ok(
      !downstreamClaim.test(result.summary),
      'with no DAG, the copy invents no downstream story'
    );
  });
});
