/**
 * Tests for per-phase timing instrumentation (story-063-003).
 *
 * Covers:
 *  - startPhase/endPhase stamps wallMs correctly via Date.now() delta (controlled clock)
 *  - All RunPhase enum values are supported (analyst, pm, architect, standalone_plan,
 *    dispatch, worker, gate, finalize)
 *  - Dispatch latency: markApproved→markFirstToken computes dispatchLatencyMs
 *  - markFirstToken without markApproved → dispatchLatencyMs stays undefined
 *  - endPhase without startPhase is a no-op (fail-open, never throws)
 *  - Clock source isolation: all Date.now() reads flow through RunMetricsCollector
 *  - Seam placement: analyst/pm/architect phases captured in Planner.run()
 *  - Seam placement: standalone_plan phase captured in StandaloneStoryAgent.run()
 *  - Seam placement: markApproved called in approveAndDispatch()
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunMetricsCollector } from '../RunMetricsCollector.js';
import { bindActiveCollector, clearActiveCollector } from '../activeCollector.js';
import { startPhase, endPhase } from '../timing.js';
import type { RunPhase } from '../types.js';
import { MockLLMClient } from '../../llm/MockLLMClient.js';
import type { LLMRequest } from '../../llm/LLMClient.js';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { Planner } from '../../planner/Planner.js';
import { StandaloneStoryAgent } from '../../planner/StandaloneStoryAgent.js';
import { approveAndDispatch } from '../../orchestrator/actions/approveAndDispatch.js';
import type { EffectiveRouting } from '../../intake/routing.js';
import type { Policy } from '../../types.js';

// ─── Controlled-clock unit tests ──────────────────────────────────────────────

const ALL_PHASES: RunPhase[] = [
  'analyst', 'pm', 'architect', 'standalone_plan',
  'dispatch', 'worker', 'gate', 'finalize',
];

describe('startPhase/endPhase — controlled clock stamps wallMs as Date.now() delta', () => {
  for (const phase of ALL_PHASES) {
    it(`wallMs for '${phase}' equals the injected Date.now() delta [AC1, AC4]`, (t) => {
      let fakeNow = 5000;
      t.mock.method(Date, 'now', () => fakeNow);

      const c = new RunMetricsCollector();
      bindActiveCollector(c);

      startPhase(phase);
      fakeNow = 5300;  // 300ms delta
      endPhase(phase);

      clearActiveCollector();

      const entry = c.build().phases.find((p) => p.phase === phase);
      assert.ok(entry, `phase '${phase}' must be present in build() output`);
      assert.equal(entry.wallMs, 300, `wallMs for '${phase}' must equal the injected 300ms delta`);
    });
  }

  it('wallMs is non-negative when start and end are called at the same tick [AC1]', (t) => {
    t.mock.method(Date, 'now', () => 9999);

    const c = new RunMetricsCollector();
    bindActiveCollector(c);
    startPhase('worker');
    endPhase('worker');
    clearActiveCollector();

    const entry = c.build().phases.find((p) => p.phase === 'worker');
    assert.ok(entry, 'worker phase must be present');
    assert.ok(entry.wallMs >= 0, 'wallMs must be non-negative even at same tick');
  });
});

// ─── Dispatch latency — controlled clock ──────────────────────────────────────

describe('Dispatch latency — markApproved/markFirstToken with controlled clock [AC2]', () => {
  it('dispatchLatencyMs equals firstToken - approved delta (controlled clock)', (t) => {
    let fakeNow = 1000;
    t.mock.method(Date, 'now', () => fakeNow);

    const c = new RunMetricsCollector();
    c.markApproved();
    fakeNow = 1450;  // 450ms later
    c.markFirstToken();

    const result = c.build();
    assert.equal(result.dispatchLatencyMs, 450, 'dispatchLatencyMs must equal 450ms delta');
  });

  it('markFirstToken without markApproved → dispatchLatencyMs is undefined (never negative) [AC2]', () => {
    const c = new RunMetricsCollector();
    c.markFirstToken();  // no prior markApproved
    const result = c.build();
    assert.equal(result.dispatchLatencyMs, undefined, 'dispatchLatencyMs must be undefined without markApproved');
  });

  it('dispatchLatencyMs is absent when neither markApproved nor markFirstToken is called [AC2]', () => {
    const c = new RunMetricsCollector();
    assert.equal(c.build().dispatchLatencyMs, undefined);
  });
});

// ─── endPhase fail-open ───────────────────────────────────────────────────────

describe('endPhase without startPhase is a no-op (fail-open) [AC3]', () => {
  it('endPhase on unstarted phase does not throw', () => {
    const c = new RunMetricsCollector();
    bindActiveCollector(c);
    assert.doesNotThrow(() => endPhase('gate'), 'endPhase with no matching startPhase must not throw');
    clearActiveCollector();
  });

  it('timing helper endPhase does not throw when no collector is bound [AC3]', () => {
    clearActiveCollector();
    assert.doesNotThrow(() => endPhase('finalize'), 'endPhase with no collector must not throw');
  });

  it('timing helper startPhase does not throw when no collector is bound [AC3]', () => {
    clearActiveCollector();
    assert.doesNotThrow(() => startPhase('dispatch'), 'startPhase with no collector must not throw');
  });
});

// ─── Clock source isolation ───────────────────────────────────────────────────

describe('Clock source isolation: all timing reads go through RunMetricsCollector [AC4]', () => {
  it('swapping Date.now mock between startPhase and endPhase affects wallMs correctly', (t) => {
    // This test documents the clock seam: only the collector calls Date.now().
    // Changing Date.now before endPhase sees the new value — the seam is isolated
    // to RunMetricsCollector. A swap to process.hrtime.bigint() only needs to
    // change the collector, not call sites.
    let fakeNow = 100;
    t.mock.method(Date, 'now', () => fakeNow);

    const c = new RunMetricsCollector();
    c.startPhase('analyst');
    fakeNow = 850;
    c.endPhase('analyst');

    const phase = c.build().phases.find((p) => p.phase === 'analyst')!;
    assert.equal(phase.wallMs, 750, 'clock is read at start and end by the collector');
  });
});

// ─── Seam placement: StandaloneStoryAgent.run() ───────────────────────────────

const STANDALONE_STORY_FIXTURE = JSON.stringify({
  id: 'story-001',
  title: 'Add login form',
  description: 'Build a minimal login form.',
  acceptance_criteria: ['The form submits credentials'],
  estimated_complexity: 'small',
  dependencies: [],
  tech_notes: 'Use existing AuthService.',
});

describe('Seam placement — StandaloneStoryAgent.run() wraps standalone_plan [AC1, AC3]', () => {
  it('standalone_plan phase has wallMs >= 0 after a successful run', async () => {
    const c = new RunMetricsCollector();
    bindActiveCollector(c);

    const llm = new MockLLMClient([
      '```json\n' + STANDALONE_STORY_FIXTURE + '\n```',
    ]);

    const ctx = {
      projectRoot: '/tmp',
      planningRoot: '/tmp/.loom/planning',
      llm,
      model: 'test-model',
      runId: 'story-001',
    };

    const agent = new StandaloneStoryAgent(ctx);
    await agent.run('Build a login form', 'story-001');

    clearActiveCollector();

    const phase = c.build().phases.find((p) => p.phase === 'standalone_plan');
    assert.ok(phase, 'standalone_plan phase must be present in collector output');
    assert.ok(phase.wallMs >= 0, 'wallMs must be non-negative');
  });

  it('standalone_plan phase is ended even when run() throws [AC3]', async () => {
    const c = new RunMetricsCollector();
    bindActiveCollector(c);

    // Bad LLM response that fails to parse — both attempts
    const llm = new MockLLMClient(['not json', 'not json either']);

    const ctx = {
      projectRoot: '/tmp',
      planningRoot: '/tmp/.loom/planning',
      llm,
      model: 'test-model',
      runId: 'story-001',
    };

    const agent = new StandaloneStoryAgent(ctx);
    await assert.rejects(() => agent.run('bad brief', 'story-001'));

    clearActiveCollector();

    const phase = c.build().phases.find((p) => p.phase === 'standalone_plan');
    assert.ok(phase, 'standalone_plan phase must appear even on failure (endPhase in finally)');
    assert.ok(phase.wallMs >= 0, 'wallMs must be non-negative even on failure path');
  });
});

// ─── Seam placement: approveAndDispatch marks the dispatch window start ────────

describe('Seam placement — approveAndDispatch() calls markApproved [AC2]', () => {
  let tmpDir: string;
  let db: import('better-sqlite3').Database;

  before(() => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-timing-approve-'));
    db = openDatabase(path.join(tmpDir, '.loom'));
    // Seed a 'planned' epic so updateStatus can transition it
    new EpicStore(db).beginPlanning('epic-001', 'test brief');
    new EpicStore(db).completePlanning('epic-001', 'Test Epic');
  });

  after(() => {
    db.close();
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('markApproved is called and dispatchLatencyMs can be computed after markFirstToken [AC2]', async () => {
    const c = new RunMetricsCollector();
    bindActiveCollector(c);

    const epicStore = new EpicStore(db);
    const auditLog = new AuditLog(db);
    const policy = {} as Policy;

    await approveAndDispatch(
      { epicStore, auditLog, policy },
      'epic-001',
      { actor: 'full-auto' },
    );

    // Simulate what story-063-004 does after worktree setup + first token
    c.markFirstToken();

    clearActiveCollector();

    const result = c.build();
    assert.ok(typeof result.dispatchLatencyMs === 'number', 'dispatchLatencyMs must be a number');
    assert.ok(result.dispatchLatencyMs >= 0, 'dispatchLatencyMs must be non-negative');
  });
});

// ─── Seam placement: Planner.run() wraps analyst/pm/architect ─────────────────

const ANALYST_BRIEF = '# Login Form\n\nAdd a simple email + password login form.';
const PM_PRD = '# Login PRD\n\n## Goals\nShip the login form.';
const ARCH_DOC = '# Architecture\n\n## Philosophy\nKeep it boring.';

function makeEpicsJson(epicId: string): string {
  const num = epicId.slice(5);
  return JSON.stringify({
    epics: [
      {
        epic_id: epicId,
        title: 'Epic title',
        priority: 'must-have',
        prd_ref: 'x',
        requirements: ['FR-1'],
        stories: [
          {
            id: `story-${num}-001`,
            title: 'First story',
            description: 'Do the thing.',
            acceptance_criteria: ['it works'],
            estimated_complexity: 'small',
            dependencies: [],
          },
        ],
      },
    ],
  });
}

function epicPipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('brief to analyze') || last.includes('Produce the project brief document')) return ANALYST_BRIEF;
  if (last.includes('Headless task A: produce the PRD')) return PM_PRD;
  if (last.includes('Headless task B: produce the epic')) return '```json\n' + makeEpicsJson('epic-001') + '\n```';
  if (last.includes('Headless task A: produce the architecture')) return ARCH_DOC;
  if (last.includes('Headless task B: produce per-story')) return '```json\n{"tech_notes":{}}\n```';
  throw new Error(`Unexpected planning message: ${last.slice(0, 80)}`);
}

function standalonePipelineResponder(req: LLMRequest): string {
  const last = req.messages[req.messages.length - 1].content;
  if (last.includes('brief to analyze') || last.includes('Produce the project brief document')) return ANALYST_BRIEF;
  if (last.includes('Produce a single story definition in JSON')) {
    const match = /Story id: "([^"]+)"/.exec(last);
    const sid = match?.[1] ?? 'story-001';
    const json = { ...JSON.parse(STANDALONE_STORY_FIXTURE), id: sid };
    return '```json\n' + JSON.stringify(json) + '\n```';
  }
  throw new Error(`Unexpected standalone planning message: ${last.slice(0, 80)}`);
}

describe('Seam placement — Planner.run() wraps analyst/pm/architect phases [AC1]', () => {
  let tmpDir: string;

  before(() => {
    resetDatabaseForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-timing-planner-'));
  });

  after(() => {
    resetDatabaseForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('epic path: analyst, pm, architect phases all have wallMs >= 0 in collector [AC1]', async () => {
    // withRunMetrics now wraps the epic path too (story-065-004), so all phase
    // data is persisted to run_metrics_phase. Verify via DB query (mirrors the
    // standalone test below), not via an external collector that would be
    // overwritten by withRunMetrics's internal bind.
    const db = openDatabase(path.join(tmpDir, '.loom'));
    const llm = new MockLLMClient(epicPipelineResponder);
    const planner = new Planner({ projectRoot: tmpDir, llm, model: 'mock', db });
    await planner.run('Add a login form.');

    const run = db
      .prepare('SELECT id FROM run_metrics WHERE scope = ?')
      .get('epic') as { id: number } | undefined;
    assert.ok(run, 'an epic run row must be persisted after Planner.run() on the epic path');

    const phases = db
      .prepare('SELECT phase, wall_ms FROM run_metrics_phase WHERE run_id = ? ORDER BY id ASC')
      .all(run.id) as { phase: string; wall_ms: number }[];

    for (const phase of ['analyst', 'pm', 'architect']) {
      const entry = phases.find((p) => p.phase === phase);
      assert.ok(entry, `'${phase}' phase must be present after epic pipeline run`);
      assert.ok(entry.wall_ms >= 0, `wall_ms for '${phase}' must be non-negative`);
    }
  });

  it('standalone path: analyst and standalone_plan phases are captured [AC1]', async () => {
    // Need fresh tmp dir + DB since openDatabase is a singleton per process
    const tmpStandalone = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-timing-standalone-'));
    try {
      resetDatabaseForTest();
      const db = openDatabase(path.join(tmpStandalone, '.loom'));
      const llm = new MockLLMClient(standalonePipelineResponder);
      const routing: EffectiveRouting = { type: 'feature', size: 'story', confidence: 'high', source: 'classifier' };
      const planner = new Planner({ projectRoot: tmpStandalone, llm, model: 'mock', db, routing });
      await planner.run('Add a login form.');

      // withRunMetrics wraps the entire standalone run (including the Analyst phase),
      // so all phase data is persisted to run_metrics_phase. Verify via raw DB query.
      const run = db
        .prepare('SELECT id FROM run_metrics WHERE scope = ?')
        .get('standalone_story') as { id: number } | undefined;
      assert.ok(run, 'a standalone_story run row must be persisted');

      const phases = db
        .prepare('SELECT phase, wall_ms FROM run_metrics_phase WHERE run_id = ? ORDER BY id ASC')
        .all(run.id) as { phase: string; wall_ms: number }[];

      for (const phaseName of ['analyst', 'standalone_plan']) {
        const entry = phases.find((p) => p.phase === phaseName);
        assert.ok(entry, `'${phaseName}' phase must be present after standalone run`);
        assert.ok(entry.wall_ms >= 0, `wall_ms for '${phaseName}' must be non-negative`);
      }

      // pm and architect must NOT be present on standalone path
      assert.ok(!phases.find((p) => p.phase === 'pm'), 'pm phase must not appear on standalone path');
      assert.ok(!phases.find((p) => p.phase === 'architect'), 'architect phase must not appear on standalone path');
    } finally {
      resetDatabaseForTest();
      fs.rmSync(tmpStandalone, { recursive: true, force: true });
    }
  });
});
