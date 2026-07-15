/**
 * story-095-005: Supervisor runtime reroute-to-PM re-decomposition.
 *
 * Unit tests: handleReroute, injectSubStories, RerouteBudgetExhaustedError.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AgentStore } from '../../state/AgentStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import {
  handleReroute,
  injectSubStories,
  RerouteBudgetExhaustedError,
  type PMAgent,
  type ReroutePayload,
} from '../rerouteHandler.js';
import { MAX_RESPLIT_BUDGET } from '../constants.js';
import type { Story } from '../../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makePMAgent(subStories: Story[]): PMAgent {
  return {
    async decompose(_spec: string, _fanOut: string): Promise<Story[]> {
      return subStories;
    },
  };
}

// ─── Test state ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rh-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetDatabaseForTest();
});

// ─── RerouteBudgetExhaustedError ─────────────────────────────────────────────

describe('RerouteBudgetExhaustedError', () => {
  it('[Happy] carries storyId and resplitCount properties', () => {
    const err = new RerouteBudgetExhaustedError('story-001-001', 2);
    assert.strictEqual(err.storyId, 'story-001-001');
    assert.strictEqual(err.resplitCount, 2);
    assert.ok(err.message.includes('MAX_RESPLIT_BUDGET'));
    assert.ok(err.message.includes('story-001-001'));
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'RerouteBudgetExhaustedError');
  });
});

// ─── handleReroute ────────────────────────────────────────────────────────────

describe('handleReroute', () => {
  it('[Happy] first split: resplit_count=0 → calls PM, increments to 1, returns sub-stories', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);
    // resplit_count starts at 0 (default)

    const sub1 = makeStory('story-001-001a');
    const sub2 = makeStory('story-001-001b');
    const pm = makePMAgent([sub1, sub2]);

    const payload: ReroutePayload = {
      story: original,
      fanOutPayload: 'too big because of XYZ',
      trigger: 'LOOM_TOO_BIG',
    };

    const result = await handleReroute(payload, { pmAgent: pm, db, epicId: 'epic-001', auditLog: audit });

    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'story-001-001a');
    assert.strictEqual(result[1].id, 'story-001-001b');

    // resplit_count must be incremented in DB
    const updated = db
      .prepare('SELECT resplit_count FROM agents WHERE id = ?')
      .get(agentRow.id) as { resplit_count: number };
    assert.strictEqual(updated.resplit_count, 1);

    // Audit entries present
    const rows = audit.getByStory('story-001-001');
    const invoked = rows.find((r) => r.action === 'reroute_pm_invoked');
    const succeeded = rows.find((r) => r.action === 'reroute_pm_succeeded');
    assert.ok(invoked, 'reroute_pm_invoked audit row');
    assert.ok(succeeded, 'reroute_pm_succeeded audit row');
  });

  it('[Negative] resplit_count=MAX_RESPLIT_BUDGET → throws RerouteBudgetExhaustedError, PM NOT called', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);
    // Force resplit_count to MAX_RESPLIT_BUDGET
    db.prepare('UPDATE agents SET resplit_count = ? WHERE id = ?')
      .run(MAX_RESPLIT_BUDGET, agentRow.id);

    let pmCalled = false;
    const pm: PMAgent = {
      async decompose(): Promise<Story[]> {
        pmCalled = true;
        return [makeStory('sub-a'), makeStory('sub-b')];
      },
    };

    const payload: ReroutePayload = {
      story: original,
      fanOutPayload: '',
      trigger: 'cap',
    };

    await assert.rejects(
      () => handleReroute(payload, { pmAgent: pm, db, epicId: 'epic-001', auditLog: audit }),
      (err: unknown) => {
        assert.ok(err instanceof RerouteBudgetExhaustedError);
        assert.strictEqual(err.storyId, 'story-001-001');
        assert.strictEqual(err.resplitCount, MAX_RESPLIT_BUDGET);
        return true;
      }
    );
    assert.strictEqual(pmCalled, false, 'PM must not be called when budget exhausted');

    // Audit must record budget exhaustion
    const rows = audit.getByStory('story-001-001');
    const exhausted = rows.find((r) => r.action === 'reroute_budget_exhausted');
    assert.ok(exhausted, 'reroute_budget_exhausted audit row present');
  });

  it('[Negative] PM returns fewer than 2 sub-stories → throws plain Error', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const pm = makePMAgent([makeStory('sub-a')]); // only 1 sub-story

    const payload: ReroutePayload = {
      story: original,
      fanOutPayload: '',
      trigger: 'LOOM_TOO_BIG',
    };

    await assert.rejects(
      () => handleReroute(payload, { pmAgent: pm, db, epicId: 'epic-001', auditLog: audit }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof RerouteBudgetExhaustedError));
        assert.ok((err as Error).message.includes('sub-stories'));
        return true;
      }
    );
  });

  it('[Boundary] second split at count=1 succeeds, increments to 2', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);
    db.prepare('UPDATE agents SET resplit_count = 1 WHERE id = ?').run(agentRow.id);

    const pm = makePMAgent([makeStory('sub-a'), makeStory('sub-b')]);
    const payload: ReroutePayload = { story: original, fanOutPayload: '', trigger: 'cap' };

    const result = await handleReroute(payload, { pmAgent: pm, db, epicId: 'epic-001', auditLog: audit });
    assert.strictEqual(result.length, 2);

    const updated = db
      .prepare('SELECT resplit_count FROM agents WHERE id = ?')
      .get(agentRow.id) as { resplit_count: number };
    assert.strictEqual(updated.resplit_count, 2);
  });
});

// ─── injectSubStories ─────────────────────────────────────────────────────────

describe('injectSubStories', () => {
  it('[Happy] inserts agent rows for each sub-story with story_json set', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const sub1 = makeStory('story-001-001a', { title: 'Sub A' });
    const sub2 = makeStory('story-001-001b', { title: 'Sub B' });

    injectSubStories(original, [sub1, sub2], 'epic-001', db, audit);

    const rowA = agents.getByStory('story-001-001a');
    const rowB = agents.getByStory('story-001-001b');
    assert.ok(rowA, 'agent row for sub-a');
    assert.ok(rowB, 'agent row for sub-b');
    assert.strictEqual(rowA!.status, 'pending');
    assert.strictEqual(rowB!.status, 'pending');
    assert.ok(rowA!.story_json, 'story_json set for sub-a');
    assert.ok(rowB!.story_json, 'story_json set for sub-b');
    const parsedA = JSON.parse(rowA!.story_json!) as Story;
    assert.strictEqual(parsedA.id, 'story-001-001a');
    assert.strictEqual(parsedA.title, 'Sub A');

    // Audit entries for each sub-story
    const rowsA = audit.getByStory('story-001-001a');
    const rowsB = audit.getByStory('story-001-001b');
    assert.ok(rowsA.some((r) => r.action === 'sub_story_injected'), 'sub_story_injected for a');
    assert.ok(rowsB.some((r) => r.action === 'sub_story_injected'), 'sub_story_injected for b');
  });

  it('[Happy] downstream overrides written atomically with dep_overrides column', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const downstream = makeStory('story-001-002', { dependencies: ['story-001-001'] });

    agents.create('epic-001', original.id, original.title);
    agents.create('epic-001', downstream.id, downstream.title);

    const sub1 = makeStory('story-001-001a');
    const sub2 = makeStory('story-001-001b');

    injectSubStories(original, [sub1, sub2], 'epic-001', db, audit, [
      { storyId: 'story-001-002', newDependencies: ['story-001-001b'] },
    ]);

    const downstreamRow = agents.getByStory('story-001-002');
    assert.ok(downstreamRow?.dep_overrides, 'dep_overrides set for downstream');
    const parsed = JSON.parse(downstreamRow!.dep_overrides!);
    assert.deepStrictEqual(parsed, ['story-001-001b']);

    // dep_override_applied audit entry for downstream
    const rows = audit.getByStory('story-001-002');
    assert.ok(rows.some((r) => r.action === 'dep_override_applied'), 'dep_override_applied audit row');
  });

  it('[Boundary] all writes are atomic: DB is consistent even with 3+ sub-stories', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const subs = ['a', 'b', 'c'].map((s) => makeStory(`story-001-001${s}`));
    injectSubStories(original, subs, 'epic-001', db, audit);

    for (const s of subs) {
      const row = agents.getByStory(s.id);
      assert.ok(row, `agent row for sub-${s.id}`);
    }
    // Original row untouched
    const origRow = agents.getByStory('story-001-001');
    assert.ok(origRow, 'original row still present');
  });

  it('[Boundary] idempotent on double-call: second injectSubStories call does not create phantom rows', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const sub1 = makeStory('story-001-001a');
    const sub2 = makeStory('story-001-001b');

    // First call (normal path)
    injectSubStories(original, [sub1, sub2], 'epic-001', db, audit);
    const countAfterFirst = (db.prepare('SELECT COUNT(*) AS c FROM agents WHERE epic_id = ?').get('epic-001') as { c: number }).c;

    // Second call (crash-restart scenario)
    injectSubStories(original, [sub1, sub2], 'epic-001', db, audit);
    const countAfterSecond = (db.prepare('SELECT COUNT(*) AS c FROM agents WHERE epic_id = ?').get('epic-001') as { c: number }).c;

    assert.strictEqual(countAfterFirst, countAfterSecond, 'second call must not insert duplicate rows');
    // Sub-story rows are still readable
    assert.ok(agents.getByStory('story-001-001a'), 'sub-a row still present');
    assert.ok(agents.getByStory('story-001-001b'), 'sub-b row still present');
  });
});
