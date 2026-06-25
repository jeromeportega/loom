import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { buildRunAttribution } from '../runAttribution.js';
import type { RunAttributionState } from '../runAttribution.js';
import { withRunMetrics } from '../withRunMetrics.js';
import { activeCollector, clearActiveCollector } from '../activeCollector.js';
import { MetricsStore } from '../../state/MetricsStore.js';
import { createDatabase } from '../../state/Database.js';
import type { RunOutcome } from '../types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  return createDatabase(':memory:');
}

function insertEpic(db: Database.Database, epicId: string): void {
  db.prepare(
    "INSERT INTO epics (id, title, status) VALUES (?, 'Test epic', 'planned')"
  ).run(epicId);
}

function baseState(overrides: Partial<RunAttributionState> = {}): RunAttributionState {
  return {
    scope: 'epic',
    epicId: 'epic-001',
    storyCount: 3,
    retryCount: 0,
    cleanRetryCount: 0,
    autoRecoveryCount: 0,
    outcome: 'done',
    ...overrides,
  };
}

beforeEach(() => clearActiveCollector());
afterEach(() => clearActiveCollector());

// ─── buildRunAttribution: field mapping ──────────────────────────────────────

describe('buildRunAttribution — field mapping', () => {
  it('includes all required count fields', () => {
    const attr = buildRunAttribution(baseState({ retryCount: 2, cleanRetryCount: 1, autoRecoveryCount: 1 }));
    assert.equal(attr.retryCount, 2);
    assert.equal(attr.cleanRetryCount, 1);
    assert.equal(attr.autoRecoveryCount, 1);
  });

  it('includes scope', () => {
    const attr = buildRunAttribution(baseState({ scope: 'standalone_story' }));
    assert.equal(attr.scope, 'standalone_story');
  });

  it('includes storyCount', () => {
    const attr = buildRunAttribution(baseState({ storyCount: 7 }));
    assert.equal(attr.storyCount, 7);
  });

  it('includes epicId when defined', () => {
    const attr = buildRunAttribution(baseState({ epicId: 'epic-042' }));
    assert.equal(attr.epicId, 'epic-042');
  });

  it('omits epicId when undefined', () => {
    const attr = buildRunAttribution(baseState({ epicId: undefined }));
    assert.equal('epicId' in attr, false, 'epicId must be absent when undefined');
  });

  it('includes storyId when defined', () => {
    const attr = buildRunAttribution(baseState({ scope: 'standalone_story', epicId: undefined, storyId: 'story-007' }));
    assert.equal(attr.storyId, 'story-007');
  });

  it('omits storyId when undefined', () => {
    const attr = buildRunAttribution(baseState({ storyId: undefined }));
    assert.equal('storyId' in attr, false, 'storyId must be absent when undefined');
  });

  it('includes intakeVerdict when defined', () => {
    const attr = buildRunAttribution(baseState({ intakeVerdict: 'story' }));
    assert.equal(attr.intakeVerdict, 'story');
  });

  it('omits intakeVerdict when undefined', () => {
    const attr = buildRunAttribution(baseState({ intakeVerdict: undefined }));
    assert.equal('intakeVerdict' in attr, false);
  });

  it('includes intakeKind when defined', () => {
    const attr = buildRunAttribution(baseState({ intakeKind: 'feature' }));
    assert.equal(attr.intakeKind, 'feature');
  });

  it('omits intakeKind when undefined', () => {
    const attr = buildRunAttribution(baseState({ intakeKind: undefined }));
    assert.equal('intakeKind' in attr, false);
  });

  it('includes startedAt when defined', () => {
    const attr = buildRunAttribution(baseState({ startedAt: '2024-01-01T00:00:00.000Z' }));
    assert.equal(attr.startedAt, '2024-01-01T00:00:00.000Z');
  });

  it('includes endedAt when defined', () => {
    const attr = buildRunAttribution(baseState({ endedAt: '2024-01-01T01:00:00.000Z' }));
    assert.equal(attr.endedAt, '2024-01-01T01:00:00.000Z');
  });
});

// ─── outcome round-trips ─────────────────────────────────────────────────────

describe('buildRunAttribution — outcome round-trips across all four values', () => {
  const OUTCOMES: RunOutcome[] = ['done', 'failed', 'gate_passed', 'gate_failed'];

  for (const outcome of OUTCOMES) {
    it(`outcome='${outcome}' maps correctly`, () => {
      const attr = buildRunAttribution(baseState({ outcome }));
      assert.equal(attr.outcome, outcome);
    });
  }

  it('omits outcome when undefined', () => {
    const attr = buildRunAttribution(baseState({ outcome: undefined }));
    assert.equal('outcome' in attr, false);
  });
});

