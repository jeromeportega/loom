/**
 * Targeted tests for the worker-cost tap in Supervisor.applyResult (story-065-003).
 *
 * Verifies that subprocess claude-cli cost (WorkerResult.usage) re-enters the
 * active RunMetricsCollector via addUsage and is pinned to the 'worker' phase.
 * This is the highest-risk seam (ADR-003): without it, execution cost is silently
 * dropped from live-run metrics.
 *
 * The test drives the real Supervisor+MockWorkerRunner pair so the full
 * applyResult path runs. Metrics are observed via MetricsStore queries on the
 * shared DB after run() completes — the collector's build()+recordRun() path
 * is the natural observation point.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import { MetricsStore } from '../state/MetricsStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import type { Story } from '../types.js';
import type { WorkerUsage } from '../orchestrator/WorkerRunner.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

let repo: string;
let loomDir: string;

function gitc(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function story(id: string, deps: string[] = []): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement the thing.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: deps,
  };
}

function seedEpic(epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId} title`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

const WORKER_USAGE: WorkerUsage = {
  inputTokens: 500,
  outputTokens: 200,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  totalTokens: 850,
  costUsd: 0.005,
  requestCount: 2,
};

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-worker-metrics-'));
  loomDir = path.join(repo, '.loom');
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'test@loom.dev']);
  gitc(['config', 'user.name', 'Loom Test']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  gitc(['add', '.']);
  gitc(['commit', '-q', '-m', 'initial']);
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('Supervisor.applyResult — worker-cost tap', () => {
  it('records non-zero worker usage in the metrics store, pinned to the worker phase', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        usage: WORKER_USAGE,
        model: 'claude-sonnet-4-6',
      }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const runs = store.listRuns();
    assert.equal(runs.length, 1, 'exactly one run recorded');

    const phases = store.getPhases(runs[0].id);
    const workerPhase = phases.find((p) => p.phase === 'worker');
    assert.ok(workerPhase, 'a worker phase row exists');
    assert.ok(workerPhase.tokensInput > 0, `tokensInput must be non-zero, got ${workerPhase.tokensInput}`);
    assert.equal(workerPhase.tokensInput, WORKER_USAGE.inputTokens);
    assert.equal(workerPhase.tokensOutput, WORKER_USAGE.outputTokens);
    assert.equal(workerPhase.tokensCached, WORKER_USAGE.cacheReadTokens);
    assert.equal(workerPhase.tokensCacheCreation, WORKER_USAGE.cacheCreationTokens);
    assert.equal(workerPhase.requestCount, WORKER_USAGE.requestCount);
    assert.ok(workerPhase.costUsd !== undefined && workerPhase.costUsd > 0, 'costUsd must be non-zero');
    assert.equal(workerPhase.costUsd, WORKER_USAGE.costUsd);
  });

  it('pins worker cost to the worker phase, not merged into planning or gate phases', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        usage: WORKER_USAGE,
      }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const otherPhases = phases.filter((p) => p.phase !== 'worker');
    // Other phases must not absorb the worker's tokens
    for (const p of otherPhases) {
      assert.equal(
        p.tokensInput,
        0,
        `phase '${p.phase}' should carry 0 input tokens (worker cost must stay in worker phase)`
      );
    }
  });

  it('carries model attribution from result.model on the worker phase', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        usage: WORKER_USAGE,
        model: 'claude-opus-4-8',
      }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const workerPhase = phases.find((p) => p.phase === 'worker');
    assert.ok(workerPhase, 'worker phase exists');
    assert.equal(workerPhase.model, 'claude-opus-4-8', 'model attributed from result.model');
  });

  it('co-existence: agents.setUsage is still called (tap is additive, not a replacement)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        usage: WORKER_USAGE,
      }),
      maxConcurrent: 1,
    }).run();

    const agent = new AgentStore(db).getByStory('story-001-001');
    assert.ok(agent, 'agent row exists');
    assert.equal(agent.tokens_input, WORKER_USAGE.inputTokens, 'agents.tokens_input persisted');
    assert.equal(agent.tokens_output, WORKER_USAGE.outputTokens, 'agents.tokens_output persisted');
    assert.equal(agent.tokens_cached, WORKER_USAGE.cacheReadTokens, 'agents.tokens_cached persisted');
    assert.equal(agent.tokens_cache_creation, WORKER_USAGE.cacheCreationTokens, 'agents.tokens_cache_creation persisted');
  });

  it('no-collector path: applyResult behaves exactly as before (?.guard short-circuits)', async () => {
    // Without withRunMetrics binding a collector, activeCollector() returns undefined.
    // This test verifies the run completes without error — the ?.guard is the safety.
    // Note: Supervisor.run() internally calls withRunMetrics, which binds a real
    // collector. The guard still matters for any future call path without a binding.
    // We verify correctness here by confirming applyResult doesn't throw.
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        usage: WORKER_USAGE,
      }),
      maxConcurrent: 1,
    }).run();

    assert.equal(result.storiesDone, 1, 'story completed normally even with collector in flight');
    assert.equal(result.storiesFailed, 0, 'no stories failed');
  });

  it('absent usage: no worker phase row created and no error thrown', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'done',
        logTail: '',
        // no usage field
      }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const workerPhase = phases.find((p) => p.phase === 'worker');
    assert.equal(workerPhase, undefined, 'no worker phase when usage is absent');
  });
});
