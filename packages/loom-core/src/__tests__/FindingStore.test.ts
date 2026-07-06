/**
 * Unit tests for FindingStore — saveFindings, getByStory, getByAgent.
 * Uses an in-memory SQLite database via createDatabase(':memory:').
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../state/Database.js';
import { FindingStore, SEVERITY_MAP } from '../state/FindingStore.js';
import type { StoredFinding } from '../state/FindingStore.js';
import type { ReviewFinding } from '../review/types.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Insert a minimal agent row so FK constraints pass. */
function seedAgent(db: Database.Database, agentId: string, storyId = 'story-001-001'): void {
  db.exec(`
    INSERT OR IGNORE INTO epics (id, title, status)
    VALUES ('epic-001', 'Test Epic', 'approved');
  `);
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, epic_id, story_id, status, updated_at)
    VALUES (?, 'epic-001', ?, 'pending', datetime('now'))
  `).run(agentId, storyId);
}

const SAMPLE_FINDINGS: ReviewFinding[] = [
  { severity: 'blocker',   file: 'src/foo.ts', line: 10, issue: 'Null deref',   suggestion: 'Add null check' },
  { severity: 'should-fix', file: 'src/bar.ts', line: 42, issue: 'Dead code',   suggestion: undefined },
  { severity: 'nit',        file: 'src/baz.ts',            issue: 'Typo in var' },
];

describe('FindingStore', () => {
  describe('saveFindings / getByAgent — basic round-trip', () => {
    it('persists all findings and maps severity correctly', () => {
      const db = makeDb();
      seedAgent(db, 'agent-a1', 'story-001-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-a1', 'story-001-001', SAMPLE_FINDINGS);
      const rows = store.getByAgent('agent-a1');

      assert.equal(rows.length, 3, 'all three findings must be stored');

      const blocker = rows.find((r) => r.severity === 'blocking')!;
      assert.ok(blocker, 'blocker finding must be stored as "blocking"');
      assert.equal(blocker.file, 'src/foo.ts');
      assert.equal(blocker.line, 10);
      assert.equal(blocker.message, 'Null deref');
      assert.equal(blocker.suggestion, 'Add null check');
      assert.equal(blocker.agent_id, 'agent-a1');
      assert.equal(blocker.story_id, 'story-001-001');

      const medium = rows.find((r) => r.severity === 'medium')!;
      assert.ok(medium, 'should-fix finding must be stored as "medium"');
      assert.equal(medium.file, 'src/bar.ts');
      assert.equal(medium.suggestion, null, 'undefined suggestion must be stored as null');

      const low = rows.find((r) => r.severity === 'low')!;
      assert.ok(low, 'nit finding must be stored as "low"');
      assert.equal(low.line, null, 'missing line must be stored as null');
      assert.equal(low.suggestion, null);
    });

    it('each StoredFinding has a numeric id and ISO 8601 recorded_at', () => {
      const db = makeDb();
      seedAgent(db, 'agent-a2', 'story-001-001');
      const store = new FindingStore(db);
      store.saveFindings('agent-a2', 'story-001-001', SAMPLE_FINDINGS);

      const rows = store.getByAgent('agent-a2');
      for (const row of rows) {
        assert.equal(typeof row.id, 'number', 'id must be a number (AUTOINCREMENT)');
        assert.match(
          row.recorded_at,
          /^\d{4}-\d{2}-\d{2}/,
          'recorded_at must look like an ISO 8601 date',
        );
      }
    });
  });

  describe('saveFindings — idempotent replace semantics', () => {
    it('replaces prior findings on second call for same agentId', () => {
      const db = makeDb();
      seedAgent(db, 'agent-replace', 'story-002-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-replace', 'story-002-001', SAMPLE_FINDINGS);
      assert.equal(store.getByAgent('agent-replace').length, 3, '3 findings after first save');

      const onlyOne: ReviewFinding[] = [
        { severity: 'blocker', file: 'new.ts', line: 1, issue: 'Critical bug' },
      ];
      store.saveFindings('agent-replace', 'story-002-001', onlyOne);

      const rows = store.getByAgent('agent-replace');
      assert.equal(rows.length, 1, 'second save must replace all prior rows — only 1 remains');
      assert.equal(rows[0].file, 'new.ts');
    });

    it('saving an empty findings array clears prior findings', () => {
      const db = makeDb();
      seedAgent(db, 'agent-clear', 'story-003-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-clear', 'story-003-001', SAMPLE_FINDINGS);
      store.saveFindings('agent-clear', 'story-003-001', []);

      assert.equal(store.getByAgent('agent-clear').length, 0, 'empty save must clear all findings');
    });
  });

  describe('getByStory — latest-agent semantics', () => {
    it('returns findings for the most recent agent attempt, not earlier ones', () => {
      const db = makeDb();
      seedAgent(db, 'agent-old', 'story-004-001');
      seedAgent(db, 'agent-new', 'story-004-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-old', 'story-004-001', [
        { severity: 'blocker', file: 'old.ts', line: 1, issue: 'Old bug' },
      ]);

      // Small delay ensures recorded_at for agent-new > agent-old
      const laterTime = new Date(Date.now() + 1000).toISOString().replace('T', ' ').replace('Z', '');
      db.prepare(
        "INSERT INTO review_findings (agent_id, story_id, severity, file, line, message, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run('agent-new', 'story-004-001', 'medium', 'new.ts', 5, 'New issue', laterTime);

      const rows = store.getByStory('story-004-001');
      assert.equal(rows.length, 1, 'getByStory returns only latest agent findings');
      assert.equal(rows[0].file, 'new.ts', 'finding must be from the newer agent');
      assert.equal(rows[0].agent_id, 'agent-new');
    });

    it('orders findings by severity rank then recorded_at ASC', () => {
      const db = makeDb();
      seedAgent(db, 'agent-ord', 'story-005-001');
      const store = new FindingStore(db);

      const findings: ReviewFinding[] = [
        { severity: 'nit',        file: 'c.ts', issue: 'Nit' },
        { severity: 'blocker',    file: 'a.ts', issue: 'Blocker' },
        { severity: 'should-fix', file: 'b.ts', issue: 'Should fix' },
      ];
      store.saveFindings('agent-ord', 'story-005-001', findings);

      const rows = store.getByStory('story-005-001');
      assert.equal(rows.length, 3);
      assert.equal(rows[0].severity, 'blocking', 'blocking first');
      assert.equal(rows[1].severity, 'medium',   'medium second');
      assert.equal(rows[2].severity, 'low',       'low third');
    });

    it('returns empty array when no findings for a story', () => {
      const db = makeDb();
      const store = new FindingStore(db);
      const rows = store.getByStory('story-nonexistent');
      assert.deepEqual(rows, []);
    });
  });

  describe('SEVERITY_MAP', () => {
    it('maps all ReviewFinding severities to StoredFinding severities', () => {
      assert.equal(SEVERITY_MAP['blocker'],    'blocking');
      assert.equal(SEVERITY_MAP['should-fix'], 'medium');
      assert.equal(SEVERITY_MAP['nit'],        'low');
    });
  });
});
