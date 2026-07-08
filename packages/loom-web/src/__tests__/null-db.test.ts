/**
 * story-085-002 — Graceful null-currentProject handling
 *
 * Verifies that every db-scoped route returns 204 (or a defined empty payload)
 * when the server is started with db: null, and that "agnostic" routes
 * (health, repos) continue to return 200. Also verifies that routes which
 * delegate to resolveProjectDb return 404 (not 500) when no current project
 * exists, and that no unhandledRejection event fires.
 *
 * All tests use createApp({ db: null, projectRoot: null, unifiedRegistry: new Map(), token: 'test' })
 * running on an ephemeral HTTP port so route handlers are exercised end-to-end.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';

const TOKEN = 'test';
const AUTH = { 'x-loom-token': TOKEN };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

// ─── Test server setup ────────────────────────────────────────────────────────

let baseUrl: string;
let server: http.Server;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

before(async () => {
  // Isolate the machine-level loom home so the ProjectRegistry in repos.ts
  // returns an empty list rather than picking up the developer's real projects.
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-null-db-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  const app = createApp({ db: null, projectRoot: null, unifiedRegistry: new Map(), token: TOKEN });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('bad addr');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => {
        fs.rmSync(loomHomeDir, { recursive: true, force: true });
        if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
        else process.env.LOOM_HOME = prevLoomHome;
        err ? reject(err) : resolve();
      })
    )
);

// ─── Agnostic routes: must still return 200 ──────────────────────────────────

describe('null-db server — agnostic routes unaffected', () => {
  it('GET /api/health → 200 { ok: true }', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it('GET /api/repos → 200 { repos: [] } (empty registry)', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { repos: unknown[] };
    assert.ok(Array.isArray(body.repos));
    assert.equal(body.repos.length, 0);
  });

  it('GET /api/repos is JSON (not 204 or 404)', async () => {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: AUTH });
    assert.ok(
      res.headers.get('content-type')?.includes('application/json'),
      `content-type should be application/json, got: ${res.headers.get('content-type')}`
    );
    assert.notEqual(res.status, 204, '/api/repos must not return 204');
    assert.notEqual(res.status, 404, '/api/repos must not return 404');
  });
});

// ─── db-scoped routes: must return 204 ────────────────────────────────────────
//
// Enumerate every inline route in index.ts that touches epicStore, agentStore,
// auditLog, skillStore, decisionTraces, or workerLogs. Each must return 204
// when db is null (the blanket null-db handler fires for all these).

describe('null-db server — db-scoped routes return 204', () => {
  it('GET /api/status → 204', async () => {
    const res = await fetch(`${baseUrl}/api/status`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/epics/:id → 204', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/epics/:id/planning-artifacts → 204', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/planning-artifacts`, {
      headers: AUTH,
    });
    assert.equal(res.status, 204);
  });

  it('GET /api/agents/:id → 204', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-001`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/agents/:id/log → 204', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-001/log`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/agents/:id/audit → 204', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-001/audit`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/agents/:id/traces → 204', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-001/traces`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/epics/:id/traces → 204', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/traces`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/skills → 204', async () => {
    const res = await fetch(`${baseUrl}/api/skills`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/skills/:name/history → 204', async () => {
    const res = await fetch(`${baseUrl}/api/skills/jwt-auth/history`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/cost → 204', async () => {
    const res = await fetch(`${baseUrl}/api/cost`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/projects → 204', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('POST /api/epics/:id/archive → 204', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/archive`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 204);
  });

  it('GET /api/inbox → 204 (inbox uses agentStore)', async () => {
    const res = await fetch(`${baseUrl}/api/inbox`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/lessons → 204', async () => {
    const res = await fetch(`${baseUrl}/api/lessons`, { headers: AUTH });
    assert.equal(res.status, 204);
  });

  it('GET /api/opportunities → 204', async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`, { headers: AUTH });
    assert.equal(res.status, 204);
  });
});

// ─── resolveProjectDb null guard: routes using it return 404 ─────────────────
//
// Mutation routes call resolveProjectDb(req) before any db access. When db is
// null, the null resolver throws a 404-coded error, which the catch block in
// each handler converts to a 404 JSON response.

describe('null-db server — resolveProjectDb null guard returns 404', () => {
  it('POST /api/epics/:id/approve → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/approve`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(typeof body.error === 'string', 'error field should be a string');
  });

  it('POST /api/epics/:id/reject → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/reject`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ reason: 'test' }),
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/stories/:id/retry → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/stories/story-001-001/retry`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/stop → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/stop`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/epics/:id/resume → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-001/resume`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });

  it('POST /api/agents/:id/kill → 404 (no current project)', async () => {
    const res = await fetch(`${baseUrl}/api/agents/agent-001/kill`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
  });
});

// ─── No 5xx responses — mutation routes ──────────────────────────────────────
//
// GET routes are already verified by the 204 suite above (204 is implicitly < 500).
// This suite focuses on mutation routes: approve/reject/retry go through
// resolveProjectDb (→ 404), stop/resume/kill likewise; archive hits the blanket
// 204 handler. None should 500.

describe('null-db server — no 5xx responses from mutation routes', () => {
  const routes: Array<{ method: string; path: string }> = [
    { method: 'POST', path: '/api/epics/epic-001/approve' },
    { method: 'POST', path: '/api/epics/epic-001/reject' },
    { method: 'POST', path: '/api/stories/story-001-001/retry' },
    { method: 'POST', path: '/api/stop' },
    { method: 'POST', path: '/api/epics/epic-001/resume' },
    { method: 'POST', path: '/api/agents/agent-001/kill' },
    { method: 'POST', path: '/api/epics/epic-001/archive' },
  ];

  for (const { method, path: routePath } of routes) {
    it(`${method} ${routePath} must not return 5xx`, async () => {
      const res = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: JSON_AUTH,
        ...(method !== 'GET' ? { body: JSON.stringify({}) } : {}),
      });
      assert.ok(
        res.status < 500,
        `${method} ${routePath} returned ${res.status}, expected < 500`
      );
    });
  }
});

// ─── No unhandledRejection events ─────────────────────────────────────────────

describe('null-db server — no unhandledRejection fires when traversing all routes', () => {
  it('runs through all guarded routes without triggering unhandledRejection', async () => {
    const rejections: string[] = [];
    const handler = (reason: unknown) => {
      rejections.push(String(reason));
    };
    process.on('unhandledRejection', handler);

    try {
      const routes: Array<{ method: string; path: string }> = [
        { method: 'GET', path: '/api/status' },
        { method: 'GET', path: '/api/epics/epic-001' },
        { method: 'GET', path: '/api/agents/agent-001' },
        { method: 'GET', path: '/api/skills' },
        { method: 'GET', path: '/api/cost' },
        { method: 'GET', path: '/api/repos' },
        { method: 'POST', path: '/api/epics/epic-001/approve' },
        { method: 'POST', path: '/api/epics/epic-001/reject' },
      ];

      for (const { method, path: routePath } of routes) {
        const res = await fetch(`${baseUrl}${routePath}`, {
          method,
          headers: JSON_AUTH,
          ...(method !== 'GET' ? { body: JSON.stringify({}) } : {}),
        });
        // Just ensure no 500+
        assert.ok(res.status < 500, `${method} ${routePath} returned ${res.status}`);
      }

      // Allow event loop to flush any pending microtasks / rejections.
      // A wider window (10ms) catches async middleware that settles after a single tick.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(rejections, [], 'no unhandledRejection events should fire');
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
  });
});
