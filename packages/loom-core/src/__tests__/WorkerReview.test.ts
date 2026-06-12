import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliWorker } from '../orchestrator/BaseCliWorker.js';
import type { WorkerAssignment, WorkerOutputCallback } from '../orchestrator/WorkerRunner.js';
import { CodeReviewAgent } from '../review/CodeReviewAgent.js';
import { MockLLMClient } from '../llm/MockLLMClient.js';
import type { Story } from '../types.js';

/**
 * Subclass of BaseCliWorker that stubs the agent subprocess. Each invocation
 * runs a callback (commit additions, output emission) and returns a clean exit.
 * Lets tests drive the review pass deterministically without a real CLI.
 */
class StubWorker extends BaseCliWorker {
  spawnCount = 0;

  constructor(
    opts: ConstructorParameters<typeof BaseCliWorker>[0] = {},
    private onSpawn: (cwd: string, spawnCount: number) => void = () => {}
  ) {
    super(opts);
  }

  protected binary(): string {
    return 'echo';
  }
  protected agentArgs(): string[] {
    return ['stub'];
  }
  protected spawnAgent(
    assignment: WorkerAssignment,
    _prompt: string
  ): Promise<{ code: number | null; output: string; timedOut: boolean; producedOutput: boolean }> {
    this.spawnCount += 1;
    this.onSpawn(assignment.worktreePath, this.spawnCount);
    assignment.onPid?.(12345);
    assignment.onOutput?.('stub-output\n', 'stdout');
    assignment.onPid?.(null);
    return Promise.resolve({ code: 0, output: 'stub-output\n', timedOut: false, producedOutput: true });
  }
}

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let repo: string;
let baseSha: string;