// ─── integration: persists to run_metrics via withRunMetrics ─────────────────

describe('buildRunAttribution integration — persists via withRunMetrics', () => {
  it('setAttribution with buildRunAttribution result persists all fields to run_metrics', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.setAttribution(buildRunAttribution({
        scope: 'epic',
        epicId: 'epic-001',
        storyCount: 2,
        retryCount: 0,
        cleanRetryCount: 0,
        autoRecoveryCount: 0,
        outcome: 'done',
        intakeVerdict: 'epic',
        intakeKind: 'feature',
        startedAt: '2024-01-01T10:00:00.000Z',
        endedAt: '2024-01-01T10:30:00.000Z',
      }));
    });

    const row = db.prepare('SELECT * FROM run_metrics LIMIT 1').get() as Record<string, unknown> | undefined;
    assert.ok(row, 'run_metrics row should exist');
    assert.equal(row['scope'], 'epic');
    assert.equal(row['epic_id'], 'epic-001');
    assert.equal(row['story_count'], 2);
    assert.equal(row['retry_count'], 0);
    assert.equal(row['clean_retry_count'], 0);
    assert.equal(row['auto_recovery_count'], 0);
    assert.equal(row['outcome'], 'done');
    assert.equal(row['intake_verdict'], 'epic');
    assert.equal(row['intake_kind'], 'feature');
    assert.equal(row['started_at'], '2024-01-01T10:00:00.000Z');
    assert.equal(row['ended_at'], '2024-01-01T10:30:00.000Z');
    db.close();
  });

  it('all four outcomes round-trip through recordRun', async () => {
    const OUTCOMES: RunOutcome[] = ['done', 'failed', 'gate_passed', 'gate_failed'];
    for (const outcome of OUTCOMES) {
      const db = makeDb();
      insertEpic(db, 'epic-001');
      const store = new MetricsStore(db);
      await withRunMetrics({ scope: 'epic', store }, async (c) => {
        c.setAttribution(buildRunAttribution(baseState({ outcome })));
      });
      const row = db.prepare('SELECT outcome FROM run_metrics LIMIT 1').get() as { outcome: string } | undefined;
      assert.equal(row?.outcome, outcome, `outcome='${outcome}' should persist`);
      db.close();
    }
  });

  it('non-zero retryCount, cleanRetryCount, autoRecoveryCount persist correctly', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);
    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({
        retryCount: 1,
        cleanRetryCount: 2,
        autoRecoveryCount: 2,
      })));
    });
    const row = db.prepare('SELECT retry_count, clean_retry_count, auto_recovery_count FROM run_metrics LIMIT 1')
      .get() as { retry_count: number; clean_retry_count: number; auto_recovery_count: number } | undefined;
    assert.equal(row?.retry_count, 1);
    assert.equal(row?.clean_retry_count, 2);
    assert.equal(row?.auto_recovery_count, 2);
    db.close();
  });
});

// ─── exactly-once: recordRun called once per withRunMetrics invocation ────────

describe('buildRunAttribution — exactly-once recordRun guarantee', () => {
  it('recordRun is called exactly once even when setAttribution is called multiple times', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      // Multiple setAttribution calls accumulate (merge) — only one recordRun fires.
      c.setAttribution({ epicId: 'epic-001' });
      c.setAttribution(buildRunAttribution(baseState({ outcome: 'done' })));
    });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM run_metrics').get() as { n: number }).n;
    assert.equal(count, 1, 'exactly one run_metrics row per withRunMetrics invocation');
    db.close();
  });

  it('recordRun is called once for the epic path and once for the standalone path (two separate calls)', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store1 = new MetricsStore(db);
    const db2 = makeDb();
    const store2 = new MetricsStore(db2);

    await withRunMetrics({ scope: 'epic', store: store1 }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({ scope: 'epic', epicId: 'epic-001' })));
    });
    await withRunMetrics({ scope: 'standalone_story', store: store2 }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({ scope: 'standalone_story', epicId: undefined, storyId: 'story-002' })));
    });

    const epicCount = (db.prepare('SELECT COUNT(*) AS n FROM run_metrics').get() as { n: number }).n;
    assert.equal(epicCount, 1, 'one row from epic path');
    const standaloneCount = (db2.prepare('SELECT COUNT(*) AS n FROM run_metrics').get() as { n: number }).n;
    assert.equal(standaloneCount, 1, 'one row from standalone path');
    db.close();
    db2.close();
  });
});

