import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDatabase } from '../../state/Database.js';
import { OpportunityStore } from '../OpportunityStore.js';
import { opportunityKey, type OpportunityRecord } from '../OpportunityEngine.js';

function seedEpic(db: Database.Database, epicId: string): void {
  db.prepare('INSERT INTO epics (id, title) VALUES (?, ?)').run(epicId, `Epic ${epicId}`);
}

function makeOpp(
  overrides: Partial<OpportunityRecord> & { key: string; title: string }
): OpportunityRecord {
  const now = new Date().toISOString();
  return {
    id: 0,
    key: overrides.key,
    title: overrides.title,
    rationale: overrides.rationale ?? 'Test rationale',
    impact: overrides.impact ?? 0.5,
    effort: overrides.effort ?? 0.5,
    confidence: overrides.confidence ?? 0.5,
    score: overrides.score ?? 0.5,
    rank: overrides.rank ?? 1,
    status: overrides.status ?? 'open',
    signal_count: overrides.signal_count ?? 1,
    member_keys: overrides.member_keys ?? ['sig-default'],
    evidence: overrides.evidence ?? [],
    scoped_epic_id: overrides.scoped_epic_id ?? null,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

// ─── UPSERT non-resurrection (ADR-004) ───────────────────────────────────────

describe('OpportunityStore — UPSERT non-resurrection (ADR-004)', () => {
  it('refreshes an open opportunity on matching key', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    const key = opportunityKey(['sig-1', 'sig-2']);
    store.upsertRanked([makeOpp({ key, title: 'Original', score: 0.5, rank: 1 })]);

    const result = store.upsertRanked([makeOpp({ key, title: 'Updated', score: 0.9, rank: 1 })]);

    assert.equal(result.refreshed, 1);
    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, 0);

    const rows = store.listRanked();
    assert.equal(rows.length, 1, 'still exactly one row');
    assert.equal(rows[0].title, 'Updated');
    assert.equal(rows[0].score, 0.9);
  });

  it('never resurfaces a scoped opportunity — keyed assertion on opportunity.key', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    const key = opportunityKey(['sig-scoped']);
    store.upsertRanked([makeOpp({ key, title: 'To Be Scoped', score: 0.7, rank: 1 })]);

    const [inserted] = store.listRanked();
    seedEpic(db, 'epic-42');
    store.markScoped(inserted.id, 'epic-42');

    const result = store.upsertRanked([makeOpp({ key, title: 'Resurface Attempt', score: 0.9, rank: 1 })]);

    assert.equal(result.skipped, 1, 'scoped key must be skipped');
    assert.equal(result.inserted, 0);
    assert.equal(result.refreshed, 0);

    const [row] = store.listRanked();
    assert.equal(row.key, key, 'key assertion');
    assert.equal(row.status, 'scoped', 'status must remain scoped');
    assert.equal(row.title, 'To Be Scoped', 'title must not change');
    assert.equal(row.scoped_epic_id, 'epic-42', 'scoped_epic_id preserved');
  });

  it('never resurfaces a dismissed opportunity — keyed assertion on opportunity.key', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    const key = opportunityKey(['sig-dismissed']);
    store.upsertRanked([makeOpp({ key, title: 'To Be Dismissed', score: 0.5, rank: 1 })]);

    const [inserted] = store.listRanked();
    store.markDismissed(inserted.id);

    const result = store.upsertRanked([makeOpp({ key, title: 'Resurface Attempt', score: 0.9, rank: 1 })]);

    assert.equal(result.skipped, 1, 'dismissed key must be skipped');

    const [row] = store.listRanked();
    assert.equal(row.key, key, 'key assertion');
    assert.equal(row.status, 'dismissed', 'status must remain dismissed');
    assert.equal(row.title, 'To Be Dismissed', 'title must not change');
  });

  it('in one batch: open key refreshed; scoped and dismissed keys skipped', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    const openKey = opportunityKey(['open-sig']);
    const scopedKey = opportunityKey(['scoped-sig']);
    const dismissedKey = opportunityKey(['dismissed-sig']);

    store.upsertRanked([
      makeOpp({ key: openKey, title: 'Open', rank: 1 }),
      makeOpp({ key: scopedKey, title: 'Scoped', rank: 2 }),
      makeOpp({ key: dismissedKey, title: 'Dismissed', rank: 3 }),
    ]);

    const all = store.listRanked();
    const scoped = all.find((r) => r.key === scopedKey)!;
    const dismissed = all.find((r) => r.key === dismissedKey)!;
    seedEpic(db, 'epic-scoped');
    store.markScoped(scoped.id, 'epic-scoped');
    store.markDismissed(dismissed.id);

    const result = store.upsertRanked([
      makeOpp({ key: openKey, title: 'Open Updated', score: 0.9, rank: 1 }),
      makeOpp({ key: scopedKey, title: 'Scoped Updated', score: 0.9, rank: 2 }),
      makeOpp({ key: dismissedKey, title: 'Dismissed Updated', score: 0.9, rank: 3 }),
    ]);

    assert.equal(result.inserted, 0);
    assert.equal(result.refreshed, 1, 'only open key refreshed');
    assert.equal(result.skipped, 2, 'scoped + dismissed skipped');

    const updated = store.listRanked();
    const openRow = updated.find((r) => r.key === openKey)!;
    const scopedRow = updated.find((r) => r.key === scopedKey)!;
    const dismissedRow = updated.find((r) => r.key === dismissedKey)!;

    assert.equal(openRow.title, 'Open Updated');
    assert.equal(scopedRow.title, 'Scoped', 'scoped title unchanged');
    assert.equal(dismissedRow.title, 'Dismissed', 'dismissed title unchanged');
  });
});

