/**
 * Integration tests for:
 *   - GET /api/inbox — proposed epics surface as plan_approval entries
 *   - POST /api/propose — mission-control button for self-proposed epics
 *
 * Tests use the real createApp() with injected stub refiner/planner so no
 * actual LLM calls are made.
 *
 * Owner: story-005-006
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, ProjectRegistry } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import type { BriefRefinement } from '@loom-ai/core';
import { createApp } from '../server/index.js';
import type { InboxEntry } from '../shared/inbox.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN = 'propose-test-token';
const HEADERS: Record<string, string> = {
  'x-loom-token': TOKEN,
  'Content-Type': 'application/json',
};

function makePassRefinement(rough: string): BriefRefinement {
  return {
    ready: true,
    original: rough,
    refined_brief: '# Proposed Epic\n\nA well-scoped plan.',
    quality_score: 8,
    critique: {
      strong_points: ['clear'],
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
      ambiguities: ['too vague'],
      missing_scope: [],
      untestable_claims: [],
      hidden_complexity: [],
    },
    questions: ['What is the goal?'],
    delta: { added_sections: [], clarifications: [], flagged_assumptions: [] },
  };
}

async function launch(db: Database.Database, projectRoot: string, opts: {
  _proposeBriefRefiner?: { refine(r: string): Promise<BriefRefinement> };
  _proposePlanner?: { run(b: string): Promise<{ epicIds: string[] }> };
} = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = createApp({
    db,
    token: TOKEN,
    readOnly: false,
    projectRoot,
    _proposeBriefRefiner: opts._proposeBriefRefiner as Parameters<typeof createApp>[0]['_proposeBriefRefiner'],
    _proposePlanner: opts._proposePlanner,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad addr');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let srv: { baseUrl: string; close: () => Promise<void> };
let db: Database.Database;
let projectDir: string;
let loomHomeDir: string;
let prevLoomHome: string | undefined;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-web-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-propose-web-proj-'));
  fs.mkdirSync(path.join(projectDir, '.loom'), { recursive: true });
  new ProjectRegistry().register(projectDir);

  db = createDatabase(':memory:');
});

afterEach(async () => {
  await srv?.close().catch(() => {});
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── Inbox surfacing ──────────────────────────────────────────────────────────

describe('propose — inbox surfacing', () => {
  it('proposed epic (proposed_by=loom) appears in GET /api/inbox as plan_approval', async () => {
    srv = await launch(db, projectDir);

    // Create a planned epic and stamp proposed_by='loom' (simulating proposeNextEpic output)
    const store = new EpicStore(db);
    store.create('epic-proposed-01', 'Loom-proposed: improve CI');
    store.setProposedBy('epic-proposed-01', 'loom');

    const res = await fetch(`${srv.baseUrl}/api/inbox`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = await res.json() as InboxEntry[];

    const entry = body.find((e) => e.epic_id === 'epic-proposed-01');
    assert.ok(entry, 'proposed epic must appear in inbox');
    assert.equal(entry.type, 'plan_approval');
    assert.equal(entry.epic_id, 'epic-proposed-01');
  });

  it('proposed epic stays planned — no auto-approve transition from GET /api/inbox', async () => {
    srv = await launch(db, projectDir);

    const store = new EpicStore(db);
    store.create('epic-p2', 'Proposal that must wait');
    store.setProposedBy('epic-p2', 'loom');

    // GET /api/inbox must not change epic status
    await fetch(`${srv.baseUrl}/api/inbox`, { headers: HEADERS });

    const epic = store.get('epic-p2');
    assert.equal(epic?.status, 'planned', 'inbox fetch must not auto-approve');
  });
});

// ─── POST /api/propose ────────────────────────────────────────────────────────

describe('POST /api/propose', () => {
  it('returns {ok:true, epicId} when brief quality gate passes', async () => {
    const epicId = 'epic-propose-web-01';
    new EpicStore(db).create(epicId, 'Test Epic');

    srv = await launch(db, projectDir, {
      _proposeBriefRefiner: { async refine(rough) { return makePassRefinement(rough); } },
      _proposePlanner: { async run() { return { epicIds: [epicId] }; } },
    });

    const res = await fetch(`${srv.baseUrl}/api/propose`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; epicId?: string };
    assert.equal(body.ok, true);
    assert.equal(body.epicId, epicId);
  });

  it('returns {ok:false, critique} when brief quality gate fails', async () => {
    srv = await launch(db, projectDir, {
      _proposeBriefRefiner: { async refine(rough) { return makeFailRefinement(rough); } },
      _proposePlanner: { async run() { throw new Error('should not be called'); } },
    });

    const res = await fetch(`${srv.baseUrl}/api/propose`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; critique?: unknown };
    assert.equal(body.ok, false);
    assert.ok(body.critique, 'critique must be included on gate fail');
  });

  it('returns 401 without write token', async () => {
    srv = await launch(db, projectDir);
    const res = await fetch(`${srv.baseUrl}/api/propose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
  });

  it('stamps proposed_by=loom on the resulting epic', async () => {
    const epicId = 'epic-stamp-01';
    new EpicStore(db).create(epicId, 'Test Epic');

    srv = await launch(db, projectDir, {
      _proposeBriefRefiner: { async refine(rough) { return makePassRefinement(rough); } },
      _proposePlanner: { async run() { return { epicIds: [epicId] }; } },
    });

    await fetch(`${srv.baseUrl}/api/propose`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({}),
    });

    const row = db
      .prepare('SELECT proposed_by, status FROM epics WHERE id = ?')
      .get(epicId) as { proposed_by: string | null; status: string };
    assert.equal(row.proposed_by, 'loom');
    assert.equal(row.status, 'planned', 'epic stays planned after propose');
  });
});