// ─── fail-open: attribution failure must not propagate into the run ───────────

describe('buildRunAttribution — fail-open (ADR-006)', () => {
  it('recordRun throwing inside withRunMetrics does not propagate into the run result', async () => {
    // Exercise the actual production fail-open path: withRunMetrics's finally block
    // catches and drops store.recordRun errors without perturbing the run.
    const brokenStore = {
      recordRun(): never { throw new Error('simulated persistence failure'); },
    } as unknown as MetricsStore;

    const result = await withRunMetrics({ scope: 'epic', store: brokenStore }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState()));
      return 'run-result';
    });

    assert.equal(result, 'run-result', 'run result must be unaffected by a recordRun failure');
  });

  it('setAttribution throwing inside the fn try/catch does not propagate into the run', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);

    const result = await withRunMetrics({ scope: 'epic', store }, async (c) => {
      try {
        // Simulate a broken buildRunAttribution call inside the production attribution block.
        const badAttr = () => { throw new Error('attribution build failure'); };
        c.setAttribution(badAttr());
      } catch {
        // fail-open — swallow attribution errors (mirrors Supervisor/Planner pattern)
      }
      return 'run-ok';
    });

    assert.equal(result, 'run-ok', 'run result must be unaffected by a setAttribution failure');
    db.close();
  });
});

// ─── scope mismatch: setAttribution overrides withRunMetrics init scope ──────

describe('buildRunAttribution — scope mismatch override', () => {
  it('setAttribution with standalone_story scope overrides an epic init scope in the persisted row', async () => {
    // Production pattern: withRunMetrics init scope may differ from the scope
    // computed at the terminal region. setAttribution must fully override scope.
    const db = makeDb();
    const store = new MetricsStore(db);

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({ scope: 'standalone_story', epicId: undefined, storyId: 'story-007' })));
    });

    const row = db.prepare('SELECT scope FROM run_metrics LIMIT 1').get() as { scope: string } | undefined;
    assert.equal(row?.scope, 'standalone_story', 'setAttribution scope must override the withRunMetrics init scope');
    db.close();
  });
});

// ─── resume idempotency: second run creates a new correlated row ──────────────

describe('buildRunAttribution — resume idempotency', () => {
  it('a second withRunMetrics invocation creates a new, distinct row (not a dup of the first)', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);

    // First run
    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({
        retryCount: 0,
        startedAt: '2024-01-01T10:00:00.000Z',
      })));
    });

    // Second run (resume/retry) — legitimately creates a new row
    const store2 = new MetricsStore(db);
    await withRunMetrics({ scope: 'epic', store: store2 }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({
        retryCount: 1,  // signals this is a retry
        startedAt: '2024-01-01T11:00:00.000Z',
      })));
    });

    const rows = db.prepare('SELECT retry_count, started_at FROM run_metrics ORDER BY id ASC').all() as Array<{ retry_count: number; started_at: string }>;
    assert.equal(rows.length, 2, 'two distinct rows — no dedup, no overwrites');
    assert.equal(rows[0].retry_count, 0, 'first run has retryCount=0');
    assert.equal(rows[1].retry_count, 1, 'second run has retryCount=1 (correctly attributed as retry)');
    assert.notEqual(rows[0].started_at, rows[1].started_at, 'different startedAt values for each run');
    db.close();
  });

  it('each row is correlated by the same epicId + distinct startedAt', async () => {
    const db = makeDb();
    insertEpic(db, 'epic-001');
    const store = new MetricsStore(db);

    await withRunMetrics({ scope: 'epic', store }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({
        epicId: 'epic-001',
        startedAt: '2024-01-01T10:00:00.000Z',
      })));
    });

    const store2 = new MetricsStore(db);
    await withRunMetrics({ scope: 'epic', store: store2 }, async (c) => {
      c.setAttribution(buildRunAttribution(baseState({
        epicId: 'epic-001',
        retryCount: 1,
        startedAt: '2024-01-01T11:00:00.000Z',
      })));
    });

    const rows = db.prepare('SELECT epic_id, started_at FROM run_metrics ORDER BY id ASC').all() as Array<{ epic_id: string; started_at: string }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].epic_id, 'epic-001', 'both rows share the same epicId (correlation)');
    assert.equal(rows[1].epic_id, 'epic-001');
    assert.notEqual(rows[0].started_at, rows[1].started_at, 'distinct startedAt values differentiate run attempts');
    db.close();
  });
});
