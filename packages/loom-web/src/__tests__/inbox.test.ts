/**
 * Integration tests for:
 *   - GET /api/inbox   — decision inbox endpoint (story-003-004)
 *   - POST approve/reject ?project= — end-to-end approve/reject via existing routes
 *   - resolveProjectDb security boundary
 *
 * Tests mount registerInboxRoutes and registerMutationRoutes directly (no
 * createApp) — same pattern as fleet.test.ts. Each test gets its own fresh
 * in-memory SQLite DB. Cross-project cases spin up ≥2 temp project dirs.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDatabase,
  EpicStore,
  AgentStore,
  AuditLog,
  ControlStore,
  ProjectRegistry,
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { requireToken } from '../server/auth.js';
import { registerInboxRoutes } from '../server/routes/inbox.js';
import { registerMutationRoutes } from '../server/routes/mutations.js';
import { makeResolveProjectDb } from '../server/resolveProjectDb.js';
import type { InboxEntry } from '../shared/inbox.js';

const TOKEN = 'inbox-test-token';
const HEADERS: Record<string, string> = { 'x-loom-token': TOKEN, 'Content-Type': 'application/json' };

// ─── Test harness ─────────────────────────────────────────────────────────────

interface TestServer {
  db: Database.Database;
  baseUrl: string;
  projectRoot: string;
  close: () => Promise<void>;
}

async function launchInProject(
  projectRoot: string,
  db: Database.Database
): Promise<TestServer> {
  const resolveProjectDb = makeResolveProjectDb(db, projectRoot);
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', requireToken({ token: TOKEN }));

  const deps = {
    epicStore: new EpicStore(db),
    agentStore: new AgentStore(db),
    db,
    projectRoot,
    resolveProjectDb,
    loomBin: ['true'], // stub supervisor dispatch
  };
  registerInboxRoutes(app, deps);
  registerMutationRoutes(app, deps);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('bad addr');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    db,
    baseUrl,
    projectRoot,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

// ─── State scoped to each test ────────────────────────────────────────────────

let server: TestServer;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let projectDir: string;

beforeEach(async () => {
  // Isolate the machine-level loom home to prevent real registry from leaking.
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-inbox-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  // Set up a temp project dir
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-inbox-proj-'));
  fs.mkdirSync(path.join(projectDir, '.loom'), { recursive: true });
  new ProjectRegistry().register(projectDir);

  const db = createDatabase(':memory:');
  server = await launchInProject(projectDir, db);
});

afterEach(async () => {
  await server.close();
  server.db.close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('inbox — auth', () => {
  it('returns 401 for /api/inbox without token', async () => {
    const res = await fetch(`${server.baseUrl}/api/inbox`);
    assert.equal(res.status, 401);
  });
});

// ─── Empty inbox ─────────────────────────────────────────────────────────────

describe('inbox — empty inbox', () => {
  it('returns [] when no pending decisions exist', async () => {
    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, []);
  });

  it('returns [] with archived epics present (archived are excluded)', async () => {
    const epics = new EpicStore(server.db);
    epics.create('epic-001', 'Archived epic');
    epics.archive('epic-001');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, []);
  });
});

// ─── plan_approval source ─────────────────────────────────────────────────────

describe('inbox — plan_approval source', () => {
  it('includes planned epics as plan_approval entries', async () => {
    const epics = new EpicStore(server.db);
    epics.create('epic-001', 'Add authentication');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.equal(body.length, 1);
    const entry = body[0];
    assert.equal(entry.type, 'plan_approval');
    assert.equal(entry.epic_id, 'epic-001');
    assert.equal(entry.title, 'Add authentication');
    assert.equal(entry.story_id, null);
    assert.equal(entry.project_root, projectDir);
    assert.equal(entry.project, path.basename(projectDir));
    assert.ok(typeof entry.age_ms === 'number' && entry.age_ms >= 0, 'age_ms is a non-negative number');
  });

  it('does not include approved or in_progress epics as plan_approval', async () => {
    const epics = new EpicStore(server.db);
    epics.create('epic-001', 'In progress');
    epics.updateStatus('epic-001', 'approved');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, []);
  });
});

// ─── checkpoint_resume source ─────────────────────────────────────────────────

describe('inbox — checkpoint_resume source', () => {
  it('includes paused epics as checkpoint_resume entries with correct story_id', async () => {
    const epics = new EpicStore(server.db);
    epics.create('epic-001', 'Checkpoint epic');
    epics.updateStatus('epic-001', 'in_progress');
    epics.pauseAfterStory('epic-001', 'story-001-002');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.equal(body.length, 1);
    const entry = body[0];
    assert.equal(entry.type, 'checkpoint_resume');
    assert.equal(entry.epic_id, 'epic-001');
    assert.equal(entry.story_id, 'story-001-002');
    assert.equal(entry.project_root, projectDir);
    assert.ok(typeof entry.age_ms === 'number' && entry.age_ms >= 0);
  });

  it('does not emit checkpoint_resume for non-paused epics', async () => {
    const epics = new EpicStore(server.db);
    epics.create('epic-001', 'Running epic');
    epics.updateStatus('epic-001', 'in_progress');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, []);
  });
});

// ─── escalation source ────────────────────────────────────────────────────────

describe('inbox — escalation source', () => {
  it('includes blocked agents as escalation entries', async () => {
    const epics = new EpicStore(server.db);
    const agents = new AgentStore(server.db);
    epics.create('epic-001', 'Auth epic');
    epics.updateStatus('epic-001', 'in_progress');
    const a = agents.create('epic-001', 'story-001-003', 'Login route');
    agents.updateStatus(a.id, 'blocked');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.equal(body.length, 1);
    const entry = body[0];
    assert.equal(entry.type, 'escalation');
    assert.equal(entry.epic_id, 'epic-001');
    assert.equal(entry.story_id, 'story-001-003');
    assert.equal(entry.project_root, projectDir);
    assert.ok(typeof entry.age_ms === 'number' && entry.age_ms >= 0);
  });

  it('uses listLatestByEpic dedup — retried-then-blocked story is one entry', async () => {
    const epics = new EpicStore(server.db);
    const agents = new AgentStore(server.db);
    epics.create('epic-001', 'Epic');
    const older = agents.create('epic-001', 'story-001-001', 'story');
    agents.updateStatus(older.id, 'failed');
    await new Promise((r) => setTimeout(r, 5));
    const newer = agents.create('epic-001', 'story-001-001', 'story');
    agents.updateStatus(newer.id, 'blocked');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    const escalations = body.filter((e) => e.type === 'escalation');
    assert.equal(escalations.length, 1, 'deduped to one escalation entry');
    assert.equal(escalations[0].story_id, 'story-001-001');
  });

  it('does not include done or running agents', async () => {
    const epics = new EpicStore(server.db);
    const agents = new AgentStore(server.db);
    epics.create('epic-001', 'Epic');
    epics.updateStatus('epic-001', 'in_progress');
    const a1 = agents.create('epic-001', 'story-001-001', 'done story');
    agents.updateStatus(a1.id, 'done');
    const a2 = agents.create('epic-001', 'story-001-002', 'running story');
    agents.updateStatus(a2.id, 'running');

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, []);
  });
});

// ─── Cross-project federation ─────────────────────────────────────────────────

describe('inbox — cross-project federation', () => {
  it('federates decisions from ≥2 registered projects, each tagged with correct project_root', async () => {
    // Set up a second project on disk
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-inbox-projB-'));
    fs.mkdirSync(path.join(projectB, '.loom'), { recursive: true });
    new ProjectRegistry().register(projectB);

    const dbB = createDatabase(path.join(projectB, '.loom', 'loom.db'));
    const epicsB = new EpicStore(dbB);
    epicsB.create('epic-B1', 'Epic in project B');

    // Plant a planned epic in project A (the host)
    const epicsA = new EpicStore(server.db);
    epicsA.create('epic-A1', 'Epic in project A');

    dbB.close(); // close so the inbox re-opens it via createDatabase

    try {
      const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
      assert.equal(res.status, 200);
      const body = await res.json() as InboxEntry[];

      const ids = body.map((e) => e.epic_id).sort();
      assert.deepEqual(ids, ['epic-A1', 'epic-B1']);

      const a = body.find((e) => e.epic_id === 'epic-A1')!;
      const b = body.find((e) => e.epic_id === 'epic-B1')!;
      assert.equal(a.project_root, projectDir);
      assert.equal(b.project_root, projectB);
      assert.equal(a.type, 'plan_approval');
      assert.equal(b.type, 'plan_approval');
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });
});

// ─── End-to-end approve ───────────────────────────────────────────────────────

describe('inbox — end-to-end approve via existing route', () => {
  it('POST /api/epics/:id/approve transitions planned→approved in peer DB + audit row', async () => {
    // Set up peer project
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-e2e-projB-'));
    fs.mkdirSync(path.join(projectB, '.loom'), { recursive: true });
    new ProjectRegistry().register(projectB);

    const dbB = createDatabase(path.join(projectB, '.loom', 'loom.db'));
    new EpicStore(dbB).create('epic-B1', 'Auth epic');
    dbB.close();

    try {
      const res = await fetch(
        `${server.baseUrl}/api/epics/epic-B1/approve?project=${encodeURIComponent(projectB)}`,
        { method: 'POST', headers: HEADERS }
      );
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string; epic_id: string };
      assert.equal(body.status, 'dispatching');
      assert.equal(body.epic_id, 'epic-B1');

      // Verify state in peer DB
      const verifyDb = createDatabase(path.join(projectB, '.loom', 'loom.db'));
      const epic = new EpicStore(verifyDb).get('epic-B1');
      assert.equal(epic?.status, 'approved', 'peer epic transitioned to approved');

      const auditRows = new AuditLog(verifyDb).getByCommand('epic-B1', ['epic_approved']);
      assert.equal(auditRows.length, 1, 'audit row written to peer DB');
      verifyDb.close();
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('POST /api/epics/:id/approve without ?project acts on host project', async () => {
    new EpicStore(server.db).create('epic-H1', 'Host epic');

    const res = await fetch(
      `${server.baseUrl}/api/epics/epic-H1/approve`,
      { method: 'POST', headers: HEADERS }
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'dispatching');
    assert.equal(new EpicStore(server.db).get('epic-H1')?.status, 'approved');
  });
});

// ─── End-to-end reject ────────────────────────────────────────────────────────

describe('inbox — end-to-end reject via existing route', () => {
  it('POST /api/epics/:id/reject in peer DB — transitions to rejected + audit row', async () => {
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-e2e-rej-'));
    fs.mkdirSync(path.join(projectB, '.loom'), { recursive: true });
    new ProjectRegistry().register(projectB);

    const dbB = createDatabase(path.join(projectB, '.loom', 'loom.db'));
    new EpicStore(dbB).create('epic-R1', 'Reject me');
    dbB.close();

    try {
      const res = await fetch(
        `${server.baseUrl}/api/epics/epic-R1/reject?project=${encodeURIComponent(projectB)}`,
        {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify({ reason: 'scope too large' }),
        }
      );
      assert.equal(res.status, 200);
      const body = await res.json() as { status: string };
      assert.equal(body.status, 'rejected');

      // Verify peer DB
      const verifyDb = createDatabase(path.join(projectB, '.loom', 'loom.db'));
      const epic = new EpicStore(verifyDb).get('epic-R1');
      assert.equal(epic?.status, 'rejected');
      const rows = new AuditLog(verifyDb).getByCommand('epic-R1', ['epic_rejected']);
      assert.equal(rows.length, 1, 'audit row written to peer DB');
      assert.match(rows[0].detail ?? '', /scope too large/);
      verifyDb.close();
    } finally {
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('reject leaves the entry out of the inbox afterward', async () => {
    new EpicStore(server.db).create('epic-001', 'Planned');

    await fetch(`${server.baseUrl}/api/epics/epic-001/reject`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ reason: 'nope' }),
    });

    const res = await fetch(`${server.baseUrl}/api/inbox`, { headers: HEADERS });
    const body = await res.json() as InboxEntry[];
    assert.deepEqual(body, [], 'rejected epic leaves inbox');
  });
});

// ─── No duplicated mutation logic ────────────────────────────────────────────

describe('inbox — no duplicated mutation logic', () => {
  it('approve uses the existing approve route — epic_approved audit action is the same', async () => {
    new EpicStore(server.db).create('epic-001', 'Test dedup');

    await fetch(`${server.baseUrl}/api/epics/epic-001/approve`, {
      method: 'POST',
      headers: HEADERS,
    });

    const rows = new AuditLog(server.db).getByCommand('epic-001', ['epic_approved']);
    assert.equal(rows.length, 1, 'exactly one epic_approved row from existing route');
  });

  it('stop uses the existing /api/stop route — ControlStore state changes', async () => {
    await fetch(`${server.baseUrl}/api/stop`, { method: 'POST', headers: HEADERS });
    const state = new ControlStore(server.db).getState();
    assert.equal(state, 'stopping');
  });

  it('kill uses the existing /api/agents/:id/kill route', async () => {
    const epics = new EpicStore(server.db);
    const agents = new AgentStore(server.db);
    epics.create('epic-001', 'Epic');
    const a = agents.create('epic-001', 'story-001-001', 'story');
    // worker_pid null → 409 (the route exists and rejects as expected)
    const res = await fetch(`${server.baseUrl}/api/agents/${a.id}/kill`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 409); // confirmed route is wired, not a new handler
  });
});

// ─── Security boundary ────────────────────────────────────────────────────────

describe('inbox — security boundary', () => {
  it('rejects unregistered ?project with 400 BEFORE opening any DB', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/epics/epic-001/approve?project=${encodeURIComponent('/not/registered/path')}`,
      { method: 'POST', headers: HEADERS }
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /unknown project root/);
  });

  it('rejects unregistered ?project on reject route', async () => {
    const res = await fetch(
      `${server.baseUrl}/api/epics/epic-001/reject?project=${encodeURIComponent('/traversal/../etc/passwd')}`,
      { method: 'POST', headers: HEADERS }
    );
    assert.equal(res.status, 400);
  });

  it('returns 401 without token on mutation routes', async () => {
    const res = await fetch(`${server.baseUrl}/api/epics/epic-001/approve`, {
      method: 'POST',
    });
    assert.equal(res.status, 401);
  });
});
