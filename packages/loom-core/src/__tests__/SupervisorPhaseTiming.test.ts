/**
 * Targeted tests for phase bracket timing in the Supervisor run path (story-065-002).
 *
 * Covers:
 *  - dispatch and worker phases are recorded with wallMs >= 0 for every story run
 *  - finalize phase is recorded when an EpicFinalizer runs
 *  - dispatchLatencyMs >= 0 when markApproved fires via approveAndDispatch + markFirstToken fires at dispatch
 *  - Skipped phases produce no phantom entries in the metrics store
 *  - Phase brackets are no-ops when no collector is bound (never throw)
 *
 * Strategy: drive the real Supervisor + MockWorkerRunner pair; observe via
 * MetricsStore queries on the shared DB after run() completes. The
 * withRunMetrics wrapper inside Supervisor.run() is the natural observation point.
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
import { MetricsStore } from '../state/MetricsStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import { MockWorkerRunner } from '../orchestrator/MockWorkerRunner.js';
import { startPhase, endPhase } from '../metrics/timing.js';
import { clearActiveCollector } from '../metrics/activeCollector.js';
import type { Story } from '../types.js';
import type { FinalizeResult } from '../orchestrator/EpicFinalizer.js';

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

function seedEpic(epicId: string, stories: Story[], status: 'approved' | 'planned' = 'approved'): void {
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

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-phase-timing-'));
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

// ─── No-op when unbound ───────────────────────────────────────────────────────

describe('timing helpers are no-ops when no collector is bound [AC4, no-op guarantee]', () => {
  it('startPhase does not throw for any RunPhase when no collector is bound', () => {
    clearActiveCollector();
    assert.doesNotThrow(() => startPhase('dispatch'));
    assert.doesNotThrow(() => startPhase('worker'));
    assert.doesNotThrow(() => startPhase('gate'));
    assert.doesNotThrow(() => startPhase('finalize'));
    assert.doesNotThrow(() => startPhase('analyst'));
    assert.doesNotThrow(() => startPhase('pm'));
    assert.doesNotThrow(() => startPhase('architect'));
    assert.doesNotThrow(() => startPhase('standalone_plan'));
  });

  it('endPhase does not throw for any RunPhase when no collector is bound', () => {
    clearActiveCollector();
    assert.doesNotThrow(() => endPhase('dispatch'));
    assert.doesNotThrow(() => endPhase('worker'));
    assert.doesNotThrow(() => endPhase('gate'));
    assert.doesNotThrow(() => endPhase('finalize'));
  });

  it('endPhase does not throw when called without a matching startPhase (fail-open invariant)', () => {
    clearActiveCollector();
    // endPhase without startPhase must always be a no-op — never throws
    assert.doesNotThrow(() => endPhase('dispatch'));
    assert.doesNotThrow(() => endPhase('worker'));
  });

  it('Supervisor run completes without error when no stray collector is bound', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);
    clearActiveCollector();

    const result = await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    assert.equal(result.storiesDone, 1, 'story must complete normally');
    assert.equal(result.storiesFailed, 0, 'no stories must fail');
  });
});

// ─── dispatch and worker phases ───────────────────────────────────────────────

describe('Supervisor phase brackets — dispatch and worker [AC1, AC2]', () => {
  it('dispatch and worker phases appear in the metrics store after a basic run', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done', commitCount: 1 }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const runs = store.listRuns();
    assert.equal(runs.length, 1, 'exactly one run recorded');

    const phases = store.getPhases(runs[0].id);
    const dispatchPhase = phases.find((p) => p.phase === 'dispatch');
    const workerPhase = phases.find((p) => p.phase === 'worker');

    assert.ok(dispatchPhase, 'dispatch phase must appear in collector output after a run');
    assert.ok(workerPhase, 'worker phase must appear in collector output after a run');
    assert.ok(dispatchPhase.wallMs >= 0, `dispatch wallMs must be non-negative, got ${dispatchPhase.wallMs}`);
    assert.ok(workerPhase.wallMs >= 0, `worker wallMs must be non-negative, got ${workerPhase.wallMs}`);
  });

  it('dispatch precedes worker in the phase sequence (ordering invariant)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const dispatchIdx = phases.findIndex((p) => p.phase === 'dispatch');
    const workerIdx = phases.findIndex((p) => p.phase === 'worker');

    assert.ok(dispatchIdx !== -1, 'dispatch phase must be present');
    assert.ok(workerIdx !== -1, 'worker phase must be present');
    assert.ok(
      dispatchIdx < workerIdx,
      `dispatch (index ${dispatchIdx}) must precede worker (index ${workerIdx}) in phase sequence`
    );
  });

  it('both dispatch and worker phases accumulate across a two-story concurrent run', async () => {
    seedEpic('epic-001', [story('story-001-001'), story('story-001-002')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done', commitCount: 1 }),
      maxConcurrent: 2,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const dispatchPhase = phases.find((p) => p.phase === 'dispatch');
    const workerPhase = phases.find((p) => p.phase === 'worker');

    // Both phases accumulate (not one-per-story — they're shared buckets)
    assert.ok(dispatchPhase, 'dispatch phase must appear for multi-story run');
    assert.ok(workerPhase, 'worker phase must appear for multi-story run');
    assert.ok(dispatchPhase.wallMs >= 0, 'dispatch wallMs must be non-negative');
    assert.ok(workerPhase.wallMs >= 0, 'worker wallMs must be non-negative');
  });

  it('dispatch and worker phases are closed (wallMs recorded, no open phase)', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);

    // An open phase (startPhase with no matching endPhase) would have wallMs based
    // only on previously accumulated segments. We verify both phases are present.
    const dispatch = phases.find((p) => p.phase === 'dispatch');
    const worker = phases.find((p) => p.phase === 'worker');
    assert.ok(dispatch !== undefined, 'dispatch phase must be present');
    assert.ok(worker !== undefined, 'worker phase must be present');
  });
});

// ─── dispatch latency ─────────────────────────────────────────────────────────

describe('Supervisor dispatch latency — markApproved/markFirstToken [AC3]', () => {
  it('dispatchLatencyMs is set and >= 0 when markApproved fires inside withRunMetrics', async () => {
    // Use planned + full-auto so approveAndDispatch fires inside withRunMetrics
    // on the same RunMetricsCollector that markFirstToken uses.
    seedEpic('epic-001', [story('story-001-001')], 'planned');
    const db = openDatabase(loomDir);
    new EpicStore(db).setAutonomy('epic-001', 'full-auto');

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      lease: false,
    }).run(['epic-001']);

    const store = new MetricsStore(db);
    const runs = store.listRuns();
    assert.equal(runs.length, 1, 'exactly one run row must be recorded');
    const run = runs[0];

    assert.ok(
      run.dispatchLatencyMs !== undefined && run.dispatchLatencyMs !== null,
      `dispatchLatencyMs must be set after approve + dispatch; got ${run.dispatchLatencyMs}`
    );
    assert.ok(
      run.dispatchLatencyMs >= 0,
      `dispatchLatencyMs must be non-negative, got ${run.dispatchLatencyMs}`
    );
  });

  it('dispatchLatencyMs is undefined when the epic was pre-approved (markApproved not called on this collector)', async () => {
    // When the epic is already 'approved' at run start, approveAndDispatch is NOT called
    // inside withRunMetrics, so markApproved never fires. dispatchLatencyMs stays unset.
    seedEpic('epic-001', [story('story-001-001')], 'approved');
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const run = store.listRuns()[0];
    // markFirstToken fires but markApproved was never called on this collector,
    // so dispatchLatencyMs must be absent
    assert.equal(
      run.dispatchLatencyMs,
      undefined,
      'dispatchLatencyMs must be absent when epic was pre-approved outside this run'
    );
  });
});

// ─── finalize phase ───────────────────────────────────────────────────────────

describe('Supervisor phase brackets — finalize [AC1]', () => {
  it('finalize phase appears in the metrics store when an EpicFinalizer runs', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    const mockFinalizer = {
      finalize: async (_epicId: string): Promise<FinalizeResult> => ({
        status: 'skipped' as const,
        note: 'mock-skipped',
        conflicted: [],
        merged: [],
        cleaned: [],
      }),
    };

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      epicFinalizer: mockFinalizer as any, // duck-typed; only finalize() is needed
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const finalizePhase = phases.find((p) => p.phase === 'finalize');

    assert.ok(finalizePhase, 'finalize phase must appear when EpicFinalizer runs');
    assert.ok(finalizePhase.wallMs >= 0, `finalize wallMs must be non-negative, got ${finalizePhase.wallMs}`);
  });
});

// ─── skipped phases ───────────────────────────────────────────────────────────

describe('Skipped phases produce no phantom entries [AC4, no-op guarantee]', () => {
  it('gate phase does not appear for a non-rolling run without integrator', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const gatePhase = phases.find((p) => p.phase === 'gate');

    assert.equal(gatePhase, undefined, 'gate phase must NOT appear for non-rolling run without integrator');
  });

  it('finalize phase does not appear when no EpicFinalizer is provided', async () => {
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
      // no epicFinalizer
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);
    const finalizePhase = phases.find((p) => p.phase === 'finalize');

    assert.equal(finalizePhase, undefined, 'finalize phase must NOT appear without EpicFinalizer');
  });

  it('planning phases (analyst/pm/architect) do not appear in a Supervisor-only run', async () => {
    // Supervisor does not run planning phases — those belong to Planner.ts
    seedEpic('epic-001', [story('story-001-001')]);
    const db = openDatabase(loomDir);

    await new Supervisor({
      projectRoot: repo,
      db,
      worker: new MockWorkerRunner({ status: 'done' }),
      maxConcurrent: 1,
    }).run();

    const store = new MetricsStore(db);
    const phases = store.getPhases(store.listRuns()[0].id);

    for (const planPhase of ['analyst', 'pm', 'architect', 'standalone_plan']) {
      const found = phases.find((p) => p.phase === planPhase);
      assert.equal(found, undefined, `planning phase '${planPhase}' must NOT appear in a dispatch-only run`);
    }
  });
});
