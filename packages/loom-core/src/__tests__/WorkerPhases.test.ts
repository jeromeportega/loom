import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliWorker } from '../orchestrator/BaseCliWorker.js';
import { buildWorkerPrompt } from '../orchestrator/workerPrompt.js';
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
 * Records every spawnAgent prompt and, on each call, simulates the agent
 * committing one file. A `failOn` index lets a test make a particular phase
 * time out instead of committing.
 */
class PhaseRecordingWorker extends BaseCliWorker {
  readonly prompts: string[] = [];
  private call = 0;
  constructor(
    opts: ConstructorParameters<typeof BaseCliWorker>[0],
    private readonly timeoutOnCall?: number
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
    assignment: WorkerAssignment,
    prompt: string
  ): Promise<{
    code: number | null;
    output: string;
    timedOut: boolean;
    producedOutput: boolean;
    timeoutReason?: 'stall' | 'cap';
  }> {
    this.call += 1;
    this.prompts.push(prompt);
    if (this.timeoutOnCall === this.call) {
      // Leave an uncommitted edit, then report a timeout — mirrors a real kill.
      fs.writeFileSync(path.join(assignment.worktreePath, `wip-${this.call}.ts`), 'x\n');
      return Promise.resolve({ code: null, output: 'busy\n', timedOut: true, producedOutput: true, timeoutReason: 'stall' });
    }
    const file = path.join(assignment.worktreePath, `phase-${this.call}.ts`);
    fs.writeFileSync(file, `export const c${this.call} = ${this.call};\n`);
    gitc(['add', '-A'], assignment.worktreePath);
    gitc(['commit', '-q', '-m', `phase ${this.call} commit`], assignment.worktreePath);
    return Promise.resolve({ code: 0, output: 'done\n', timedOut: false, producedOutput: true });
  }
}

describe('BaseCliWorker — phased pipeline', () => {
  let repo: string;
  let baseSha: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-phases-'));
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

  it('runs a single spawn when phases are off (bench baseline)', async () => {
    const worker = new PhaseRecordingWorker({ openPr: false });
    const result = await worker.run(assignment());
    assert.equal(result.status, 'done');
    assert.equal(worker.prompts.length, 1, 'exactly one agent spawn');
    assert.ok(!/Verification phase/.test(worker.prompts[0]), 'no verify block in single-spawn mode');
  });

  it('runs implement + verify spawns when phases are on, each freshly prompted', async () => {
    const boundaries: string[] = [];
    const worker = new PhaseRecordingWorker({ openPr: false, phases: 'on' });
    const result = await worker.run(
      assignment({ onPhaseBoundary: (info) => boundaries.push(info.phase) })
    );
    assert.equal(result.status, 'done');
    assert.equal(worker.prompts.length, 2, 'implement + verify spawns');
    assert.ok(!/Verification phase/.test(worker.prompts[0]), 'phase 1 is the implement prompt');
    assert.ok(/Verification phase/.test(worker.prompts[1]), 'phase 2 is the verify prompt');
    assert.deepEqual(boundaries, ['implement', 'verify'], 'both phase boundaries fired in order');

    // Both phases committed, on the same branch.
    const count = Number(gitc(['rev-list', '--count', `${baseSha}..HEAD`], repo));
    assert.equal(count, 2, 'implement and verify each landed a commit');
  });

  it('a verify-phase timeout fails the story but preserves the implement commit', async () => {
    // call 1 = implement (commits), call 2 = verify (times out).
    const worker = new PhaseRecordingWorker({ openPr: false, phases: 'on' }, 2);
    const result = await worker.run(assignment());
    assert.equal(result.status, 'failed');
    assert.ok(/timed out/i.test(result.summary), 'reports the verify timeout');

    const log = gitc(['log', '--oneline', `${baseSha}..HEAD`], repo);
    assert.ok(/phase 1 commit/.test(log), 'the implement commit survived the verify timeout');
    assert.ok(/wip: timeout-stall checkpoint \[loom\]/.test(log), 'verify residue checkpointed');
  });

  it('skips verify on zero-commit completion and reports `done` (audit-only stories)', async () => {
    // A normally-exited zero-commit worker is the audit-story shape: the
    // planner created an investigate/identify story, the worker completed it,
    // there is nothing to commit. Verify still does not run (there is no
    // implementation to verify), but the status is `done` so dependent
    // stories are not cascade-blocked. Abnormal exits stay `failed` —
    // covered by the next test.
    class NoCommitWorker extends BaseCliWorker {
      readonly prompts: string[] = [];
      protected binary(): string { return 'true'; }
      protected agentArgs(): string[] { return []; }
      protected spawnAgent(_a: WorkerAssignment, prompt: string): Promise<{
        code: number | null; output: string; timedOut: boolean; producedOutput: boolean;
      }> {
        this.prompts.push(prompt);
        return Promise.resolve({ code: 0, output: '', timedOut: false, producedOutput: false });
      }
    }
    const worker = new NoCommitWorker({ openPr: false, phases: 'on' });
    const result = await worker.run(assignment());
    assert.equal(result.status, 'done');
    assert.equal(result.commitCount, 0);
    assert.ok(/without code changes/i.test(result.summary), 'summary names the no-code-changes shape');
    assert.equal(worker.prompts.length, 1, 'verify is skipped when implement produced nothing');
  });

  it('zero-commit completion with a non-zero exit code stays `failed`', async () => {
    // Abnormal exit + no commits is a genuine worker death, not an audit.
    // The cascade-block protection should still apply here.
    class CrashingNoCommitWorker extends BaseCliWorker {
      readonly prompts: string[] = [];
      protected binary(): string { return 'true'; }
      protected agentArgs(): string[] { return []; }
      protected spawnAgent(_a: WorkerAssignment, prompt: string): Promise<{
        code: number | null; output: string; timedOut: boolean; producedOutput: boolean;
      }> {
        this.prompts.push(prompt);
        return Promise.resolve({ code: 1, output: 'crashed', timedOut: false, producedOutput: true });
      }
    }
    const worker = new CrashingNoCommitWorker({ openPr: false, phases: 'on' });
    const result = await worker.run(assignment());
    assert.equal(result.status, 'failed');
    assert.equal(result.commitCount, 0);
    assert.ok(/exited with code 1/.test(result.summary), 'summary names the non-zero exit');
    assert.equal(worker.prompts.length, 1, 'verify is skipped on a crash too');
  });
});

describe('buildWorkerPrompt — verify phase block', () => {
  function assignment(): WorkerAssignment {
    return {
      storyId: STORY.id,
      epicId: 'epic-001',
      story: STORY,
      worktreePath: '/tmp/x',
      branchName: 'story/story-001-001',
      baseSha: 'abc',
      projectRoot: '/tmp/x',
      skills: [],
    };
  }

  it('implement phase is byte-identical to the unphased baseline', () => {
    const base = buildWorkerPrompt(assignment());
    const implement = buildWorkerPrompt(assignment(), { phase: 'implement' });
    assert.equal(implement, base, 'phase=implement adds nothing to the baseline prompt');
  });

  it('verify phase appends the verification instructions', () => {
    const verify = buildWorkerPrompt(assignment(), { phase: 'verify' });
    assert.ok(/Verification phase/.test(verify));
    assert.ok(/full build and test suite/i.test(verify));
    assert.ok(/already committed/i.test(verify));
  });
});