const STORY: Story = {
  id: 'story-001-001',
  title: 'Add /health endpoint',
  description: 'Return 200 from /health.',
  acceptance_criteria: ['returns 200'],
  estimated_complexity: 'small',
  dependencies: [],
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wr-'));
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

function assignment(): WorkerAssignment {
  return {
    storyId: STORY.id,
    epicId: 'epic-001',
    story: STORY,
    worktreePath: repo,
    branchName: 'story/story-001-001',
    baseSha,
    projectRoot: repo,
    skills: [],
  };
}

const CLEAN_REVIEW =
  '```json\n' +
  JSON.stringify({ findings: [], summary: 'Looks clean.' }) +
  '\n```';

const BLOCKER_REVIEW =
  '```json\n' +
  JSON.stringify({
    findings: [
      { severity: 'blocker', file: 'src/health.ts', issue: 'Missing null check' },
    ],
    summary: 'One blocker.',
  }) +
  '\n```';

const COMMENT_REVIEW =
  '```json\n' +
  JSON.stringify({
    findings: [
      { severity: 'should-fix', file: 'src/health.ts', issue: 'Inconsistent quotes' },
    ],
    summary: 'One should-fix.',
  }) +
  '\n```';

describe('BaseCliWorker — review pass (Epic 18 story-018-002)', () => {
  it("review_strategy='off' skips the review entirely", async () => {
    let spawnsBeforeReview = 0;
    const worker = new StubWorker(
      { reviewStrategy: 'off', openPr: false },
      (cwd, count) => {
        if (count === 1) {
          fs.writeFileSync(path.join(cwd, 'health.ts'), 'export const ok = true;\n');
          gitc(['add', '.'], cwd);
          gitc(['commit', '-q', '-m', 'add health'], cwd);
        }
        spawnsBeforeReview = count;
      }
    );
    const result = await worker.run(assignment());
    assert.equal(result.status, 'done');
    assert.equal(result.review?.status, 'skipped');
    assert.equal(spawnsBeforeReview, 1); // only the initial work spawn
  });

  it("review_strategy='comment' runs once, status=passed when clean", async () => {
    const worker = new StubWorker(
      {
        reviewStrategy: 'comment',
        openPr: false,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: new MockLLMClient([CLEAN_REVIEW]),
          model: 'mock',
        }),
      },
      (cwd, count) => {
        if (count === 1) {
          fs.writeFileSync(path.join(cwd, 'health.ts'), 'export const ok = true;\n');
          gitc(['add', '.'], cwd);
          gitc(['commit', '-q', '-m', 'add health'], cwd);
        }
      }
    );
    const result = await worker.run(assignment());
    assert.equal(result.review?.status, 'passed');
    assert.equal(result.review?.revisions, 0);
  });

  it("review_strategy='comment' returns 'commented' when findings are non-blockers", async () => {
    const worker = new StubWorker(
      {
        reviewStrategy: 'comment',
        openPr: false,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: new MockLLMClient([COMMENT_REVIEW]),
          model: 'mock',
        }),
      },
      (cwd, count) => {
        if (count === 1) {
          fs.writeFileSync(path.join(cwd, 'health.ts'), 'export const ok = true;\n');
          gitc(['add', '.'], cwd);
          gitc(['commit', '-q', '-m', 'add health'], cwd);
        }
      }
    );
    const result = await worker.run(assignment());
    assert.equal(result.review?.status, 'commented');
    assert.equal(result.review?.totalCount, 1);
    assert.ok(result.review?.commentBody?.includes('should-fix'));
  });

  it("review_strategy='block-and-revise' re-prompts the worker on blockers, ends 'blocked' if unresolved", async () => {
    // Both review calls return the same blocker — never resolved.
    const worker = new StubWorker(
      {
        reviewStrategy: 'block-and-revise',
        openPr: false,
        maxReviewRevisions: 2,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: new MockLLMClient([BLOCKER_REVIEW, BLOCKER_REVIEW, BLOCKER_REVIEW]),
          model: 'mock',
        }),
      },
      (cwd, count) => {
        // Initial commit + every revision adds one commit (so countCommits > 0).
        const name = `f${count}.ts`;
        fs.writeFileSync(path.join(cwd, name), 'export const v = 1;\n');
        gitc(['add', '.'], cwd);
        gitc(['commit', '-q', '-m', `pass ${count}`], cwd);
      }
    );
    const result = await worker.run(assignment());
    assert.equal(result.review?.status, 'blocked');
    assert.equal(result.review?.revisions, 2);
    // 1 initial work spawn + 2 revision spawns
    assert.equal(worker.spawnCount, 3);
  });

  it("propagates accumulated usage via WorkerResult.usage when set in parseStreamLine", async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    class UsageStubWorker extends StubWorker {
      protected parseStreamLine(line: string): { humanText?: string; usage?: any } {
        if (line === 'USAGE') {
          return {
            usage: {
              inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4,
              totalTokens: 10,
            },
          };
        }
        return { humanText: line };
      }
      protected spawnAgent(
        assignment: WorkerAssignment,
        _prompt: string
      ): any {
        const cwd = assignment.worktreePath;
        // Drive the stub by feeding a fake "USAGE" line into the parser.
        assignment.onPid?.(1);
        const parsed = this.parseStreamLine('USAGE');
        (this as any).accumulatedUsage = parsed.usage;
        // Make a real commit so countCommits sees it.
        const { execFileSync } = require('node:child_process');
        const fs2 = require('node:fs');
        fs2.writeFileSync(`${cwd}/x.ts`, 'export const v = 1;\n');
        execFileSync('git', ['add', '.'], { cwd });
        execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd });
        assignment.onPid?.(null);
        return Promise.resolve({ code: 0, output: '', timedOut: false });
      }
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const worker = new UsageStubWorker({ reviewStrategy: 'off', openPr: false });
    const result = await worker.run(assignment());
    assert.equal(result.usage?.inputTokens, 1);
    assert.equal(result.usage?.totalTokens, 10);
  });

  it("review_revise_trigger='any' re-prompts on a non-blocker comment", async () => {
    // Reviewer returns a comment-severity finding, no blockers. Default
    // behavior would PASS the review without revision; 'any' should trigger
    // a revision round despite the absence of blockers.
    const COMMENT_ONLY_REVIEW =
      '```json\n{"summary":"one comment","findings":[{"severity":"should-fix","file":"foo.ts","line":42,"issue":"the kwarg flows through unchanged"}]}\n```';
    const POST_REVISION_CLEAN =
      '```json\n{"summary":"good","findings":[]}\n```';

    let spawnCount = 0;
    const worker = new StubWorker(
      {
        reviewStrategy: 'block-and-revise',
        reviewReviseTrigger: 'any',
        openPr: false,
        maxReviewRevisions: 2,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: new MockLLMClient([COMMENT_ONLY_REVIEW, POST_REVISION_CLEAN]),
          model: 'mock',
        }),
      },
      (cwd, count) => {
        spawnCount = count;
        fs.writeFileSync(path.join(cwd, `f${count}.ts`), 'export const v = 1;\n');
        gitc(['add', '.'], cwd);
        gitc(['commit', '-q', '-m', `pass ${count}`], cwd);
      },
    );
    const result = await worker.run(assignment());
    assert.equal(result.review?.revisions, 1, "'any' trigger should produce 1 revision on a comment-only finding");
    assert.equal(result.review?.status, 'passed', 'post-revision review with no findings is passed');
    assert.equal(spawnCount, 2, 'initial spawn + one revision');
  });

  it('reviewer crash does NOT cascade-fail the worker (#21)', async () => {
    // Reviewer LLM throws synchronously — the worker should catch, mark the
    // review status='errored', and complete the story as 'done'. The
    // worker's commits stay on the branch.
    const throwingLlm = {
      complete: async () => {
        throw new Error('reviewer subprocess crashed: invalid model id');
      },
    };
    const worker = new StubWorker(
      {
        reviewStrategy: 'block-and-revise',
        openPr: false,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: throwingLlm,
          model: 'mock',
        }),
      },
      (cwd) => {
        fs.writeFileSync(path.join(cwd, 'x.ts'), 'export const v = 1;\n');
        gitc(['add', '.'], cwd);
        gitc(['commit', '-q', '-m', 'work'], cwd);
      },
    );
    const result = await worker.run(assignment());
    assert.equal(result.status, 'done', 'story must remain done despite reviewer crash');
    assert.equal(result.review?.status, 'errored');
    assert.match(result.review?.summary ?? '', /Review failed: reviewer subprocess crashed/);
    assert.match(result.review?.summary ?? '', /Worker commits intact/);
  });

  it("review_strategy='block-and-revise' clears the blocker on second review", async () => {
    const worker = new StubWorker(
      {
        reviewStrategy: 'block-and-revise',
        openPr: false,
        maxReviewRevisions: 2,
        reviewAgent: new CodeReviewAgent({
          projectRoot: repo,
          llm: new MockLLMClient([BLOCKER_REVIEW, CLEAN_REVIEW]),
          model: 'mock',
        }),
      },
      (cwd, count) => {
        const name = `f${count}.ts`;
        fs.writeFileSync(path.join(cwd, name), 'export const v = 1;\n');
        gitc(['add', '.'], cwd);
        gitc(['commit', '-q', '-m', `pass ${count}`], cwd);
      }
    );
    const result = await worker.run(assignment());
    assert.equal(result.review?.status, 'passed');
    assert.equal(result.review?.revisions, 1);
  });
});
