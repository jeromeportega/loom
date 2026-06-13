/**
 * Integration tests for GET /api/lessons (flywheel board).
 *
 * All tests exercise the real createApp() with an in-memory SQLite DB
 * (per the orphaned-route lesson from epic-003: never test a hand-mounted
 * router, or the route can go unmounted and the tests still pass).
 *
 * Test plan covers:
 *   - Route mounted + read-only: 200 without a token in readOnly mode
 *   - LessonsResponse shape: lessons[], proposals[], empty flag
 *   - Federated content: applied_as/applied_ref in lessons; proposed_by='loom'
 *     + status='planned' in proposals
 *   - Empty state (FR-12): no lessons, no proposals → empty:true
 *
 * Owner: story-005-007
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, LessonStore, EpicStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
import type { LessonsResponse } from '../server/routes/lessons.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN = 'test-lessons-token-007';

async function launch(db: Database.Database): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const app = createApp({ db, token: TOKEN, readOnly: true });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

function seedLesson(db: Database.Database, epicId = 'epic-001'): number {
  const store = new LessonStore(db);
  const now = new Date().toISOString();
  const rows = store.insert([
    {
      epic_id: epicId,
      category: 'schema-migration',
      observation: 'Test observation about schema changes',
      root_cause: 'missing migration guard',
      general_rule: 'Always add a migration guard before altering a column',
      evidence: 'See epic-001 retrospective',
      applied_as: null,
      applied_ref: null,
      created_at: now,
    },
  ]);
  return rows[0].id;
}

function seedAppliedLesson(db: Database.Database): number {
  const store = new LessonStore(db);
  const now = new Date().toISOString();
  const rows = store.insert([
    {
      epic_id: 'epic-002',
      category: 'testing',
      observation: 'Integration tests catch orphaned routes',
      general_rule: 'Always test against real createApp, not a hand-mounted router',
      applied_as: 'worker_guidance',
      applied_ref: 'story-004-001',
      created_at: now,
    },
  ]);
  return rows[0].id;
}

function seedProposal(db: Database.Database): string {
  const epicId = 'epic-loom-proposal-001';
  const epicStore = new EpicStore(db);
  epicStore.create(epicId, 'Proposed improvement: refactor signals pipeline');
  // completePlanning leaves status='planned' which listByStatus('planned') picks up
  epicStore.completePlanning(epicId);
  epicStore.setProposedBy(epicId, 'loom');
  return epicId;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let db: Database.Database;
let baseUrl: string;
let close: () => Promise<void>;
let loomHomeDir: string;
let prevLoomHome: string | undefined;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lessons-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  db = createDatabase(':memory:');
  ({ baseUrl, close } = await launch(db));
});

afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── Route mounted + read-only ─────────────────────────────────────────────

describe('GET /api/lessons — route mounted via createApp', () => {
  it('returns 200 without a token in readOnly mode (public-read GET)', async () => {
    const res = await fetch(`${baseUrl}/api/lessons`);
    assert.equal(res.status, 200, 'GET /api/lessons must be public-read (asserting via createApp proves route is mounted)');
  });

  it('returns 200 with the token as well', async () => {
    const res = await fetch(`${baseUrl}/api/lessons`, {
      headers: { 'x-loom-token': TOKEN },
    });
    assert.equal(res.status, 200);
  });
});

// ─── Empty state (FR-12) ──────────────────────────────────────────────────────

describe('GET /api/lessons — empty state (FR-12)', () => {
  it('returns empty:true and empty arrays when no lessons or proposals exist', async () => {
    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.lessons), 'lessons is array');
    assert.ok(Array.isArray(body.proposals), 'proposals is array');
    assert.equal(body.lessons.length, 0, 'no lessons');
    assert.equal(body.proposals.length, 0, 'no proposals');
    assert.equal(body.empty, true, 'empty:true when nothing exists');
  });
});

// ─── LessonsResponse shape ────────────────────────────────────────────────────

describe('GET /api/lessons — LessonsResponse shape', () => {
  it('returns correct shape with required fields present', async () => {
    seedLesson(db);

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(res.status, 200);

    assert.ok(Array.isArray(body.lessons), 'lessons is array');
    assert.ok(Array.isArray(body.proposals), 'proposals is array');
    assert.equal(typeof body.empty, 'boolean', 'empty is boolean');

    const lesson = body.lessons[0];
    assert.ok(typeof lesson.id === 'number', 'lesson.id is number');
    assert.ok(typeof lesson.epic_id === 'string', 'lesson.epic_id is string');
    assert.ok(typeof lesson.category === 'string', 'lesson.category is string');
    assert.ok(typeof lesson.observation === 'string', 'lesson.observation is string');
    assert.ok(typeof lesson.general_rule === 'string', 'lesson.general_rule is string');
    assert.ok(typeof lesson.created_at === 'string', 'lesson.created_at is string');
    // applied_as and applied_ref may be null
    assert.ok('applied_as' in lesson, 'applied_as field present');
    assert.ok('applied_ref' in lesson, 'applied_ref field present');
  });

  it('returns empty:false when at least one lesson exists', async () => {
    seedLesson(db);
    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.empty, false, 'empty:false when lessons exist');
  });
});

// ─── Federated content ────────────────────────────────────────────────────────

describe('GET /api/lessons — federated content', () => {
  it('includes applied_as and applied_ref when a lesson has been applied', async () => {
    seedAppliedLesson(db);

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.lessons.length, 1);

    const lesson = body.lessons[0];
    assert.equal(lesson.applied_as, 'worker_guidance', 'applied_as reflects application');
    assert.equal(lesson.applied_ref, 'story-004-001', 'applied_ref shows where it was applied');
  });

  it('returns applied_as=null for unapplied lessons', async () => {
    seedLesson(db);

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.lessons[0].applied_as, null, 'applied_as is null for unapplied lesson');
    assert.equal(body.lessons[0].applied_ref, null, 'applied_ref is null for unapplied lesson');
  });

  it('proposals only include proposed_by=loom + status=planned epics', async () => {
    const epicId = seedProposal(db);

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.proposals.length, 1, 'one proposal');

    const proposal = body.proposals[0];
    assert.equal(proposal.epic_id, epicId, 'correct epic_id');
    assert.ok(typeof proposal.title === 'string', 'title is string');
    assert.ok(typeof proposal.created_at === 'string', 'created_at is string');
  });

  it('does NOT include human-initiated planned epics in proposals', async () => {
    // Create a human-initiated planned epic (proposed_by stays NULL)
    const epicStore = new EpicStore(db);
    epicStore.create('epic-human-001', 'Human-planned epic');
    epicStore.completePlanning('epic-human-001');

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.proposals.length, 0, 'human-initiated epics must not appear in proposals');
  });

  it('returns empty:false when proposals exist but no lessons', async () => {
    seedProposal(db);
    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.empty, false, 'empty:false when proposals exist');
    assert.equal(body.proposals.length, 1);
  });

  it('returns both lessons and proposals when both exist', async () => {
    seedLesson(db);
    seedAppliedLesson(db);
    seedProposal(db);

    const res = await fetch(`${baseUrl}/api/lessons`);
    const body = (await res.json()) as LessonsResponse;
    assert.equal(body.lessons.length, 2, 'both lessons returned');
    assert.equal(body.proposals.length, 1, 'one proposal returned');
    assert.equal(body.empty, false);
  });
});
