import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDatabase } from '../../state/Database.js';
import { AuditLog } from '../../state/AuditLog.js';
import { EpicStore } from '../../state/EpicStore.js';
import { OpportunityStore } from '../OpportunityStore.js';
import { scopeOpportunity, reopenOpportunityForRejectedEpic } from '../scopeOpportunity.js';
import type { BriefRefinement } from '../../brief/types.js';
import type { OpportunityRecord } from '../OpportunityEngine.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeRefinement(quality_score: number, hasAmbiguities = false): BriefRefinement {
  return {
    ready: quality_score >= 7,
    original: 'rough brief',
    refined_brief: '# Refined Brief\n\nA well-scoped plan for reducing CI failures.',
    blocking_gaps: [],
    critique: {
      strong_points: [],
      ambiguities: hasAmbiguities ? ['too vague to plan autonomously'] : [],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: [],
    quality_score,
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

function seedOpenOpportunity(db: ReturnType<typeof createDatabase>): number {
  const store = new OpportunityStore(db);
  const now = new Date().toISOString();
  const opp: OpportunityRecord = {
    id: 0,
    key: 'opp-scope-test',
    title: 'Reduce CI failure rate',
    rationale: 'CI fails 20% of runs causing developer frustration',
    impact: 0.8,
    effort: 0.4,
    confidence: 0.7,
    score: 1.4,
    rank: 1,
    status: 'open',
    signal_count: 3,
    member_keys: ['sig-1', 'sig-2', 'sig-3'],
    evidence: [{ title: 'CI run failures', url: 'file:ci.log:10' }],
    scoped_epic_id: null,
    created_at: now,
    updated_at: now,
  };
  store.upsertRanked([opp]);
  return store.listRanked()[0].id;
}

/** Stub BriefRefiner that returns a fixed BriefRefinement. */
class StubRefiner {
  constructor(private refinement: BriefRefinement) {}
  async refine(_rough: string): Promise<BriefRefinement> {
    return this.refinement;
  }
}

/** Stub Planner that creates a real 'planned' epic in the DB and returns its id. */
class StubPlanner {
  constructor(
    private db: ReturnType<typeof createDatabase>,
    private epicId: string
  ) {}

  async run(_brief: string): Promise<{ epicIds: string[] }> {
    new EpicStore(this.db).create(this.epicId, 'Scoped: Reduce CI failure rate');
    return { epicIds: [this.epicId] };
  }
}

// ─── Happy scope — FR-11/12 ───────────────────────────────────────────────────

describe('scopeOpportunity — happy path (FR-11/12)', () => {
  it('creates a planned+manual epic, links scoped_epic_id, returns {ok:true}', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const expectedEpicId = 'epic-001';

    const result = await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, expectedEpicId),
      },
      opportunityId
    );

    assert.deepStrictEqual(result, { ok: true, epicId: expectedEpicId });

    // Opportunity is now scoped with the linked epic id
    const opp = new OpportunityStore(db).get(opportunityId)!;
    assert.equal(opp.status, 'scoped');
    assert.equal(opp.scoped_epic_id, expectedEpicId);
  });

  it('the scoped epic has status=planned and autonomy_level=manual', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const expectedEpicId = 'epic-001';

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, expectedEpicId),
      },
      opportunityId
    );

    const epic = new EpicStore(db).get(expectedEpicId)!;
    assert.equal(epic.status, 'planned', 'scoped epic must be planned');
    // autonomy_level defaults to 'manual' for all created epics (v16 schema default)
    const autonomy = new EpicStore(db).getAutonomy(expectedEpicId);
    assert.equal(autonomy, 'manual', 'scoped epic must have autonomy_level=manual');
  });

  it('writes an opportunity_scoped audit row on success', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, 'epic-001'),
      },
      opportunityId
    );

    const rows = auditLog.getByCommand(String(opportunityId), ['opportunity_scoped']);
    assert.equal(rows.length, 1, 'exactly one opportunity_scoped audit row');
    const detail = JSON.parse(rows[0].detail as string) as { ok: boolean; epic_id?: string };
    assert.equal(detail.ok, true);
    assert.equal(detail.epic_id, 'epic-001');
  });
});

