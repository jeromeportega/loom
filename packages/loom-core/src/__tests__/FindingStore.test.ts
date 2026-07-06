/**
 * Unit tests for FindingStore — saveFindings, getByStory, getByAgent.
 * FindingStore accepts the production Review-Forge `Finding` shape
 * (findings/schema.ts): severity blocker|high|medium|low|info, location.file/line,
 * description, suggested_fix.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../state/Database.js';
import { FindingStore, SEVERITY_MAP } from '../state/FindingStore.js';
import type { Finding, Severity } from '../findings/schema.js';

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

/** Build a production Finding with sane defaults. */
function f(
  severity: Severity,
  file: string,
  opts: { line?: number; description?: string; suggested_fix?: string } = {}
): Finding {
  return {
    severity,
    category: 'correctness',
    location: opts.line !== undefined ? { file, line: opts.line } : { file },
    description: opts.description ?? `${severity} issue in ${file}`,
    ...(opts.suggested_fix !== undefined ? { suggested_fix: opts.suggested_fix } : {}),
    source: 'adversarial-review',
  };
}

const SAMPLE_FINDINGS: Finding[] = [
  f('blocker', 'src/foo.ts', { line: 10, description: 'Null deref', suggested_fix: 'Add null check' }),
  f('medium',  'src/bar.ts', { line: 42, description: 'Dead code' }),
  f('low',     'src/baz.ts', { description: 'Typo in var' }),
];

describe('FindingStore', () => {
  describe('saveFindings / getByAgent — basic round-trip', () => {
    it('persists all findings and maps severity + fields correctly', () => {
      const db = makeDb();
      seedAgent(db, 'agent-a1', 'story-001-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-a1', 'story-001-001', SAMPLE_FINDINGS);
      const rows = store.getByAgent('agent-a1');

      assert.equal(rows.length, 3, 'all three findings must be stored');

      const blocker = rows.find((r) => r.severity === 'blocking')!;
      assert.ok(blocker, 'blocker finding must be stored as "blocking"');
      assert.equal(blocker.file, 'src/foo.ts');            // from location.file
      assert.equal(blocker.line, 10);                       // from location.line
      assert.equal(blocker.message, 'Null deref');          // from description
      assert.equal(blocker.suggestion, 'Add null check');   // from suggested_fix
      assert.equal(blocker.agent_id, 'agent-a1');
      assert.equal(blocker.story_id, 'story-001-001');

      const medium = rows.find((r) => r.severity === 'medium')!;
      assert.ok(medium, 'medium finding must be stored as "medium"');
      assert.equal(medium.file, 'src/bar.ts');
      assert.equal(medium.suggestion, null, 'absent suggested_fix must be stored as null');

      const low = rows.find((r) => r.severity === 'low')!;
      assert.ok(low, 'low finding must be stored as "low"');
      assert.equal(low.line, null, 'missing location.line must be stored as null');
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
        assert.match(row.recorded_at, /^\d{4}-\d{2}-\d{2}/, 'recorded_at must look like an ISO 8601 date');
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

      store.saveFindings('agent-replace', 'story-002-001', [
        f('blocker', 'new.ts', { line: 1, description: 'Critical bug' }),
      ]);

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

    it('clearByStory removes findings across ALL attempts of a story (clean-retry case)', () => {
      const db = makeDb();
      seedAgent(db, 'attempt-1', 'story-007-001');
      seedAgent(db, 'attempt-2', 'story-007-002'); // different story — must survive
      const store = new FindingStore(db);

      store.saveFindings('attempt-1', 'story-007-001', SAMPLE_FINDINGS);
      store.saveFindings('attempt-2', 'story-007-002', SAMPLE_FINDINGS);

      store.clearByStory('story-007-001');

      assert.equal(store.getByStory('story-007-001').length, 0, 'the cleared story has no findings');
      assert.equal(store.getByStory('story-007-002').length, 3, 'other stories are untouched');
    });
  });

  describe('getByStory — latest-agent semantics', () => {
    it('returns findings for the most recent agent attempt, not earlier ones', () => {
      const db = makeDb();
      seedAgent(db, 'agent-old', 'story-004-001');
      seedAgent(db, 'agent-new', 'story-004-001');
      const store = new FindingStore(db);

      store.saveFindings('agent-old', 'story-004-001', [f('blocker', 'old.ts', { line: 1, description: 'Old bug' })]);

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

      store.saveFindings('agent-ord', 'story-005-001', [
        f('low',     'c.ts', { description: 'Nit' }),
        f('blocker', 'a.ts', { description: 'Blocker' }),
        f('medium',  'b.ts', { description: 'Should fix' }),
      ]);

      const rows = store.getByStory('story-005-001');
      assert.equal(rows.length, 3);
      assert.equal(rows[0].severity, 'blocking', 'blocking first');
      assert.equal(rows[1].severity, 'medium',   'medium second');
      assert.equal(rows[2].severity, 'low',      'low third');
    });

    it('returns empty array when no findings for a story', () => {
      const db = makeDb();
      const store = new FindingStore(db);
      const rows = store.getByStory('story-nonexistent');
      assert.deepEqual(rows, []);
    });
  });

  describe('SEVERITY_MAP', () => {
    it('maps all production Finding severities to StoredFinding severities', () => {
      assert.equal(SEVERITY_MAP['blocker'], 'blocking');
      assert.equal(SEVERITY_MAP['high'],    'blocking', 'high folds into blocking (blocker-tier)');
      assert.equal(SEVERITY_MAP['medium'],  'medium');
      assert.equal(SEVERITY_MAP['low'],     'low');
      assert.equal(SEVERITY_MAP['info'],    'info');
    });

    it('a high-severity finding is stored and rendered as blocking', () => {
      const db = makeDb();
      seedAgent(db, 'agent-high', 'story-006-001');
      const store = new FindingStore(db);
      store.saveFindings('agent-high', 'story-006-001', [f('high', 'h.ts', { line: 3, description: 'perf regression' })]);
      const rows = store.getByAgent('agent-high');
      assert.equal(rows[0].severity, 'blocking');
    });
  });
});
