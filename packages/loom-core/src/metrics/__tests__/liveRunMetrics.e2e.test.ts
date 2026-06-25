/**
 * End-to-end test: a real Supervisor run populates the run_metrics store
 * including worker execution cost (story-065-005).
 *
 * Drives real flows through the existing orchestrator test seam
 * (Supervisor.run() → planning + dispatch + gate + finalize) for both an
 * epic run and a standalone-story run. Asserts the persisted run_metrics row
 * has correct scope, attribution, per-phase cost/wall-clock, dispatch latency,
 * and non-zero worker-phase cost (the ADR-003 regression guard).
 *
 * Also verifies that MetricsStore.listRuns() returns the recorded runs
 * (the loom cost surface — no longer 'No metrics recorded yet').
 *
 * The existing byte-for-byte observe-only test (observeOnly.test.ts) passes
 * unchanged, proving this wiring changed no orchestration behavior (NFR-1).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { MetricsStore } from '../../state/MetricsStore.js';
import { Supervisor } from '../../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../../orchestrator/MockWorkerRunner.js';
import { clearActiveCollector } from '../activeCollector.js';
import type { Story } from '../../types.js';
import type { WorkerUsage } from '../../orchestrator/WorkerRunner.js';

// ─── Worker usage fixture with non-zero cost ──────────────────────────────────
// Non-zero costUsd is the dedicated guard against the ADR-003 regression where
// subprocess execution cost is silently dropped from the collector.
const WORKER_USAGE: WorkerUsage = {
  inputTokens: 500,
  outputTokens: 200,
  cacheReadTokens: 100,
  cacheCreationTokens: 50,
  totalTokens: 850,
  costUsd: 0.005,
  requestCount: 2,
};

// ─── Test infrastructure ──────────────────────────────────────────────────────

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

/** Seeds an epic into the temp repo and the shared DB. */
function seedEpic(
  epicId: string,
  stories: Story[],
  status: 'approved' | 'planned' = 'approved',
): void {
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
  if (status === 'approved') {
    store.updateStatus(epicId, 'approved');
  }
  // 'planned' stays as-is — caller sets autonomy before running
}

/**
 * Seeds a standalone-story epic into the temp repo and the shared DB.
 * Uses a story-NNN id so the Supervisor derives scope='standalone_story'.
 */