// ─── Brief gate failure ────────────────────────────────────────────────────────

describe('scopeOpportunity — brief gate failure', () => {
  it('returns {ok:false, critique} when quality_score is below threshold', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);

    const result = await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(4, true)),
        _planner: undefined,
      },
      opportunityId
    );

    assert.equal(result.ok, false);
    assert.ok(typeof (result as { ok: false; critique: string }).critique === 'string');
    assert.ok((result as { ok: false; critique: string }).critique.length > 0);
  });

  it('leaves the opportunity status=open when gate fails', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(4)),
        _planner: undefined,
      },
      opportunityId
    );

    const opp = new OpportunityStore(db).get(opportunityId)!;
    assert.equal(opp.status, 'open', 'opportunity must remain open after gate failure');
    assert.equal(opp.scoped_epic_id, null, 'no epic created');
  });

  it('creates no epic on gate failure', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(4)),
        _planner: undefined,
      },
      opportunityId
    );

    const epics = new EpicStore(db).list();
    assert.equal(epics.length, 0, 'no epic must be created when gate fails');
  });

  it('writes an opportunity_scoped audit row with ok=false on gate failure', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(4, true)),
        _planner: undefined,
      },
      opportunityId
    );

    const rows = auditLog.getByCommand(String(opportunityId), ['opportunity_scoped']);
    assert.equal(rows.length, 1, 'one opportunity_scoped audit row even on failure');
    const detail = JSON.parse(rows[0].detail as string) as { ok: boolean };
    assert.equal(detail.ok, false);
  });
});

// ─── Inbox surfacing — FR-12 ─────────────────────────────────────────────────

describe('scopeOpportunity — inbox surfacing (FR-12)', () => {
  it('scoped epic appears in listByStatus(planned) — the source for plan_approval', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const epicId = 'epic-001';

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, epicId),
      },
      opportunityId
    );

    const planned = new EpicStore(db).listByStatus('planned');
    assert.equal(planned.length, 1);
    assert.equal(planned[0].id, epicId);
  });

  it('the scoped epic stays planned — no code path auto-approves it', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const epicId = 'epic-001';

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, epicId),
      },
      opportunityId
    );

    // After scoping, the epic must still be 'planned' — never auto-transitioned
    const epic = new EpicStore(db).get(epicId)!;
    assert.equal(epic.status, 'planned', 'epic must remain planned; no auto-approve');
    // No epic_approved audit row was written
    const approved = auditLog.getByCommand(epicId, ['epic_approved']);
    assert.equal(approved.length, 0, 'no auto-approve audit row written');
  });
});

// ─── Governance invariant — ADR-006 (structural) ─────────────────────────────

