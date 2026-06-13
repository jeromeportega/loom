/**
 * Integration tests for proposeNextEpic() and its structural NFR-3 invariants.
 *
 * Level: Integration (stubbed BriefRefiner + Planner) with real in-memory SQLite.
 * All LLM calls are intercepted; no real model is invoked.
 *
 * Owner: story-005-006
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../state/Database.js';
import { LessonStore } from '../../state/LessonStore.js';
import { EpicStore } from '../../state/EpicStore.js';
import { AuditLog } from '../../state/AuditLog.js';
import { OpportunityStore } from '../../signals/OpportunityStore.js';
import type { OpportunityRecord } from '../../signals/OpportunityEngine.js';
import { proposeNextEpic } from '../proposeNextEpic.js';
import type { ProposeDeps } from '../proposeNextEpic.js';
import type { BriefRefinement } from '../../brief/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePassRefinement(rough: string): BriefRefinement {
  return {
    ready: true,
    original: rough,
    refined_brief: '# Proposed Epic\n\nA well-structured plan.',
    quality_score: 8,
    critique: {
      strong_points: ['clear goal'],
      ambiguities: [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

function makeFailRefinement(rough: string): BriefRefinement {
  return {
    ready: false,
    original: rough,
    quality_score: 3,
    critique: {
      strong_points: [],
      ambiguities: ['too vague', 'no success criteria'],
      missing_scope: ['error handling'],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: ['What is the specific goal?', 'Who is the user?'],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

function seedOpportunity(db: Database.Database, key = 'opp-001', title = 'Improve CI pipeline'): number {
  const store = new OpportunityStore(db);
  const now = new Date().toISOString();
  const opp: OpportunityRecord = {
    id: 0,
    key,
    title,
    rationale: 'CI failures block developer productivity',
    impact: 0.8,
    effort: 0.4,
    confidence: 0.9,
    score: 1.8,
    rank: 1,
    status: 'open',
    signal_count: 5,
    member_keys: ['sig-1'],
    evidence: [{ title: 'CI report', url: 'file:ci.log' }],
    scoped_epic_id: null,
    created_at: now,
    updated_at: now,
  };
  store.upsertRanked([opp]);
  return store.listRanked()[0].id;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let db: Database.Database;
let lessonStore: LessonStore;
let opportunityStore: OpportunityStore;
let epicStore: EpicStore;
let audit: AuditLog;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  lessonStore = new LessonStore(db);
  opportunityStore = new OpportunityStore(db);
  epicStore = new EpicStore(db);
  audit = new AuditLog(db);
});

// ─── Gate fail path ───────────────────────────────────────────────────────────

describe('proposeNextEpic — gate fail', () => {
  it('returns {ok:false, critique} when refiner scores below threshold', async () => {
    let callCount = 0;
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { callCount++; return makeFailRefinement(rough); } },
      planner: { async run() { throw new Error('planner must not be called on gate fail'); } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    const result = await proposeNextEpic(deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(Array.isArray(result.critique.critique.ambiguities));
    assert.equal(callCount, 1, 'refiner must be called exactly once even on fail');
  });

  it('creates no epic on gate fail', async () => {
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { return makeFailRefinement(rough); } },
      planner: { async run() { throw new Error('should not be called'); } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps);

    assert.equal(epicStore.list().length, 0, 'no epic on gate fail');
  });

  it('writes no epic_proposed audit row on gate fail', async () => {
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { return makeFailRefinement(rough); } },
      planner: { async run() { throw new Error('should not be called'); } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps);

    const rows = audit.recent(20);
    assert.ok(
      !rows.some((r) => r.action === 'epic_proposed'),
      'no epic_proposed audit row on gate fail'
    );
  });
});

// ─── Gate pass path ───────────────────────────────────────────────────────────

describe('proposeNextEpic — gate pass', () => {
  it('returns {ok:true, epicId} and epic has proposed_by=loom', async () => {
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');

    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    const result = await proposeNextEpic(deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.epicId, epicId);

    const row = db
      .prepare('SELECT status, autonomy_level, proposed_by FROM epics WHERE id = ?')
      .get(epicId) as { status: string; autonomy_level: string; proposed_by: string | null };
    assert.equal(row.status, 'planned', 'epic stays planned');
    assert.equal(row.autonomy_level, 'manual', 'epic stays manual');
    assert.equal(row.proposed_by, 'loom', 'proposed_by stamped loom');
  });

  it('exactly one batched LLM call (refiner.refine) on happy path', async () => {
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');
    let callCount = 0;

    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: {
        async refine(rough) {
          callCount++;
          return makePassRefinement(rough);
        },
      },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps);

    assert.equal(callCount, 1, 'refiner.refine must be called exactly once');
  });

  it('audit row epic_proposed is written with correct command', async () => {
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');

    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps);

    const rows = audit.getByCommand(epicId, ['epic_proposed']);
    assert.equal(rows.length, 1, 'one epic_proposed row');
    assert.equal(rows[0].command, epicId);
    const detail = rows[0].detail ? JSON.parse(rows[0].detail) as Record<string, unknown> : {};
    assert.equal(detail.proposed_by, 'loom');
  });

  it('epic stays planned (no auto-approve transition)', async () => {
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');

    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps);

    const epic = epicStore.get(epicId);
    assert(epic, 'epic must exist');
    assert.equal(epic.status, 'planned', 'must stay planned — no auto-approve');
    assert.notEqual(epic.status, 'approved');
    assert.notEqual(epic.status, 'in_progress');
  });
});

// ─── Brief composition + lesson ranking ───────────────────────────────────────

describe('proposeNextEpic — brief composition and ranking', () => {
  it('includes top-N lessons and top-M opportunities in the brief passed to refiner', async () => {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    lessonStore.insert([
      {
        epic_id: 'ep1', category: 'schema-migration', observation: 'obs1',
        general_rule: 'always use additive migrations', applied_as: null, applied_ref: null,
        created_at: new Date(base).toISOString(),
      },
      {
        epic_id: 'ep2', category: 'schema-migration', observation: 'obs2',
        general_rule: 'test migrations on fresh DB', applied_as: null, applied_ref: null,
        created_at: new Date(base + 1000).toISOString(),
      },
      {
        epic_id: 'ep3', category: 'testing', observation: 'obs3',
        general_rule: 'write integration tests', applied_as: null, applied_ref: null,
        created_at: new Date(base + 2000).toISOString(),
      },
    ]);
    seedOpportunity(db, 'opp-1', 'Improve schema migration tooling');

    let capturedBrief: string | undefined;
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps, { topLessons: 3, topOpps: 1 });

    assert.ok(capturedBrief, 'brief must be passed to refiner');
    assert.ok(capturedBrief.includes('schema-migration'), 'brief includes lesson category');
    assert.ok(capturedBrief.includes('always use additive migrations') ||
              capturedBrief.includes('test migrations on fresh DB'), 'brief includes lesson rule');
    assert.ok(capturedBrief.includes('Improve schema migration tooling'), 'brief includes opportunity title');
  });

  it('topLessons limits the lessons in the brief', async () => {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    for (let i = 0; i < 6; i++) {
      lessonStore.insert([{
        epic_id: `ep${i}`, category: `cat-${i}`, observation: `obs${i}`,
        general_rule: `rule-${i}`, applied_as: null, applied_ref: null,
        created_at: new Date(base + i * 1000).toISOString(),
      }]);
    }

    let capturedBrief: string | undefined;
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    await proposeNextEpic(deps, { topLessons: 2 });

    assert.ok(capturedBrief, 'brief must be captured');
    // Count category markers — should be at most 2
    const catMatches = (capturedBrief.match(/\*\[cat-/g) ?? []).length;
    assert.ok(catMatches <= 2, `expected ≤2 lesson entries in brief, got ${catMatches}`);
  });

  it('category-frequency ranking: higher-frequency categories rank first', async () => {
    const base = new Date('2024-01-01T00:00:00Z').getTime();
    // 'hot-cat' appears 3×, 'cold-cat' appears 1× (but is most recent)
    lessonStore.insert([
      { epic_id: 'e1', category: 'hot-cat', observation: 'o', general_rule: 'hot-rule-1', applied_as: null, applied_ref: null, created_at: new Date(base).toISOString() },
      { epic_id: 'e2', category: 'hot-cat', observation: 'o', general_rule: 'hot-rule-2', applied_as: null, applied_ref: null, created_at: new Date(base + 1000).toISOString() },
      { epic_id: 'e3', category: 'hot-cat', observation: 'o', general_rule: 'hot-rule-3', applied_as: null, applied_ref: null, created_at: new Date(base + 2000).toISOString() },
      { epic_id: 'e4', category: 'cold-cat', observation: 'o', general_rule: 'cold-rule', applied_as: null, applied_ref: null, created_at: new Date(base + 5000).toISOString() },
    ]);

    let capturedBrief: string | undefined;
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    // topLessons=1: should pick a 'hot-cat' lesson (freq=3 beats 'cold-cat' freq=1)
    await proposeNextEpic(deps, { topLessons: 1 });

    assert.ok(capturedBrief, 'brief must be captured');
    assert.ok(capturedBrief.includes('hot-cat'), 'high-frequency category should appear in brief');
  });

  it('works with empty lessons and empty opportunities (composes a minimal brief)', async () => {
    const epicId = 'epic-001';
    epicStore.create(epicId, 'Test Epic');
    let capturedBrief: string | undefined;
    const deps: ProposeDeps = {
      lessonStore,
      opportunityStore,
      refiner: { async refine(rough) { capturedBrief = rough; return makePassRefinement(rough); } },
      planner: { async run() { return { epicIds: [epicId] }; } },
      epicStore,
      audit,
      minBriefQualityScore: 7,
    };

    const result = await proposeNextEpic(deps);

    assert.equal(result.ok, true);
    assert.ok(capturedBrief, 'brief must be passed to refiner even with no lessons/opps');
    assert.ok(capturedBrief.length > 0);
  });
});

// ─── NFR-3: structural no-auto-trigger test ───────────────────────────────────

describe('proposeNextEpic — NFR-3 structural: no auto-trigger paths', () => {
  it('proposeNextEpic.js code contains no scheduler or auto-approve calls', () => {
    // Read the compiled proposeNextEpic module (relative to this compiled test file)
    const srcPath = resolve(__dirname, '../proposeNextEpic.js');
    if (!existsSync(srcPath)) return; // skip when compiled output is not present yet
    const src = readFileSync(srcPath, 'utf8');

    // Strip single-line comments before checking so documentation comments
    // listing forbidden patterns don't trigger the assertion.
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // Actual function call patterns (not comment mentions)
    const CALL_PATTERNS = ['setInterval(', 'setTimeout(', 'new CronJob', 'auto_approve', 'autoApprove'];
    for (const pattern of CALL_PATTERNS) {
      assert.ok(
        !codeOnly.includes(pattern),
        `"${pattern}" must not appear as code in proposeNextEpic.js (NFR-3)`
      );
    }
  });

  it('proposeNextEpic can only be called via explicit entry points (not auto-wired in orchestrator)', () => {
    // Verify no orchestrator or supervisor file auto-calls proposeNextEpic
    // by checking it is not imported in EpicFinalizer or Supervisor
    const ORCHESTRATOR_FILES = [
      resolve(__dirname, '../../orchestrator/EpicFinalizer.js'),
      resolve(__dirname, '../../orchestrator/Supervisor.js'),
    ];
    for (const filePath of ORCHESTRATOR_FILES) {
      if (!existsSync(filePath)) continue; // compiled output may not exist yet
      const src = readFileSync(filePath, 'utf8');
      assert.ok(
        !src.includes('proposeNextEpic'),
        `${filePath} must not reference proposeNextEpic (NFR-3: no auto-trigger)`
      );
    }
  });
});

// ─── Migration ────────────────────────────────────────────────────────────────

describe('proposeNextEpic — migration', () => {
  it('proposed_by column exists after runMigrations', () => {
    const cols = db
      .prepare('PRAGMA table_info(epics)')
      .all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'proposed_by'), 'proposed_by column must exist');
  });

  it('proposed_by defaults to NULL for existing epics', () => {
    epicStore.create('epic-001', 'Old epic');
    const row = db
      .prepare('SELECT proposed_by FROM epics WHERE id = ?')
      .get('epic-001') as { proposed_by: string | null };
    assert.equal(row.proposed_by, null, 'NULL = human-initiated (default)');
  });

  it('setProposedBy sets proposed_by to loom', () => {
    epicStore.create('epic-001', 'Test');
    epicStore.setProposedBy('epic-001', 'loom');
    const row = db
      .prepare('SELECT proposed_by FROM epics WHERE id = ?')
      .get('epic-001') as { proposed_by: string | null };
    assert.equal(row.proposed_by, 'loom');
  });

  it('runMigrations is idempotent — re-run does not throw', () => {
    runMigrations(db);
    const cols = db
      .prepare('PRAGMA table_info(epics)')
      .all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'proposed_by'), 'proposed_by still present after re-run');
  });
});

// ─── MCP registration check ────────────────────────────────────────────────────

describe('proposeNextEpic — MCP tool registration', () => {
  it('loom_propose is in TOOL_DEFINITIONS and HANDLERS', async (t) => {
    const registryPath = resolve(
      __dirname,
      join('..', '..', '..', '..', '..', 'packages', 'loom-mcp', 'dist', 'tools', 'registry.js')
    );
    const handlersPath = resolve(
      __dirname,
      join('..', '..', '..', '..', '..', 'packages', 'loom-mcp', 'dist', 'tools', 'handlers.js')
    );

    if (!existsSync(registryPath) || !existsSync(handlersPath)) {
      t.skip('MCP build output not present — run npm run build in loom-mcp first');
      return;
    }

    const { TOOL_DEFINITIONS } = await import(registryPath) as { TOOL_DEFINITIONS: Array<{ name: string }> };
    const { HANDLERS } = await import(handlersPath) as { HANDLERS: Record<string, unknown> };

    const def = TOOL_DEFINITIONS.find((entry) => entry.name === 'loom_propose');
    assert.ok(def, 'loom_propose must be in TOOL_DEFINITIONS');
    assert.ok('loom_propose' in HANDLERS, 'loom_propose must be in HANDLERS');
  });
});