function seedStandalone(storyId: string): void {
  const epicYaml = {
    epic_id: storyId,
    title: `Standalone ${storyId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'brief',
    requirements: [],
    stories: [
      {
        id: storyId,
        title: `Story ${storyId}`,
        description: 'The standalone thing.',
        acceptance_criteria: ['it works'],
        estimated_complexity: 'small',
        dependencies: [],
      },
    ],
  };
  const rel = `.loom/planning/${storyId}/epics/${storyId}.yaml`;
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.createStandalone(storyId, epicYaml.title);
  store.updatePaths(storyId, { yaml_path: rel });
  // status='planned' so full-auto autonomy fires approveAndDispatch inside withRunMetrics
}

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-live-metrics-'));
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
  clearActiveCollector();
  resetDatabaseForTest();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── Epic dispatch path ───────────────────────────────────────────────────────

describe('live run metrics — epic dispatch path [AC1, AC2, AC3]', () => {
  it('persists exactly one run_metrics row with correct scope and attribution', async () => {
    // planned + full-auto so approveAndDispatch fires inside withRunMetrics,
    // enabling markApproved → markFirstToken → dispatchLatencyMs to be set.
    seedEpic('epic-001', [story('story-001-001')], 'planned');
    const db = openDatabase(loomDir);
    new EpicStore(db).setAutonomy('epic-001', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'completed',
        logTail: '',
        usage: WORKER_USAGE,
        model: 'claude-sonnet-4-6',
      }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    const store = new MetricsStore(db);
    const runs = store.listRuns();

    // Exactly one row persisted via recordRun (inside withRunMetrics)
    assert.equal(runs.length, 1, 'exactly one run_metrics row must be persisted via recordRun');

    const run = runs[0];

    // Correct scope
    assert.equal(run.scope, 'epic', 'scope must be epic for Supervisor dispatch of an epic');

    // Correct attribution: epicId, verdict, counts, outcome
    assert.equal(run.epicId, 'epic-001', 'epicId must be set for the epic dispatch path');
    assert.equal(run.storyId, undefined, 'storyId must be absent for the epic path');
    assert.equal(run.intakeVerdict, 'epic', 'intakeVerdict must be epic on the epic dispatch path');
    assert.equal(run.storyCount, 1, 'storyCount must be 1');
    assert.equal(run.outcome, 'done', 'outcome must be done when all stories succeed');
    assert.equal(run.retryCount, 0, 'retryCount must be 0 for a fresh first run');
    assert.equal(run.cleanRetryCount, 0, 'cleanRetryCount must be 0');
    assert.equal(run.autoRecoveryCount, 0, 'autoRecoveryCount must be 0');
    assert.ok(run.startedAt !== undefined, 'startedAt must be set');
    assert.ok(run.endedAt !== undefined, 'endedAt must be set');

    // Dispatch latency: set by markApproved (in approveAndDispatch) + markFirstToken (at dispatch)
    assert.ok(
      run.dispatchLatencyMs !== undefined && run.dispatchLatencyMs >= 0,
      `dispatchLatencyMs must be set and non-negative; got ${run.dispatchLatencyMs}`,
    );
  });

  it('records dispatch and worker phases with non-zero worker cost [AC4 — ADR-003 regression guard]', async () => {
    seedEpic('epic-001', [story('story-001-001')], 'planned');
    const db = openDatabase(loomDir);
    new EpicStore(db).setAutonomy('epic-001', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'completed',
        logTail: '',
        usage: WORKER_USAGE,
        model: 'claude-sonnet-4-6',
      }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);

    // Per-phase wall_ms is non-negative for every phase
    assert.ok(phases.length > 0, 'at least one phase row must be present');
    for (const p of phases) {
      assert.ok(
        p.wallMs >= 0,
        `phase '${p.phase}' wallMs must be non-negative; got ${p.wallMs}`,
      );
    }

    // dispatch phase is present (story-065-002)
    const dispatchPhase = phases.find((p) => p.phase === 'dispatch');
    assert.ok(dispatchPhase !== undefined, 'dispatch phase must be present');
    assert.ok(dispatchPhase.wallMs >= 0, `dispatch wallMs non-negative; got ${dispatchPhase.wallMs}`);

    // worker phase with non-zero cost — the core ADR-003 regression guard
    const workerPhase = phases.find((p) => p.phase === 'worker');
    assert.ok(workerPhase !== undefined, 'worker phase must be present');
    assert.ok(
      workerPhase.costUsd !== undefined && workerPhase.costUsd > 0,
      `worker phase costUsd must be non-zero (ADR-003 guard); got ${workerPhase.costUsd}`,
    );
    assert.equal(
      workerPhase.costUsd,
      WORKER_USAGE.costUsd,
      'worker phase costUsd must match the fixture',
    );
    assert.equal(workerPhase.tokensInput, WORKER_USAGE.inputTokens);
    assert.equal(workerPhase.tokensOutput, WORKER_USAGE.outputTokens);
    assert.equal(workerPhase.tokensCached, WORKER_USAGE.cacheReadTokens);
    assert.equal(workerPhase.tokensCacheCreation, WORKER_USAGE.cacheCreationTokens);
    assert.equal(workerPhase.requestCount, WORKER_USAGE.requestCount);
  });
});

// ─── Standalone dispatch path ─────────────────────────────────────────────────

describe('live run metrics — standalone-story dispatch path [AC1, AC2, AC3]', () => {
  it('persists exactly one run_metrics row with scope=standalone_story and correct attribution', async () => {
    seedStandalone('story-001');
    const db = openDatabase(loomDir);
    new EpicStore(db).setAutonomy('story-001', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        commitCount: 1,
        summary: 'completed',
        logTail: '',
        usage: WORKER_USAGE,
        model: 'claude-sonnet-4-6',
      }),
      maxConcurrent: 1,
      lease: false,
    }).run(['story-001']);

    const store = new MetricsStore(db);
    const runs = store.listRuns();

    // Exactly one row
    assert.equal(runs.length, 1, 'exactly one run_metrics row for standalone dispatch');

    const run = runs[0];

    // Correct scope: standalone_story (story-NNN id triggers this in Supervisor.run)
    assert.equal(run.scope, 'standalone_story', 'scope must be standalone_story');

    // storyId set, epicId absent for the standalone path
    assert.equal(run.storyId, 'story-001', 'storyId must be set for standalone dispatch');
    assert.equal(run.epicId, undefined, 'epicId must be absent for standalone dispatch');

    // Attribution
    assert.equal(run.intakeVerdict, 'story', 'intakeVerdict must be story for standalone dispatch');
    assert.equal(run.storyCount, 1, 'storyCount must be 1 for a standalone story');
    assert.equal(run.outcome, 'done', 'outcome must be done when the story succeeds');
    assert.equal(run.retryCount, 0, 'retryCount must be 0 for a fresh run');
    assert.equal(run.cleanRetryCount, 0);
    assert.equal(run.autoRecoveryCount, 0);

    // Dispatch latency set via markApproved + markFirstToken (full-auto path)
    assert.ok(
      run.dispatchLatencyMs !== undefined && run.dispatchLatencyMs >= 0,
      `dispatchLatencyMs must be set; got ${run.dispatchLatencyMs}`,
    );

    // Per-phase wall_ms
    const phases = store.getPhases(run.id);
    assert.ok(phases.length > 0, 'at least one phase must be present');
    for (const p of phases) {
      assert.ok(p.wallMs >= 0, `phase '${p.phase}' wallMs non-negative; got ${p.wallMs}`);
    }

    // Non-zero worker cost (ADR-003 regression guard on the standalone path)
    const workerPhase = phases.find((p) => p.phase === 'worker');
    assert.ok(workerPhase !== undefined, 'worker phase must be present for standalone dispatch');
    assert.ok(
      workerPhase.costUsd !== undefined && workerPhase.costUsd > 0,
      `worker phase costUsd must be non-zero on the standalone path; got ${workerPhase.costUsd}`,
    );
    assert.equal(workerPhase.costUsd, WORKER_USAGE.costUsd);
  });
});

// ─── loom cost surface ────────────────────────────────────────────────────────

describe('loom cost surface — MetricsStore.listRuns reports recorded runs [AC5]', () => {
  it('after both an epic and a standalone run, listRuns returns ≥2 rows (not the empty branch)', async () => {
    // Run 1: epic dispatch
    seedEpic('epic-001', [story('story-001-001')], 'planned');
    const db = openDatabase(loomDir);
    const epicStore = new EpicStore(db);
    epicStore.setAutonomy('epic-001', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        usage: WORKER_USAGE,
      }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    // Run 2: standalone dispatch (same repo, same db)
    seedStandalone('story-002');
    epicStore.setAutonomy('story-002', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({
        status: 'done',
        usage: WORKER_USAGE,
      }),
      maxConcurrent: 1,
      lease: false,
    }).run(['story-002']);

    const store = new MetricsStore(db);
    const runs = store.listRuns();

    // loom cost shows runs when runs.length > 0 (not 'No metrics recorded yet')
    assert.ok(
      runs.length >= 2,
      `loom cost must report recorded runs (not 'No metrics recorded yet'); got ${runs.length} rows`,
    );
    assert.ok(
      runs.some((r) => r.scope === 'epic'),
      'must include an epic-scope run for loom cost output',
    );
    assert.ok(
      runs.some((r) => r.scope === 'standalone_story'),
      'must include a standalone_story-scope run for loom cost output',
    );

    // Both runs have non-zero worker cost (no silent drop on either path)
    for (const run of runs) {
      const phases = store.getPhases(run.id);
      const workerPhase = phases.find((p) => p.phase === 'worker');
      assert.ok(workerPhase !== undefined, `worker phase must exist for run #${run.id}`);
      assert.ok(
        workerPhase.costUsd !== undefined && workerPhase.costUsd > 0,
        `worker costUsd must be non-zero in run #${run.id} (scope=${run.scope})`,
      );
    }
  });
});