describe('Governance invariant — ADR-006 (structural grep)', () => {
  it('no scheduler, cron, daemon, or auto-approve pattern in signals/ compiled output', () => {
    // Compiled signals files live at dist/signals/*.js relative to loom-core.
    // This test file compiles to dist/signals/__tests__/, so:
    //   __dirname = .../dist/signals/__tests__/
    //   path.resolve(__dirname, '..') = .../dist/signals/
    const signalsDir = path.resolve(__dirname, '..');

    const sourceFiles = fs
      .readdirSync(signalsDir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(signalsDir, f), 'utf-8'));

    const combined = sourceFiles.join('\n');

    // Match actual invocations/constructors, not words that may appear in comments
    assert.doesNotMatch(
      combined,
      /setInterval\s*\(|setTimeout\s*\(|new\s+CronJob|\.schedule\s*\(|CronJob\s*\(/,
      'No scheduler/cron invocation in signals/ — ADR-006'
    );
    assert.doesNotMatch(
      combined,
      /autoApprove\s*\(|auto_approve\s*\(|updateStatus[^)]*['"]approved/,
      'No auto-approve call in signals/ — ADR-006'
    );
    // No score-threshold driven scope call: scopeOpportunity() must not be
    // INVOKED from any other signals module. The barrel re-exports it by name,
    // so we check for a call pattern (function followed by opening paren) rather
    // than the bare identifier.
    const nonScopeFiles = fs
      .readdirSync(signalsDir)
      .filter((f) => f.endsWith('.js') && f !== 'scopeOpportunity.js' && f !== 'index.js')
      .map((f) => fs.readFileSync(path.join(signalsDir, f), 'utf-8'))
      .join('\n');
    assert.doesNotMatch(
      nonScopeFiles,
      /scopeOpportunity\s*\(/,
      'scopeOpportunity() must not be called from other signals implementation modules — ADR-006'
    );
  });
});

// ─── Reject returns opportunity to open ──────────────────────────────────────

describe('reopenOpportunityForRejectedEpic — reject path', () => {
  it('returns a scoped opportunity to open when the linked epic is rejected', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const epicId = 'epic-001';

    // Scope the opportunity
    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, epicId),
      },
      opportunityId
    );

    // Simulate operator rejecting the scoped epic (mutations.ts reject handler)
    new EpicStore(db).updateStatus(epicId, 'rejected');
    reopenOpportunityForRejectedEpic(db, epicId);

    const opp = new OpportunityStore(db).get(opportunityId)!;
    assert.equal(opp.status, 'open', 'opportunity must return to open after epic reject');
    assert.equal(opp.scoped_epic_id, null, 'scoped_epic_id must be cleared');
  });

  it('writes an opportunity_reopened audit row', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const epicId = 'epic-001';

    await scopeOpportunity(
      {
        db,
        projectRoot: '/tmp/loom-test',
        llm: null as never,
        refineModel: 'test-model',
        planModel: 'test-model',
        minBriefQualityScore: 7,
        auditLog,
        _briefRefiner: new StubRefiner(makeRefinement(8)),
        _planner: new StubPlanner(db, epicId),
      },
      opportunityId
    );

    new EpicStore(db).updateStatus(epicId, 'rejected');
    reopenOpportunityForRejectedEpic(db, epicId);

    const rows = auditLog.getByCommand(epicId, ['opportunity_reopened']);
    assert.equal(rows.length, 1, 'one opportunity_reopened audit row');
  });

  it('is a no-op when the epic has no linked opportunity', () => {
    const db = createDatabase(':memory:');
    // Create a plain epic with no linked opportunity
    new EpicStore(db).create('epic-plain', 'Plain Epic');

    // Must not throw
    assert.doesNotThrow(() => reopenOpportunityForRejectedEpic(db, 'epic-plain'));

    // No opportunities table rows changed
    const opps = new OpportunityStore(db).listRanked();
    assert.equal(opps.length, 0);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('scopeOpportunity — idempotency', () => {
  it('calling scopeOpportunity on an already-scoped opportunity returns the existing epic id without double-creating', async () => {
    const db = createDatabase(':memory:');
    const auditLog = new AuditLog(db);
    const opportunityId = seedOpenOpportunity(db);
    const epicId = 'epic-001';

    const deps = {
      db,
      projectRoot: '/tmp/loom-test',
      llm: null as never,
      refineModel: 'test-model',
      planModel: 'test-model',
      minBriefQualityScore: 7,
      auditLog,
      _briefRefiner: new StubRefiner(makeRefinement(8)),
      _planner: new StubPlanner(db, epicId),
    };

    const r1 = await scopeOpportunity(deps, opportunityId);
    assert.equal(r1.ok, true);

    // Second call — should return the same epic id without invoking the planner
    const plannerCallTracker = { called: false };
    const trackingDeps = {
      ...deps,
      _planner: {
        async run(_brief: string): Promise<{ epicIds: string[] }> {
          plannerCallTracker.called = true;
          return { epicIds: [epicId] };
        },
      },
    };

    const r2 = await scopeOpportunity(trackingDeps, opportunityId);
    assert.equal(r2.ok, true);
    assert.equal((r2 as { ok: true; epicId: string }).epicId, epicId);
    assert.equal(plannerCallTracker.called, false, 'planner must NOT be called for already-scoped opportunity');

    // Still only one epic in the DB
    const epics = new EpicStore(db).list();
    assert.equal(epics.length, 1, 'no duplicate epic created');
  });
});
