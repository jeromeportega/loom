import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createDatabase, EpicStore, AuditLog } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { requireToken } from '../server/auth.js';
import { registerAutonomyRoutes } from '../server/routes/autonomy.js';

const TOKEN = 'test-token-autonomy';

/** Minimal app: token guard + autonomy routes only. */
async function launch(): Promise<{
  db: Database.Database;
  epicStore: EpicStore;
  auditLog: AuditLog;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const epicStore = new EpicStore(db);
  const auditLog = new AuditLog(db);

  const app = express();
  app.use(express.json());
  app.use('/api', requireToken({ token: TOKEN }));
  registerAutonomyRoutes(app, { epicStore, auditLog });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected addr');
  return {
    db,
    epicStore,
    auditLog,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

let srv: Awaited<ReturnType<typeof launch>>;

beforeEach(async () => {
  srv = await launch();
  srv.epicStore.create('epic-001', 'Test Epic');
});
afterEach(async () => {
  await srv.close();
});

const authed = (opts: RequestInit = {}) => ({
  ...opts,
  headers: { 'x-loom-token': TOKEN, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
});

describe('POST /api/epics/:id/autonomy — happy path', () => {
  it('200 and returns { id, autonomy_level }', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'full-auto' }) }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; autonomy_level: string };
    assert.equal(body.id, 'epic-001');
    assert.equal(body.autonomy_level, 'full-auto');
  });

  it('persists the level so getAutonomy reflects the new value', async () => {
    await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'full-auto' }) }),
    });
    assert.equal(srv.epicStore.getAutonomy('epic-001'), 'full-auto');
  });

  it('writes an autonomy_set audit row with actor=web', async () => {
    await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'checkpoint' }) }),
    });
    const rows = srv.auditLog.getByCommand('epic-001').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.level, 'checkpoint');
    assert.equal(detail.actor, 'web');
  });

  it('supports all three levels', async () => {
    for (const level of ['full-auto', 'checkpoint', 'manual'] as const) {
      const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
        ...authed({ method: 'POST', body: JSON.stringify({ level }) }),
      });
      assert.equal(res.status, 200);
      assert.equal(srv.epicStore.getAutonomy('epic-001'), level);
    }
  });
});

describe('POST /api/epics/:id/autonomy — token gate', () => {
  it('401 without the token header', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'full-auto' }),
    });
    assert.equal(res.status, 401);
    assert.equal(srv.epicStore.getAutonomy('epic-001'), 'manual');
  });

  it('401 with a wrong token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      method: 'POST',
      headers: { 'x-loom-token': 'wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'full-auto' }),
    });
    assert.equal(res.status, 401);
    assert.equal(srv.epicStore.getAutonomy('epic-001'), 'manual');
  });
});

describe('POST /api/epics/:id/autonomy — validation', () => {
  it('400 for an invalid level', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'turbo' }) }),
    });
    assert.equal(res.status, 400);
    assert.equal(srv.epicStore.getAutonomy('epic-001'), 'manual');
  });

  it('400 for a missing level field', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({}) }),
    });
    assert.equal(res.status, 400);
  });

  it('400 for an empty body', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      method: 'POST',
      headers: { 'x-loom-token': TOKEN, 'Content-Type': 'application/json' },
      body: '',
    });
    assert.equal(res.status, 400);
  });

  it('writes no audit row on validation failure', async () => {
    await fetch(`${srv.baseUrl}/api/epics/epic-001/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'turbo' }) }),
    });
    const rows = srv.auditLog.getByCommand('epic-001').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 0);
  });
});

describe('POST /api/epics/:id/autonomy — unknown epic', () => {
  it('404 for an unknown epic id', async () => {
    const res = await fetch(`${srv.baseUrl}/api/epics/epic-999/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'full-auto' }) }),
    });
    assert.equal(res.status, 404);
  });

  it('writes no audit row for an unknown epic', async () => {
    await fetch(`${srv.baseUrl}/api/epics/epic-999/autonomy`, {
      ...authed({ method: 'POST', body: JSON.stringify({ level: 'full-auto' }) }),
    });
    const rows = srv.auditLog.getByCommand('epic-999').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 0);
  });
});
