import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BaseCliWorker,
  mergeWorkerUsage,
} from '../orchestrator/BaseCliWorker.js';
import type { WorkerAssignment, WorkerUsage } from '../orchestrator/WorkerRunner.js';
import type { Story } from '../types.js';

describe('mergeWorkerUsage (v0.5.0)', () => {
  it('sums all token columns, totalTokens, requestCount, and costUsd', () => {
    const a: WorkerUsage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      totalTokens: 100,
      costUsd: 0.05,
      requestCount: 1,
    };
    const b: WorkerUsage = {
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 12,
      costUsd: 0.02,
      requestCount: 1,
    };
    assert.deepEqual(mergeWorkerUsage(a, b), {
      inputTokens: 15,
      outputTokens: 27,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      totalTokens: 112,
      costUsd: 0.07,
      requestCount: 2,
    });
  });

  it('only emits costUsd / requestCount when at least one side reports it', () => {
    const a: WorkerUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 3,
    };
    const b: WorkerUsage = {
      inputTokens: 4,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 9,
    };
    const merged = mergeWorkerUsage(a, b);
    assert.equal(merged.costUsd, undefined);
    assert.equal(merged.requestCount, undefined);
  });

  it('treats a missing optional as 0 so a partial side does not erase the other', () => {
    const a: WorkerUsage = {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1,
      requestCount: 1,
      costUsd: 0.01,
    };
    const b: WorkerUsage = {
      inputTokens: 2,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 2,
      // costUsd / requestCount absent — Cursor backend may not report them.
    };
    assert.deepEqual(mergeWorkerUsage(a, b), {
      inputTokens: 3,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 3,
      requestCount: 1,
      costUsd: 0.01,
    });
  });
});

/**
 * Drives spawnAgent through a real subprocess (`node -e`) that emits two
 * stream-json lines on stdout — an `assistant` event with interim usage and
 * a `result` event with final usage. Verifies the WorkerResult.usage
 * accumulates correctly across two spawns (the block-and-revise / phases
 * pattern), not just within one.
 */
class StreamJsonWorker extends BaseCliWorker {
  private script: string;
  constructor(script: string) {
    super({});
    this.script = script;
  }
  protected binary(): string {
    return process.execPath; // node
  }
  protected agentArgs(): string[] {
    return ['-e', this.script];
  }
  // ClaudeCodeWorker's parser, inlined to avoid coupling the test to the
  // subclass: parse `result` events the same way the real worker does.
  protected parseStreamLine(line: string): {
    humanText?: string;
    usage?: WorkerUsage;
    traces?: Array<{ kind: string; subject?: string; rationale: string }>;
  } {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'result' && obj.usage && typeof obj.usage === 'object') {
        const u = obj.usage as Record<string, number>;
        const totalTokens =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0);
        return {
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            totalTokens,
            requestCount: 1,
            costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : 0,
          },
        };
      }
    } catch {
      // fall through
    }
    return {};
  }
  /** Public test seam — drives the protected spawnAgent and returns its
      observed final accumulatedUsage so tests can assert. */
  async runSpawn(a: WorkerAssignment): Promise<WorkerUsage | undefined> {
    await (this as unknown as {
      spawnAgent: (a: WorkerAssignment, p: string) => Promise<unknown>;
    }).spawnAgent(a, 'ignored');
    return (this as unknown as { accumulatedUsage?: WorkerUsage }).accumulatedUsage;
  }
}

let repo: string;
let baseSha: string;
const STORY: Story = {
  id: 'story-001-001',
  title: 'Verify accumulation',
  description: 'noop',
  acceptance_criteria: ['n/a'],
  estimated_complexity: 'small',
  dependencies: [],
};

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wua-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@loom.dev'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Loom Test'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'i'], { cwd: repo });
  baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
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

describe('BaseCliWorker.spawnAgent — usage accumulation across spawns (v0.5.0)', () => {
  it('sums per-spawn requestCount / cost / tokens (the block-and-revise + phases case)', async () => {
    // Each "spawn" emits a stream-json line with a fixed token + cost shape.
    const emitScript = (cost: number): string =>
      `process.stdout.write(JSON.stringify({` +
      `type:"result",` +
      `usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0},` +
      `total_cost_usd:${cost}` +
      `})+'\\n')`;

    const worker1 = new StreamJsonWorker(emitScript(0.10));
    const first = await worker1.runSpawn(assignment());
    assert.deepEqual(first, {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 15,
      requestCount: 1,
      costUsd: 0.10,
    });

    // Second spawn on the SAME worker — accumulatedUsage MUST carry the prior
    // session forward. Pre-fix this assertion would see only the second
    // spawn's totals (`requestCount: 1`, `costUsd: 0.10`); post-fix it sees
    // the running total of both spawns (requestCount: 2, costUsd: 0.20).
    const after = await worker1.runSpawn(assignment());
    assert.deepEqual(after, {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 30,
      requestCount: 2,
      costUsd: 0.20,
    });
  });

  it('trips the budget kill on cumulative tokens across two spawns (not per-spawn)', async () => {
    // Each spawn emits 15 tokens. Budget is 20 — under cap for ONE spawn
    // (15 < 20), over cap once cumulative (30 > 20). Pre-fix this test would
    // not exhaust the budget (per-spawn semantic); post-fix it does on the
    // second spawn.
    const emitScript =
      `process.stdout.write(JSON.stringify({` +
      `type:"result",` +
      `usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}` +
      `})+'\\n')`;

    class BudgetedWorker extends StreamJsonWorker {
      constructor(script: string) {
        super(script);
      }
    }
    const worker = new BudgetedWorker(emitScript);
    // Inject the budget — uses the same internal field
    (worker as unknown as { budgetTokensPerStory?: number }).budgetTokensPerStory = 20;

    // First spawn — under the budget, no exhaustion.
    const first = await (
      worker as unknown as {
        spawnAgent: (a: WorkerAssignment, p: string) => Promise<{ budgetExhausted?: boolean }>;
      }
    ).spawnAgent(assignment(), 'ignored');
    assert.equal(first.budgetExhausted, false);

    // Second spawn — cumulative crosses the cap, must trip the kill.
    const second = await (
      worker as unknown as {
        spawnAgent: (a: WorkerAssignment, p: string) => Promise<{ budgetExhausted?: boolean }>;
      }
    ).spawnAgent(assignment(), 'ignored');
    assert.equal(second.budgetExhausted, true, 'budget kill on cumulative > cap');
  });
});
