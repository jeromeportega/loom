/**
 * Reroute rework: handleReroute (budget-gated PM call, no DB write),
 * validateSubStories (pure sub-graph validation), injectSubStories (atomic
 * inject + supersede + lineage-seeded resplit).
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
  validateSubStories,
  RerouteBudgetExhaustedError,
  RerouteValidationError,
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
    async decompose(): Promise<Story[]> {
      return subStories;
    },
  };
}

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
  it('carries storyId and resplitCount', () => {
    const err = new RerouteBudgetExhaustedError('story-001-001', 2);
    assert.strictEqual(err.storyId, 'story-001-001');
    assert.strictEqual(err.resplitCount, 2);
    assert.ok(err.message.includes('MAX_RESPLIT_BUDGET'));
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'RerouteBudgetExhaustedError');
  });
});

// ─── handleReroute (budget gate + PM call; NO DB write) ─────────────────────────

describe('handleReroute', () => {
  it('[Happy] lineage count 0 → calls PM, returns { subStories, parentResplitCount:0 }, writes NO resplit change', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);

    const sub1 = makeStory('story-001-002');
    const sub2 = makeStory('story-001-003');
    const pm = makePMAgent([sub1, sub2]);

    const payload: ReroutePayload = { story: original, fanOutPayload: 'too big', trigger: 'LOOM_TOO_BIG' };
    const result = await handleReroute(payload, { pmAgent: pm, agents, epicId: 'epic-001', auditLog: audit, coverageKeys: [] });

    assert.strictEqual(result.subStories.length, 2);
    assert.strictEqual(result.parentResplitCount, 0);
    // handleReroute must NOT mutate resplit_count — seeding happens in injectSubStories.
    const orig = db.prepare('SELECT resplit_count FROM agents WHERE id = ?').get(agentRow.id) as { resplit_count: number };
    assert.strictEqual(orig.resplit_count, 0, 'handleReroute writes no resplit change');

    const rows = audit.getByStory('story-001-001');
    assert.ok(rows.find((r) => r.action === 'reroute_pm_invoked'));
    assert.ok(rows.find((r) => r.action === 'reroute_pm_succeeded'));
  });

  it('[Negative] lineage count = MAX → throws RerouteBudgetExhaustedError, PM NOT called', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);
    db.prepare('UPDATE agents SET resplit_count = ? WHERE id = ?').run(MAX_RESPLIT_BUDGET, agentRow.id);

    let pmCalled = false;
    const pm: PMAgent = { async decompose(): Promise<Story[]> { pmCalled = true; return []; } };
    const payload: ReroutePayload = { story: original, fanOutPayload: '', trigger: 'cap' };

    await assert.rejects(
      () => handleReroute(payload, { pmAgent: pm, agents, epicId: 'epic-001', auditLog: audit, coverageKeys: [] }),
      (err: unknown) => {
        assert.ok(err instanceof RerouteBudgetExhaustedError);
        assert.strictEqual(err.storyId, 'story-001-001');
        assert.strictEqual(err.resplitCount, MAX_RESPLIT_BUDGET);
        return true;
      }
    );
    assert.strictEqual(pmCalled, false);
    assert.ok(audit.getByStory('story-001-001').find((r) => r.action === 'reroute_budget_exhausted'));
  });

  it('[Negative] PM returns < 2 sub-stories → throws RerouteValidationError', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const pm = makePMAgent([makeStory('story-001-002')]);
    const payload: ReroutePayload = { story: original, fanOutPayload: '', trigger: 'LOOM_TOO_BIG' };

    await assert.rejects(
      () => handleReroute(payload, { pmAgent: pm, agents, epicId: 'epic-001', auditLog: audit, coverageKeys: [] }),
      (err: unknown) => {
        assert.ok(err instanceof RerouteValidationError);
        return true;
      }
    );
  });

  it('[Boundary] lineage count = MAX-1 succeeds and reports parentResplitCount = MAX-1', async () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const agentRow = agents.create('epic-001', original.id, original.title);
    db.prepare('UPDATE agents SET resplit_count = ? WHERE id = ?').run(MAX_RESPLIT_BUDGET - 1, agentRow.id);

    const pm = makePMAgent([makeStory('story-001-002'), makeStory('story-001-003')]);
    const payload: ReroutePayload = { story: original, fanOutPayload: '', trigger: 'cap' };
    const result = await handleReroute(payload, { pmAgent: pm, agents, epicId: 'epic-001', auditLog: audit, coverageKeys: [] });
    assert.strictEqual(result.subStories.length, 2);
    assert.strictEqual(result.parentResplitCount, MAX_RESPLIT_BUDGET - 1);
  });
});

// ─── validateSubStories (pure) ──────────────────────────────────────────────────

describe('validateSubStories', () => {
  const original = makeStory('story-001-001', { dependencies: ['story-001-000'] });
  const existing = new Set<string>(['story-001-000', 'story-001-001']);

  it('[Happy] valid partition passes', () => {
    const subs = [makeStory('story-001-002'), makeStory('story-001-003', { dependencies: ['story-001-002'] })];
    assert.doesNotThrow(() => validateSubStories(original, subs, existing, []));
  });

  it('[Negative] < 2 sub-stories', () => {
    assert.throws(() => validateSubStories(original, [makeStory('story-001-002')], existing, []), RerouteValidationError);
  });

  it('[Negative] duplicate sub-story ids', () => {
    const subs = [makeStory('story-001-002'), makeStory('story-001-002')];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] collision with an existing task id', () => {
    const subs = [makeStory('story-001-000'), makeStory('story-001-002')];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] a sub depends on the superseded original', () => {
    const subs = [makeStory('story-001-002', { dependencies: ['story-001-001'] }), makeStory('story-001-003')];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] a sub depends on an unknown id', () => {
    const subs = [makeStory('story-001-002', { dependencies: ['story-999-999'] }), makeStory('story-001-003')];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] cycle among sub-stories', () => {
    const subs = [
      makeStory('story-001-002', { dependencies: ['story-001-003'] }),
      makeStory('story-001-003', { dependencies: ['story-001-002'] }),
    ];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] coverage key provided by zero sub-stories', () => {
    const subs = [makeStory('story-001-002'), makeStory('story-001-003')];
    assert.throws(() => validateSubStories(original, subs, existing, ['apiSchema']), RerouteValidationError);
  });

  it('[Negative] coverage key provided by two sub-stories (must be exactly one)', () => {
    const subs = [
      makeStory('story-001-002', { provides: { apiSchema: 'x' } }),
      makeStory('story-001-003', { provides: { apiSchema: 'y' } }),
    ];
    assert.throws(() => validateSubStories(original, subs, existing, ['apiSchema']), RerouteValidationError);
  });

  it('[Happy] coverage key provided by exactly one sub-story passes', () => {
    const subs = [
      makeStory('story-001-002', { provides: { apiSchema: 'x' } }),
      makeStory('story-001-003'),
    ];
    assert.doesNotThrow(() => validateSubStories(original, subs, existing, ['apiSchema']));
  });

  it('[Negative] a sub requires a key from an unknown source', () => {
    const subs = [
      makeStory('story-001-002', { requires: { k: 'story-999-999' } }),
      makeStory('story-001-003'),
    ];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });

  it('[Negative] a sub requires a key FROM the superseded original', () => {
    // The original is still in existingTaskIds at validation time; a sub requiring it
    // would resolve to a NULL-provides row and block forever. Must be rejected.
    const subs = [
      makeStory('story-001-002', { requires: { schema: 'story-001-001' } }),
      makeStory('story-001-003'),
    ];
    assert.throws(() => validateSubStories(original, subs, existing, []), RerouteValidationError);
  });
});

// ─── injectSubStories (atomic inject + supersede + lineage seed) ────────────────

describe('injectSubStories', () => {
  it('[Happy] inserts sub rows with story_json, seeds resplit_count=parent+1, supersedes original', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const subs = [makeStory('story-001-002', { title: 'Sub A' }), makeStory('story-001-003', { title: 'Sub B' })];
    injectSubStories(original, subs, 'epic-001', db, audit, { parentResplitCount: 1 });

    const rowA = agents.getByStory('story-001-002');
    const rowB = agents.getByStory('story-001-003');
    assert.strictEqual(rowA!.status, 'pending');
    assert.strictEqual(rowA!.resplit_count, 2, 'sub resplit seeded to parent+1');
    assert.strictEqual(rowB!.resplit_count, 2);
    assert.strictEqual((JSON.parse(rowA!.story_json!) as Story).title, 'Sub A');

    // Original superseded (keeps status, gains superseded_by).
    const supersededBy = agents.getSupersededBy('story-001-001', 'epic-001');
    assert.ok(supersededBy, 'original marked superseded_by');
    assert.deepStrictEqual(JSON.parse(supersededBy!), ['story-001-002', 'story-001-003']);

    assert.ok(audit.getByStory('story-001-001').find((r) => r.action === 'story_superseded'));
  });

  it('[Happy] dep_overrides + requires_overrides written atomically', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    const downstream = makeStory('story-001-004', { dependencies: ['story-001-001'], requires: { schema: 'story-001-001' } });
    agents.create('epic-001', original.id, original.title);
    agents.create('epic-001', downstream.id, downstream.title);

    const subs = [makeStory('story-001-002', { provides: { schema: 'x' } }), makeStory('story-001-003')];
    injectSubStories(original, subs, 'epic-001', db, audit, {
      parentResplitCount: 0,
      depOverrides: [{ storyId: 'story-001-004', newDependencies: ['story-001-002', 'story-001-003'] }],
      requiresOverrides: [{ storyId: 'story-001-004', newRequires: { schema: 'story-001-002' } }],
    });

    const dsRow = agents.getByStory('story-001-004');
    assert.deepStrictEqual(JSON.parse(dsRow!.dep_overrides!), ['story-001-002', 'story-001-003']);
    assert.deepStrictEqual(JSON.parse(agents.getRequiresOverrides('story-001-004', 'epic-001')!), { schema: 'story-001-002' });

    const rows = audit.getByStory('story-001-004');
    assert.ok(rows.some((r) => r.action === 'dep_override_applied'));
    assert.ok(rows.some((r) => r.action === 'requires_override_applied'));
  });

  it('[Boundary] idempotent on double-call: no phantom rows, resplit unchanged', () => {
    const db = openDatabase(path.join(tmpDir, '.loom'));
    new EpicStore(db).create('epic-001', 'Test Epic');
    const agents = new AgentStore(db);
    const audit = new AuditLog(db);
    const original = makeStory('story-001-001');
    agents.create('epic-001', original.id, original.title);

    const subs = [makeStory('story-001-002'), makeStory('story-001-003')];
    injectSubStories(original, subs, 'epic-001', db, audit, { parentResplitCount: 0 });
    const c1 = (db.prepare('SELECT COUNT(*) AS c FROM agents WHERE epic_id = ?').get('epic-001') as { c: number }).c;
    injectSubStories(original, subs, 'epic-001', db, audit, { parentResplitCount: 0 });
    const c2 = (db.prepare('SELECT COUNT(*) AS c FROM agents WHERE epic_id = ?').get('epic-001') as { c: number }).c;
    assert.strictEqual(c1, c2, 'no duplicate sub rows on re-entry');
  });
});
