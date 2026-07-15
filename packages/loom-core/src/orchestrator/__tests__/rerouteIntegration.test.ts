/**
 * story-095-005: Supervisor runtime reroute-to-PM re-decomposition.
 *
 * Integration tests: LOOM_TOO_BIG signal reroute, cap-kill reroute,
 * sub-story dispatch, downstream re-pointing, budget enforcement.
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
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { Supervisor } from '../Supervisor.js';
import { MockWorkerRunner } from '../MockWorkerRunner.js';
import { MAX_RESPLIT_BUDGET, LOOM_TOO_BIG_SIGNAL } from '../constants.js';
import type { PMAgent } from '../rerouteHandler.js';
import type { Story } from '../../types.js';
import type { WorkerEvent } from '../WorkerRunner.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gitc(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): string {
  gitc(['init', '-q'], dir);
  gitc(['config', 'user.email', 'test@loom.dev'], dir);
  gitc(['config', 'user.name', 'Loom Test'], dir);
  gitc(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  gitc(['add', '.'], dir);
  gitc(['commit', '-q', '-m', 'initial'], dir);
  return fs.realpathSync(dir);
}

function makeStory(id: string, overrides: Partial<Story> = {}): Story {
  return {
    id,
    title: `Story ${id}`,
    description: 'Implement it.',
    acceptance_criteria: ['it works'],
    estimated_complexity: 'small',
    dependencies: [],
    ...overrides,
  };
}

function seedEpic(repoDir: string, epicId: string, stories: Story[]): void {
  const epicYaml = {
    epic_id: epicId,
    title: `Epic ${epicId}`,
    status: 'planned',
    priority: 'must-have',
    prd_ref: 'x',
    requirements: ['FR-1'],
    stories,
  };
  const rel = `.loom/planning/${epicId}/epics/${epicId}.yaml`;
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, yaml.dump(epicYaml));

  const db = openDatabase(path.join(repoDir, '.loom'));
  const store = new EpicStore(db);
  store.create(epicId, epicYaml.title, rel);
  store.updateStatus(epicId, 'approved');
}

function makePMAgent(subStories: Story[]): PMAgent {
  return {
    async decompose(): Promise<Story[]> {
      return subStories;
    },
  };
}

// ─── Test state ───────────────────────────────────────────────────────────────

let repoDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ri-'));
  initRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  resetDatabaseForTest();
});

// ─── AC-1/AC-2: LOOM_TOO_BIG signal reroute ──────────────────────────────────

describe('Supervisor reroute — LOOM_TOO_BIG signal (AC-1, AC-6)', () => {
  it('[Happy] worker emits LOOM_TOO_BIG → supervisor reroutes to PM, sub-stories dispatched', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const sub1 = makeStory('story-001-001a', { title: 'Sub A' });
    const sub2 = makeStory('story-001-001b', { title: 'Sub B' });
    const pm = makePMAgent([sub1, sub2]);

    let workerCallCount = 0;
    const worker = new MockWorkerRunner((assignment) => {
      workerCallCount++;
      if (assignment.storyId === 'story-001-001') {
        // Emit LOOM_TOO_BIG signal via logTail (MockWorkerRunner uses logTail)
        return {
          status: 'failed' as const,
          commitCount: 0,
          summary: 'too big',
          logTail: `Did some work.\n${LOOM_TOO_BIG_SIGNAL} needs to be split\n`,
          killReason: undefined,
        };
      }
      // sub-stories succeed
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const events: WorkerEvent[] = [];
    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 3,
      lease: false,
      pmAgent: pm,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    // Both sub-stories should be dispatched and completed
    assert.strictEqual(result.storiesDone, 2, 'both sub-stories completed');

    // A rerouted event must have been emitted (AC-6)
    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }> | undefined;
    assert.ok(reroutedEvent, 'rerouted event emitted');
    assert.strictEqual(reroutedEvent!.storyId, 'story-001-001');
    assert.deepStrictEqual(reroutedEvent!.subStoryIds, ['story-001-001a', 'story-001-001b']);
    assert.strictEqual(reroutedEvent!.trigger, 'LOOM_TOO_BIG');

    // sub-story agent rows must exist in DB
    const agents = new AgentStore(db);
    const rowA = agents.getByStory('story-001-001a');
    const rowB = agents.getByStory('story-001-001b');
    assert.ok(rowA, 'agent row for sub-a');
    assert.ok(rowB, 'agent row for sub-b');
    assert.strictEqual(rowA!.status, 'done');
    assert.strictEqual(rowB!.status, 'done');

    // resplit_count incremented on original's agent row
    const origRow = agents.getByStory('story-001-001');
    assert.ok(origRow, 'original agent row exists');
    assert.strictEqual(origRow!.resplit_count, 1, 'resplit_count=1 after first reroute');
  });
});

// ─── AC-3: cap-kill reroute ───────────────────────────────────────────────────

describe('Supervisor reroute — absoluteCapMs cap kill (AC-3)', () => {
  it('[Happy] cap-killed story → supervisor reroutes, sub-stories dispatched, checkpointUncommitted NOT called', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const sub1 = makeStory('story-001-001a');
    const sub2 = makeStory('story-001-001b');
    const pm = makePMAgent([sub1, sub2]);

    const worker = new MockWorkerRunner((assignment) => {
      if (assignment.storyId === 'story-001-001') {
        // Simulate a cap kill — no LOOM_TOO_BIG signal, just a killReason
        return {
          status: 'failed' as const,
          commitCount: 0,
          summary: 'hit absoluteCapMs',
          logTail: 'Was working hard...',
          killReason: 'cap' as const,
        };
      }
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const events: WorkerEvent[] = [];
    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 3,
      lease: false,
      pmAgent: pm,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 2, 'both sub-stories completed');

    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }> | undefined;
    assert.ok(reroutedEvent, 'rerouted event emitted for cap kill');
    assert.strictEqual(reroutedEvent!.trigger, 'cap');
  });

  it('[Boundary] cap kill without pmAgent configured → story stays failed (no reroute)', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const worker = new MockWorkerRunner({
      status: 'failed',
      commitCount: 0,
      summary: 'hit cap',
      logTail: '',
      killReason: 'cap',
    });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      // No pmAgent
    });

    const result = await supervisor.run(['epic-001']);
    assert.strictEqual(result.storiesFailed, 1, 'story stays failed without pmAgent');
    assert.strictEqual(result.storiesDone, 0);
  });
});

// ─── AC-4: downstream re-pointing ─────────────────────────────────────────────

describe('Supervisor reroute — downstream re-pointing (AC-4)', () => {
  it('[Happy] downstream story depends on original → re-pointed to final sub-story', async () => {
    const original = makeStory('story-001-001');
    const downstream = makeStory('story-001-002', { dependencies: ['story-001-001'] });
    seedEpic(repoDir, 'epic-001', [original, downstream]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const sub1 = makeStory('story-001-001a');
    const sub2 = makeStory('story-001-001b'); // final sub-story — downstream re-points here
    const pm = makePMAgent([sub1, sub2]);

    const dispatchOrder: string[] = [];
    const worker = new MockWorkerRunner((assignment) => {
      dispatchOrder.push(assignment.storyId);
      if (assignment.storyId === 'story-001-001') {
        return {
          status: 'failed' as const,
          commitCount: 0,
          summary: 'too big',
          logTail: `${LOOM_TOO_BIG_SIGNAL}\n`,
          killReason: undefined,
        };
      }
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 4,
      lease: false,
      pmAgent: pm,
    });

    const result = await supervisor.run(['epic-001']);

    // All three successor stories dispatched: story-001-001a, story-001-001b, story-001-002
    assert.strictEqual(result.storiesDone, 3, 'sub-stories + downstream all done');

    // Downstream (story-001-002) must be dispatched AFTER final sub-story (story-001-001b)
    const idxFinal = dispatchOrder.indexOf('story-001-001b');
    const idxDownstream = dispatchOrder.indexOf('story-001-002');
    assert.ok(idxFinal !== -1, 'story-001-001b was dispatched');
    assert.ok(idxDownstream !== -1, 'story-001-002 was dispatched');
    assert.ok(idxFinal < idxDownstream, 'final sub-story dispatched before downstream');

    // dep_overrides written to DB for downstream
    const agents = new AgentStore(db);
    const downstreamRow = agents.getByStory('story-001-002');
    assert.ok(downstreamRow?.dep_overrides, 'dep_overrides set for downstream');
    const overrides = JSON.parse(downstreamRow!.dep_overrides!);
    assert.deepStrictEqual(overrides, ['story-001-001b']);
  });
});

// ─── AC-5: budget enforcement ─────────────────────────────────────────────────

describe('Supervisor reroute — MAX_RESPLIT_BUDGET enforcement (AC-5)', () => {
  it('[Negative] story rerouted MAX_RESPLIT_BUDGET times → next reroute throws RerouteBudgetExhaustedError', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Pre-seed a 'failed' agent with resplit_count=MAX_RESPLIT_BUDGET. AgentStore.create
    // inherits the MAX resplit_count when taskFor creates the run's active agent, so
    // handleReroute immediately sees the exhausted budget.
    const agents = new AgentStore(db);
    const origAgent = agents.create('epic-001', 'story-001-001', original.title);
    db.prepare('UPDATE agents SET status = ?, resplit_count = ? WHERE id = ?')
      .run('failed', MAX_RESPLIT_BUDGET, origAgent.id);

    const pm = makePMAgent([makeStory('sub-a'), makeStory('sub-b')]);

    const worker = new MockWorkerRunner({
      status: 'failed',
      commitCount: 0,
      summary: 'too big',
      logTail: `${LOOM_TOO_BIG_SIGNAL}\n`,
    });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      pmAgent: pm,
    });

    // The supervisor should throw RerouteBudgetExhaustedError when budget is exhausted
    await assert.rejects(
      () => supervisor.run(['epic-001']),
      (err: unknown) => {
        // RerouteBudgetExhaustedError is thrown from doReroute and propagates out of run()
        assert.ok(err instanceof Error, `expected Error, got ${String(err)}`);
        assert.ok(
          (err as Error).name === 'RerouteBudgetExhaustedError',
          `expected RerouteBudgetExhaustedError, got ${(err as Error).name}`
        );
        assert.ok((err as Error).message.includes('story-001-001'));
        return true;
      }
    );

    // Audit must have budget_exhausted entry
    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    const exhausted = rows.find((r) => r.action === 'reroute_budget_exhausted');
    assert.ok(exhausted, 'reroute_budget_exhausted audit row present');
  });
});
