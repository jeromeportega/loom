/**
 * Express-layer integration tests for the five POST mutation endpoints:
 * approve, reject, kill, retry, and stop.
 *
 * Auth-failure tests use readOnly=true so that a missing or invalid
 * x-loom-token on any mutation returns 403 (the documented public-facing
 * behavior). Happy-path tests use the same readOnly=true server with the
 * valid write token.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

const TOKEN = 'test-mutation-token-abc';

async function launch(): Promise<{
  db: Database.Database;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mut-test-'));
  fs.mkdirSync(path.join(projectRoot, '.loom', 'logs'), { recursive: true });
  // readOnly=true: GET/HEAD pass without token; mutations require the token (→ 403 without it).
  const app = createApp({
    db,
    token: TOKEN,
    ssePollMs: 50,
    loomBin: ['true'],
    projectRoot,
    readOnly: true,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) {
    throw new Error('server.address() returned unexpected shape');
  }
  return {
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(projectRoot, { recursive: true, force: true });
          err ? reject(err) : resolve();
        })
      ),
  };
}

// Per-test fresh server + DB + isolated LOOM_HOME (mirrors server.test.ts pattern).
let db: Database.Database;
let baseUrl: string;
let close: () => Promise<void>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

const withToken: Record<string, string> = {
  'x-loom-token': TOKEN,
  'content-type': 'application/json',
};
const noToken: Record<string, string> = { 'content-type': 'application/json' };
const invalidToken: Record<string, string> = {
  'x-loom-token': 'wrong-token',
  'content-type': 'application/json',
};

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mut-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  ({ db, baseUrl, close } = await launch());
});

afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── POST /api/epics/:id/approve ─────────────────────────────────────────────

describe('mutations — POST /api/epics/:id/approve', () => {
  it('happy path: valid token + planned epic → 200 { status: dispatching, epic_id }', async () => {
    new EpicStore(db).create('epic-approve-001', 'Feature A');
    const res = await fetch(`${baseUrl}/api/epics/epic-approve-001/approve`, {
      method: 'POST',
      headers: withToken,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; epic_id: string };
    assert.equal(body.status, 'dispatching');
    assert.equal(body.epic_id, 'epic-approve-001');
  });

  it('auth failure: missing x-loom-token → 403', async () => {
    new EpicStore(db).create('epic-approve-002', 'Feature B');
    const res = await fetch(`${baseUrl}/api/epics/epic-approve-002/approve`, {
      method: 'POST',
      headers: noToken,
    });
    assert.equal(res.status, 403);
  });

  it('auth failure: invalid x-loom-token → 403', async () => {
    new EpicStore(db).create('epic-approve-003', 'Feature C');
    const res = await fetch(`${baseUrl}/api/epics/epic-approve-003/approve`, {
      method: 'POST',
      headers: invalidToken,
    });
    assert.equal(res.status, 403);
  });
});

// ─── POST /api/epics/:id/reject ──────────────────────────────────────────────

describe('mutations — POST /api/epics/:id/reject', () => {
  it('happy path: valid token + planned epic → 200 { status: rejected, epic_id }', async () => {
    new EpicStore(db).create('epic-reject-001', 'Too broad');
    const res = await fetch(`${baseUrl}/api/epics/epic-reject-001/reject`, {
      method: 'POST',
      headers: withToken,
      body: JSON.stringify({ reason: 'needs more scoping' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; epic_id: string };
    assert.equal(body.status, 'rejected');
    assert.equal(body.epic_id, 'epic-reject-001');

    // The reason must actually persist, not just echo in the response. This is
    // the seam a mocked-out client test can't see: if express.json() were ever
    // mounted after the routes, or the body field renamed, the reason would
    // silently drop while the 200 above stayed green. Assert both sinks —
    // epics.reason and the audit_log row that backs the "recorded in the audit
    // log" promise on the dashboard textarea.
    const stored = db
      .prepare('SELECT reason FROM epics WHERE id = ?')
      .get('epic-reject-001') as { reason: string | null };
    assert.equal(stored.reason, 'needs more scoping');
    const audit = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'epic_rejected' AND command = ?")
      .get('epic-reject-001') as { detail: string | null } | undefined;
    assert.ok(audit, 'expected an epic_rejected audit_log row');
    assert.deepEqual(JSON.parse(audit.detail as string), { reason: 'needs more scoping' });
  });

  it('happy path: blank/omitted reason → 200, reason persists as NULL', async () => {
    new EpicStore(db).create('epic-reject-blank', 'No reason given');
    const res = await fetch(`${baseUrl}/api/epics/epic-reject-blank/reject`, {
      method: 'POST',
      headers: withToken,
    });
    assert.equal(res.status, 200);
    const stored = db
      .prepare('SELECT reason FROM epics WHERE id = ?')
      .get('epic-reject-blank') as { reason: string | null };
    assert.equal(stored.reason, null);
  });

  it('auth failure: missing x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-reject-001/reject`, {
      method: 'POST',
      headers: noToken,
      body: JSON.stringify({ reason: 'nope' }),
    });
    assert.equal(res.status, 403);
  });

  it('auth failure: invalid x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-reject-001/reject`, {
      method: 'POST',
      headers: invalidToken,
      body: JSON.stringify({ reason: 'nope' }),
    });
    assert.equal(res.status, 403);
  });
});

// ─── POST /api/agents/:id/kill ───────────────────────────────────────────────

describe('mutations — POST /api/agents/:id/kill', () => {
  let child: ReturnType<typeof spawn> | undefined;

  afterEach(() => {
    if (child?.exitCode === null) child.kill();
    child = undefined;
  });

  it('happy path: valid token + agent with active pid → 200 { status: killed, pid, story_id }', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-kill-001', 'Kill target epic');
    const a = agents.create('epic-kill-001', 'story-kill-001', 'Story to kill');

    // Spawn a real process so the kill handler can SIGTERM it.
    child = spawn('sleep', ['100'], { stdio: 'ignore' });
    child.unref();
    if (child.pid == null) throw new Error('sleep did not start — pid is undefined');
    const pid = child.pid;
    agents.updateWorkerPid(a.id, pid);

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/kill`, {
      method: 'POST',
      headers: withToken,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; pid: number; story_id: string };
    assert.equal(body.status, 'killed');
    assert.equal(body.pid, pid);
    assert.equal(body.story_id, 'story-kill-001');
  });

  it('auth failure: missing x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-any-id/kill`, {
      method: 'POST',
      headers: noToken,
    });
    assert.equal(res.status, 403);
  });

  it('auth failure: invalid x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-any-id/kill`, {
      method: 'POST',
      headers: invalidToken,
    });
    assert.equal(res.status, 403);
  });
});

// ─── POST /api/stories/:storyId/retry ────────────────────────────────────────

describe('mutations — POST /api/stories/:storyId/retry', () => {
  it('happy path (resume): valid token + failed story → 200 { status: dispatching, story_id, clean: false }', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-retry-001', 'Retry target');
    epics.updateStatus('epic-retry-001', 'in_progress');
    const a = agents.create('epic-retry-001', 'story-retry-001', 'Failing story');
    agents.updateStatus(a.id, 'failed');

    const res = await fetch(`${baseUrl}/api/stories/story-retry-001/retry`, {
      method: 'POST',
      headers: withToken,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      status: string;
      story_id: string;
      clean: boolean;
    };
    assert.equal(body.status, 'dispatching');
    assert.equal(body.story_id, 'story-retry-001');
    assert.equal(body.clean, false);
  });

  it('happy path (clean-retry): body { clean: true } → 200 with clean: true', async () => {
    const epics = new EpicStore(db);
    const agents = new AgentStore(db);
    epics.create('epic-retry-002', 'Clean retry target');
    epics.updateStatus('epic-retry-002', 'in_progress');
    const a = agents.create('epic-retry-002', 'story-retry-002', 'Failing story 2');
    agents.updateStatus(a.id, 'failed');

    const res = await fetch(`${baseUrl}/api/stories/story-retry-002/retry`, {
      method: 'POST',
      headers: withToken,
      body: JSON.stringify({ clean: true }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; clean: boolean };
    assert.equal(body.status, 'dispatching');
    assert.equal(body.clean, true);
  });

  it('auth failure: missing x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/stories/story-any-id/retry`, {
      method: 'POST',
      headers: noToken,
    });
    assert.equal(res.status, 403);
  });

  it('auth failure: invalid x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/stories/story-any-id/retry`, {
      method: 'POST',
      headers: invalidToken,
    });
    assert.equal(res.status, 403);
  });
});

// ─── POST /api/stop ──────────────────────────────────────────────────────────

describe('mutations — POST /api/stop', () => {
  it('happy path: valid token → 200 { status: stopping }', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: withToken,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'stopping');
  });

  it('auth failure: missing x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: noToken,
    });
    assert.equal(res.status, 403);
  });

  it('auth failure: invalid x-loom-token → 403', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: invalidToken,
    });
    assert.equal(res.status, 403);
  });
});
