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
import { StoryRetryService } from '../StoryRetryService.js';
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

    // PM returns sub-stories with placeholder ids; the Supervisor re-stamps
    // schema-valid `story-NNN-MMM` ids (continuing past the max existing number).
    const sub1 = makeStory('placeholder-a', { title: 'Sub A' });
    const sub2 = makeStory('placeholder-b', { title: 'Sub B' });
    const pm = makePMAgent([sub1, sub2]);

    const worker = new MockWorkerRunner((assignment) => {
      if (assignment.storyId === 'story-001-001') {
        return {
          status: 'failed' as const,
          commitCount: 0,
          summary: 'too big',
          logTail: `Did some work.\n${LOOM_TOO_BIG_SIGNAL} needs to be split\n`,
          killReason: undefined,
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

    // Both sub-stories should be dispatched and completed.
    assert.strictEqual(result.storiesDone, 2, 'both sub-stories completed');

    // A rerouted event must have been emitted (AC-6) with the ALLOCATED ids.
    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }> | undefined;
    assert.ok(reroutedEvent, 'rerouted event emitted');
    assert.strictEqual(reroutedEvent!.storyId, 'story-001-001');
    assert.strictEqual(reroutedEvent!.trigger, 'LOOM_TOO_BIG');
    const subIds = reroutedEvent!.subStoryIds;
    assert.strictEqual(subIds.length, 2);
    for (const id of subIds) {
      assert.match(id, /^story-001-\d{3}$/, `allocated sub-story id ${id} is schema-valid`);
    }

    // Allocated sub-story agent rows exist and completed, seeded resplit_count=1.
    const agents = new AgentStore(db);
    for (const id of subIds) {
      const row = agents.getByStory(id);
      assert.ok(row, `agent row for ${id}`);
      assert.strictEqual(row!.status, 'done');
      assert.strictEqual(row!.resplit_count, 1, 'sub resplit seeded to parent(0)+1');
    }

    // Original is superseded (excluded from completion math) but still present as a row.
    const supersededBy = agents.getSupersededBy('story-001-001', 'epic-001');
    assert.ok(supersededBy, 'original marked superseded_by');
    assert.deepStrictEqual(JSON.parse(supersededBy!), subIds);
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

    // Spy cleanRetryService to assert the destructive-delete path (stall recovery)
    // is NOT taken for a cap-killed story. AC-3 explicitly requires this.
    const cleanRetryCalledFor: string[] = [];
    const spyCleanRetryService = {
      prepare: (storyId: string) => {
        cleanRetryCalledFor.push(storyId);
        return { status: 'ready' as const, storyId, cleaned: true, resetStories: [], willResume: false, message: 'spy' };
      },
    } as unknown as StoryRetryService;

    const events: WorkerEvent[] = [];
    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 3,
      lease: false,
      pmAgent: pm,
      cleanRetryService: spyCleanRetryService,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    assert.strictEqual(result.storiesDone, 2, 'both sub-stories completed');

    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }> | undefined;
    assert.ok(reroutedEvent, 'rerouted event emitted for cap kill');
    assert.strictEqual(reroutedEvent!.trigger, 'cap');

    // Verify checkpointUncommitted (cleanRetryService.prepare) was NOT called
    // for the cap-killed story — the reroute path bypasses destructive worktree teardown.
    assert.ok(
      !cleanRetryCalledFor.includes('story-001-001'),
      `cleanRetryService.prepare must NOT be called for cap-killed story; was called for: ${JSON.stringify(cleanRetryCalledFor)}`
    );
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

// ─── Backward-compat: successful worker emitting LOOM_TOO_BIG not rerouted ────

describe('Supervisor reroute — successful worker with LOOM_TOO_BIG signal (AC-1 guard)', () => {
  it('[Boundary] worker status=done + LOOM_TOO_BIG in logTail → NOT rerouted, normal completion', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const pm = makePMAgent([makeStory('story-001-001a'), makeStory('story-001-001b')]);
    const events: WorkerEvent[] = [];

    const worker = new MockWorkerRunner({
      // Worker succeeded but incidentally printed the LOOM_TOO_BIG signal
      status: 'done',
      commitCount: 1,
      summary: 'done',
      logTail: `All good.\n${LOOM_TOO_BIG_SIGNAL} some payload\n`,
    });

    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 1,
      lease: false,
      pmAgent: pm,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    // Original story completes; no reroute
    assert.strictEqual(result.storiesDone, 1, 'original story done — not rerouted');
    assert.strictEqual(result.storiesFailed, 0);
    const reroutedEvent = events.find((e) => e.type === 'rerouted');
    assert.ok(!reroutedEvent, 'rerouted event must NOT be emitted for status=done worker');

    // Sub-stories must NOT exist in DB
    const agents = new AgentStore(db);
    assert.ok(!agents.getByStory('story-001-001a'), 'sub-a must not be injected');
    assert.ok(!agents.getByStory('story-001-001b'), 'sub-b must not be injected');
  });
});

// ─── AC-4: downstream re-pointing ─────────────────────────────────────────────

describe('Supervisor reroute — downstream re-pointing (AC-4)', () => {
  it('[Happy] downstream depends on original → re-pointed to ALL sub-stories, waits for every one', async () => {
    const original = makeStory('story-001-001');
    const downstream = makeStory('story-001-002', { dependencies: ['story-001-001'] });
    seedEpic(repoDir, 'epic-001', [original, downstream]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const pm = makePMAgent([makeStory('ph-a'), makeStory('ph-b')]);

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

    const events: WorkerEvent[] = [];
    const supervisor = new Supervisor({
      projectRoot: repoDir,
      db,
      worker,
      maxConcurrent: 4,
      lease: false,
      pmAgent: pm,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    // Two sub-stories + the downstream all complete (original superseded, not counted).
    assert.strictEqual(result.storiesDone, 3, 'sub-stories + downstream all done');

    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }>;
    const subIds = reroutedEvent.subStoryIds;

    // Downstream must be dispatched AFTER every sub-story (re-pointed to ALL of them).
    const idxDownstream = dispatchOrder.indexOf('story-001-002');
    assert.ok(idxDownstream !== -1, 'downstream dispatched');
    for (const id of subIds) {
      const idxSub = dispatchOrder.indexOf(id);
      assert.ok(idxSub !== -1 && idxSub < idxDownstream, `sub ${id} dispatched before downstream`);
    }

    // dep_overrides lists ALL sub-story ids (not just the last).
    const agents = new AgentStore(db);
    const overrides = JSON.parse(agents.getByStory('story-001-002')!.dep_overrides!) as string[];
    assert.deepStrictEqual([...overrides].sort(), [...subIds].sort(), 'downstream re-pointed to ALL subs');
  });
});

// ─── AC-5: budget enforcement ─────────────────────────────────────────────────

describe('Supervisor reroute — MAX_RESPLIT_BUDGET enforcement (AC-5)', () => {
  it('[Negative] lineage budget exhausted → story fails ALONE (run does NOT abort), records reroute_failed', async () => {
    const original = makeStory('story-001-001');
    seedEpic(repoDir, 'epic-001', [original]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    // Pre-seed a 'failed' agent with resplit_count=MAX_RESPLIT_BUDGET. AgentStore.create
    // carries forward MAX(resplit_count), so the run's active agent starts exhausted and
    // handleReroute throws RerouteBudgetExhaustedError — which the sweep swallows.
    const agents = new AgentStore(db);
    const origAgent = agents.create('epic-001', 'story-001-001', original.title);
    db.prepare('UPDATE agents SET status = ?, resplit_count = ? WHERE id = ?')
      .run('failed', MAX_RESPLIT_BUDGET, origAgent.id);

    let pmCalled = false;
    const pm: PMAgent = { async decompose(): Promise<Story[]> { pmCalled = true; return []; } };

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

    // The run MUST complete (not throw) — a single un-splittable story fails alone.
    const result = await supervisor.run(['epic-001']);
    assert.strictEqual(result.storiesFailed, 1, 'the un-splittable story is failed');
    assert.strictEqual(result.storiesDone, 0);
    assert.strictEqual(pmCalled, false, 'PM not called when budget exhausted');

    const audit = new AuditLog(db);
    const rows = audit.getByStory('story-001-001');
    assert.ok(rows.find((r) => r.action === 'reroute_budget_exhausted'), 'budget_exhausted audit row');
    assert.ok(rows.find((r) => r.action === 'reroute_failed'), 'reroute_failed audit row (swept, not thrown)');
  });

  it('[Boundary] one un-splittable story does not orphan a concurrent sibling (maxConcurrent=2)', async () => {
    // story-001-001 is budget-exhausted; story-001-002 is an independent sibling that
    // must still complete even though 001-001 fails during the reroute sweep.
    const a = makeStory('story-001-001');
    const b = makeStory('story-001-002');
    seedEpic(repoDir, 'epic-001', [a, b]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const agents = new AgentStore(db);
    const aAgent = agents.create('epic-001', 'story-001-001', a.title);
    db.prepare('UPDATE agents SET status = ?, resplit_count = ? WHERE id = ?')
      .run('failed', MAX_RESPLIT_BUDGET, aAgent.id);

    const pm = makePMAgent([makeStory('ph-a'), makeStory('ph-b')]);
    const worker = new MockWorkerRunner((assignment) => {
      if (assignment.storyId === 'story-001-001') {
        return { status: 'failed' as const, commitCount: 0, summary: 'too big', logTail: `${LOOM_TOO_BIG_SIGNAL}\n` };
      }
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const supervisor = new Supervisor({
      projectRoot: repoDir, db, worker, maxConcurrent: 2, lease: false, pmAgent: pm,
    });

    const result = await supervisor.run(['epic-001']);
    assert.strictEqual(result.storiesDone, 1, 'the independent sibling completed — not orphaned');
    assert.strictEqual(result.storiesFailed, 1, 'only the budget-exhausted story failed');
  });
});

// ─── Sub-story ID collision guard ─────────────────────────────────────────────

describe('Supervisor reroute — sub-story ID allocation avoids collisions', () => {
  it('[Happy] PM ids that would collide are IGNORED; Supervisor allocates fresh non-colliding ids past the max', async () => {
    // epic has two YAML stories: story-001-001 (rerouted) and story-001-002 (existing).
    // The PM even returns a placeholder that looks like story-001-002 — the Supervisor
    // must NOT honor PM ids; it allocates fresh `story-001-MMM` past the current max (002).
    const original = makeStory('story-001-001');
    const existing = makeStory('story-001-002');
    seedEpic(repoDir, 'epic-001', [original, existing]);
    const db = openDatabase(path.join(repoDir, '.loom'));

    const pm = makePMAgent([makeStory('story-001-002'), makeStory('placeholder')]);

    const worker = new MockWorkerRunner((assignment) => {
      if (assignment.storyId === 'story-001-001') {
        return { status: 'failed' as const, commitCount: 0, summary: 'too big', logTail: `${LOOM_TOO_BIG_SIGNAL}\n` };
      }
      return { status: 'done' as const, commitCount: 1, summary: 'done', logTail: '' };
    });

    const events: WorkerEvent[] = [];
    const supervisor = new Supervisor({
      projectRoot: repoDir, db, worker, maxConcurrent: 3, lease: false, pmAgent: pm,
      onWorkerEvent: (e) => events.push(e),
    });

    const result = await supervisor.run(['epic-001']);

    // existing (002) + 2 fresh sub-stories all complete; original superseded.
    assert.strictEqual(result.storiesDone, 3);

    const reroutedEvent = events.find((e) => e.type === 'rerouted') as Extract<WorkerEvent, { type: 'rerouted' }>;
    const subIds = reroutedEvent.subStoryIds;
    // Allocated ids are fresh, schema-valid, and never reuse the existing 002.
    assert.deepStrictEqual(subIds, ['story-001-003', 'story-001-004'], 'allocated past the max existing number');
    assert.ok(!subIds.includes('story-001-002'), 'never collides with the existing story');
  });
});