// ─── Persistence — rationale, evidence, signal_count ─────────────────────────

describe('OpportunityStore — persistence', () => {
  it('stores and retrieves rationale, evidence links, and signal_count', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    const key = opportunityKey(['p1', 'p2']);
    const evidence = [
      { title: 'File TODO', url: 'src/foo.ts:42' },
      { title: 'Issue #5', url: 'https://github.com/org/repo/issues/5' },
    ];
    store.upsertRanked([
      makeOpp({
        key,
        title: 'T',
        rationale: 'Detailed rationale explaining the opportunity in full',
        signal_count: 5,
        member_keys: ['p1', 'p2'],
        evidence,
      }),
    ]);

    const [row] = store.listRanked();
    assert.equal(row.rationale, 'Detailed rationale explaining the opportunity in full');
    assert.equal(row.signal_count, 5);
    assert.deepEqual(row.evidence, evidence);
    assert.deepEqual(row.member_keys, ['p1', 'p2']);
  });

  it('empty upsert returns zeros', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);
    const result = store.upsertRanked([]);
    assert.equal(result.inserted, 0);
    assert.equal(result.refreshed, 0);
    assert.equal(result.skipped, 0);
  });
});

// ─── listRanked ───────────────────────────────────────────────────────────────

describe('OpportunityStore — listRanked', () => {
  it('returns all rows ordered by rank ASC', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([
      makeOpp({ key: opportunityKey(['a']), title: 'Low', score: 0.3, rank: 3 }),
      makeOpp({ key: opportunityKey(['b']), title: 'High', score: 0.9, rank: 1 }),
      makeOpp({ key: opportunityKey(['c']), title: 'Mid', score: 0.6, rank: 2 }),
    ]);

    const rows = store.listRanked();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
  });

  it('filters by status', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([
      makeOpp({ key: opportunityKey(['x']), title: 'X', score: 0.9, rank: 1 }),
      makeOpp({ key: opportunityKey(['y']), title: 'Y', score: 0.5, rank: 2 }),
    ]);

    const [, second] = store.listRanked();
    store.markDismissed(second.id);

    const open = store.listRanked({ status: 'open' });
    assert.equal(open.length, 1);
    assert.equal(open[0].title, 'X');
  });

  it('respects limit', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([
      makeOpp({ key: opportunityKey(['1']), title: '1', rank: 1 }),
      makeOpp({ key: opportunityKey(['2']), title: '2', rank: 2 }),
      makeOpp({ key: opportunityKey(['3']), title: '3', rank: 3 }),
    ]);

    const limited = store.listRanked({ limit: 2 });
    assert.equal(limited.length, 2);
  });
});

// ─── get / getByEpicId ────────────────────────────────────────────────────────

describe('OpportunityStore — get / getByEpicId', () => {
  it('get returns the row by id', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([makeOpp({ key: opportunityKey(['gk']), title: 'GetMe' })]);
    const [row] = store.listRanked();
    const found = store.get(row.id);

    assert.ok(found, 'should return the row');
    assert.equal(found!.title, 'GetMe');
  });

  it('get returns undefined for unknown id', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);
    assert.equal(store.get(99999), undefined);
  });

  it('getByEpicId finds a scoped opportunity by its epic id', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([makeOpp({ key: opportunityKey(['es']), title: 'Scope Me' })]);
    const [row] = store.listRanked();
    seedEpic(db, 'epic-scoped-001');
    store.markScoped(row.id, 'epic-scoped-001');

    const found = store.getByEpicId('epic-scoped-001');
    assert.ok(found);
    assert.equal(found!.scoped_epic_id, 'epic-scoped-001');
    assert.equal(found!.status, 'scoped');
  });
});

// ─── Lifecycle mutations ──────────────────────────────────────────────────────

describe('OpportunityStore — lifecycle mutations', () => {
  it('markScoped sets status=scoped and scoped_epic_id', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([makeOpp({ key: opportunityKey(['sc']), title: 'Scope Test' })]);
    const [row] = store.listRanked();

    seedEpic(db, 'epic-999');
    store.markScoped(row.id, 'epic-999');
    const updated = store.get(row.id)!;
    assert.equal(updated.status, 'scoped');
    assert.equal(updated.scoped_epic_id, 'epic-999');
  });

  it('markDismissed sets status=dismissed', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([makeOpp({ key: opportunityKey(['dm']), title: 'Dismiss Test' })]);
    const [row] = store.listRanked();

    store.markDismissed(row.id);
    assert.equal(store.get(row.id)!.status, 'dismissed');
  });

  it('reopen sets status=open and clears scoped_epic_id', () => {
    const db = createDatabase(':memory:');
    const store = new OpportunityStore(db);

    store.upsertRanked([makeOpp({ key: opportunityKey(['ro']), title: 'Reopen Test' })]);
    const [row] = store.listRanked();

    seedEpic(db, 'epic-77');
    store.markScoped(row.id, 'epic-77');
    store.reopen(row.id);

    const updated = store.get(row.id)!;
    assert.equal(updated.status, 'open');
    assert.equal(updated.scoped_epic_id, null);
  });
});
