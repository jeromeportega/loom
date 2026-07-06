/**
 * Tests for story-076-002: block-and-revise core instrumentation.
 * Covers:
 *   - AgentStore.incrementReviseRound / getReviseRound
 *   - Supervisor.runRevisionLoop (findings persistence + revise_round wiring)
 *   - FindingStore.getByStory severity ordering
 *
 * All tests use a real in-memory SQLite database (not mocked).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations, createDatabase } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { FindingStore } from '../state/FindingStore.js';
import { EpicStore } from '../state/EpicStore.js';
import { Supervisor } from '../orchestrator/Supervisor.js';
import type { ReviewFinding } from '../review/types.js';
import type { WorkerRunner, WorkerAssignment, WorkerResult } from '../orchestrator/WorkerRunner.js';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedAgent(
  db: Database.Database,
  agentId: string,
  storyId = 'story-001-001',
  epicId = 'epic-001'
): void {
  db.prepare(
    'INSERT OR IGNORE INTO epics (id, title, status) VALUES (?, ?, ?)'
  ).run(epicId, 'Test Epic', 'approved');
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, epic_id, story_id, status, updated_at)
    VALUES (?, ?, ?, 'pending', datetime('now'))
  `).run(agentId, epicId, storyId);
}

// ---------------------------------------------------------------------------
// AgentStore additions: incrementReviseRound / getReviseRound
// ---------------------------------------------------------------------------

describe('AgentStore — incrementReviseRound / getReviseRound (story-076-002)', () => {
  it('[AC-A1] getReviseRound returns 0 for a freshly inserted agent', () => {
    const db = makeDb();
    seedAgent(db, 'agent-zero', 'story-001-001');
    const agents = new AgentStore(db);
    assert.equal(agents.getReviseRound('agent-zero'), 0, 'fresh agent must have revise_round=0');
  });

  it('[AC-A2] getReviseRound returns 0 defensively for unknown agentId', () => {
    const db = makeDb();
    const agents = new AgentStore(db);
    assert.equal(agents.getReviseRound('agent-nonexistent'), 0, 'unknown agent must return 0 defensively');
  });

  it('[AC-A3] incrementReviseRound: first call increments to 1', () => {
    const db = makeDb();
    seedAgent(db, 'agent-inc', 'story-002-001');
    const agents = new AgentStore(db);

    agents.incrementReviseRound('agent-inc');
    assert.equal(agents.getReviseRound('agent-inc'), 1, 'first increment must set revise_round=1');
  });

  it('[AC-A4] incrementReviseRound: second call increments to 2', () => {
    const db = makeDb();
    seedAgent(db, 'agent-inc2', 'story-003-001');
    const agents = new AgentStore(db);

    agents.incrementReviseRound('agent-inc2');
    agents.incrementReviseRound('agent-inc2');
    assert.equal(agents.getReviseRound('agent-inc2'), 2, 'two increments must set revise_round=2');
  });

  it('[AC-A5] incrementReviseRound throws for unknown agentId', () => {
    const db = makeDb();
    const agents = new AgentStore(db);
    assert.throws(
      () => agents.incrementReviseRound('agent-does-not-exist'),
      /AgentNotFoundError/,
      'incrementReviseRound must throw when agent is not found'
    );
  });
});

// ---------------------------------------------------------------------------
// Minimal WorkerRunner stub for Supervisor construction
// ---------------------------------------------------------------------------

const NOOP_WORKER: WorkerRunner = {
  run: async (_assignment: WorkerAssignment): Promise<WorkerResult> => ({
    status: 'done',
    commitCount: 0,
    summary: 'stub',
    logTail: '',
  }),
};

function makeSupervisor(db: Database.Database, projectRoot: string): Supervisor {
  return new Supervisor({
    projectRoot,
    db,
    worker: NOOP_WORKER,
    maxConcurrent: 1,
    lease: false,
  });
}

// ---------------------------------------------------------------------------
// Supervisor.runRevisionLoop wiring (integration tests, real SQLite)
// ---------------------------------------------------------------------------

describe('Supervisor.runRevisionLoop — block-and-revise instrumentation (story-076-002)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sr-'));
    fs.mkdirSync(path.join(tmpDir, '.loom'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('[AC-S1] two-round loop: saveFindings called after each pass, incrementReviseRound called once', async () => {
    const db = makeDb();
    seedAgent(db, 'agent-two', 'story-004-001');

    const agents = new AgentStore(db);
    const findingStore = new FindingStore(db);

    const BLOCKER: ReviewFinding = { severity: 'blocker', file: 'src/a.ts', line: 5, issue: 'Null deref' };
    const NIT: ReviewFinding = { severity: 'nit', file: 'src/b.ts', issue: 'Typo' };

    let passCount = 0;
    const runPass = async (_revisionIndex: number): Promise<ReviewFinding[]> => {
      passCount++;
      // Round 1: returns a blocker (triggers revision). Round 2: clean.
      return passCount === 1 ? [BLOCKER] : [NIT];
    };

    const supervisor = makeSupervisor(db, tmpDir);
    const result = await supervisor.runRevisionLoop('agent-two', 'story-004-001', {
      blockAndRevise: true,
      maxRevisions: 2,
      runPass,
    });

    assert.equal(result.revisions, 1, 'one revision must have occurred');
    assert.equal(passCount, 2, 'runPass must be called twice (initial + 1 revision)');

    // revise_round incremented once (at start of revision round 2, not round 1)
    assert.equal(
      agents.getReviseRound('agent-two'),
      1,
      'revise_round must be 1 after one revision round'
    );

    // saveFindings overwrites on each pass — only the last pass's findings remain
    const stored = findingStore.getByAgent('agent-two');
    assert.equal(stored.length, 1, 'only the last pass findings must survive (delete-before-insert)');
    assert.equal(stored[0].severity, 'low', 'last pass nit must be stored as "low"');
  });

  it('[AC-S2] pass on first review: revise_round stays 0, saveFindings called once with clean findings', async () => {
    const db = makeDb();
    seedAgent(db, 'agent-clean', 'story-005-001');

    const agents = new AgentStore(db);
    const findingStore = new FindingStore(db);

    let passCount = 0;
    const runPass = async (_revisionIndex: number): Promise<ReviewFinding[]> => {
      passCount++;
      return []; // no findings — passes immediately
    };

    const supervisor = makeSupervisor(db, tmpDir);
    const result = await supervisor.runRevisionLoop('agent-clean', 'story-005-001', {
      blockAndRevise: true,
      maxRevisions: 2,
      runPass,
    });

    assert.equal(result.revisions, 0, 'no revisions when first pass is clean');
    assert.equal(passCount, 1, 'runPass called exactly once');
    assert.equal(
      agents.getReviseRound('agent-clean'),
      0,
      'revise_round must remain 0 when no revision rounds occur'
    );

    // saveFindings was called once with empty array
    const stored = findingStore.getByAgent('agent-clean');
    assert.deepEqual(stored, [], 'empty findings must be persisted (no rows)');
  });

  it('[AC-S3] revise callback receives prior findings and controls continuation', async () => {
    const db = makeDb();
    seedAgent(db, 'agent-revise-cb', 'story-006-001');

    const BLOCKER: ReviewFinding = { severity: 'blocker', file: 'x.ts', issue: 'Bug' };
    let reviseFindingsReceived: ReviewFinding[] | undefined;
    let reviseIndexReceived: number | undefined;

    const supervisor = makeSupervisor(db, tmpDir);
    await supervisor.runRevisionLoop('agent-revise-cb', 'story-006-001', {
      blockAndRevise: true,
      maxRevisions: 3,
      runPass: async (idx) => (idx === 0 ? [BLOCKER] : []),
      revise: async (findings, revisionIndex) => {
        reviseFindingsReceived = findings;
        reviseIndexReceived = revisionIndex;
        return true; // proceed with revision
      },
    });

    assert.deepEqual(
      reviseFindingsReceived?.map((f) => f.issue),
      ['Bug'],
      'revise callback must receive the prior pass findings'
    );
    assert.equal(reviseIndexReceived, 1, 'revision index 1 on the first revision');
  });

  it('[AC-S4] revise callback returning false aborts the loop without incrementing revise_round', async () => {
    const db = makeDb();
    seedAgent(db, 'agent-abort', 'story-007-001');

    const BLOCKER: ReviewFinding = { severity: 'blocker', file: 'x.ts', issue: 'Bug' };

    let passCount = 0;
    const supervisor = makeSupervisor(db, tmpDir);
    const result = await supervisor.runRevisionLoop('agent-abort', 'story-007-001', {
      blockAndRevise: true,
      maxRevisions: 3,
      runPass: async () => { passCount++; return [BLOCKER]; },
      revise: async () => false, // abort immediately — no revision round executes
    });

    assert.equal(passCount, 1, 'only the initial pass runs when revise aborts');
    assert.equal(result.revisions, 0, 'no revisions when revise aborts before runPass');
    assert.equal(
      new AgentStore(db).getReviseRound('agent-abort'),
      0,
      'revise_round must not increment when revise aborts'
    );
  });

  it('[AC-S5] blockAndRevise=false: only the initial pass runs, no revisions', async () => {
    const db = makeDb();
    seedAgent(db, 'agent-norevise', 'story-008-001');

    const BLOCKER: ReviewFinding = { severity: 'blocker', file: 'x.ts', issue: 'Bug' };

    let passCount = 0;
    const supervisor = makeSupervisor(db, tmpDir);
    const result = await supervisor.runRevisionLoop('agent-norevise', 'story-008-001', {
      blockAndRevise: false,
      maxRevisions: 3,
      runPass: async () => { passCount++; return [BLOCKER]; },
    });

    assert.equal(passCount, 1, 'only initial pass when blockAndRevise=false');
    assert.equal(result.revisions, 0, 'no revisions when blockAndRevise=false');
    assert.equal(
      new AgentStore(db).getReviseRound('agent-norevise'),
      0,
      'revise_round stays 0 when blockAndRevise=false'
    );
  });
});

// ---------------------------------------------------------------------------
// FindingStore.getByStory ordering (severity rank: blocking → medium → low → info)
// ---------------------------------------------------------------------------

describe('FindingStore.getByStory ordering (story-076-002)', () => {
  it('[AC-F1] findings ordered blocking → medium → low → info', () => {
    const db = makeDb();
    seedAgent(db, 'agent-ord', 'story-009-001');
    const store = new FindingStore(db);

    const findings: ReviewFinding[] = [
      { severity: 'nit',        file: 'c.ts', issue: 'Nitpick' },
      { severity: 'blocker',    file: 'a.ts', issue: 'Blocker' },
      { severity: 'should-fix', file: 'b.ts', issue: 'Should fix' },
    ];
    store.saveFindings('agent-ord', 'story-009-001', findings);

    // 'info' has no upstream ReviewFinding source; insert directly to verify ordering.
    db.prepare(
      `INSERT INTO review_findings (agent_id, story_id, severity, file, line, message, suggestion)
       VALUES (?, ?, 'info', ?, NULL, ?, NULL)`
    ).run('agent-ord', 'story-009-001', 'd.ts', 'Info');

    const rows = store.getByStory('story-009-001');
    assert.equal(rows.length, 4);
    assert.equal(rows[0].severity, 'blocking', 'blocking must come first');
    assert.equal(rows[1].severity, 'medium',   'medium must come second');
    assert.equal(rows[2].severity, 'low',       'low must come third');
    assert.equal(rows[3].severity, 'info',      'info must come last');
  });
});
