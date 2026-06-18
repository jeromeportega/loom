/**
 * Tests for publish_pending status in loom-web.
 *
 * AC1 — /api/status returns publish_pending status; /api/epics/:id returns it too.
 * AC2 — publish_pending is distinct from 'failed' at the API level.
 * AC3 — failed and rejected statuses are passed through unchanged.
 *
 * Type-level coverage: EpicStatus.status includes 'publish_pending' in
 * packages/loom-web/src/shared/types.ts — verified by TypeScript compilation
 * of the import below. Any removal of the union member causes a TS compile error.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
// Type-level assertion: 'publish_pending' must be a valid EpicStatus.status value.
// If the union type loses 'publish_pending', this import path will fail at TS compile time.
import type { EpicStatus } from '../shared/types.js';

// Compile-time exhaustiveness check: this assignment is valid only when
// 'publish_pending' is part of EpicStatus['status'].
const _ppCheck: EpicStatus['status'] = 'publish_pending';
void _ppCheck;

async function launch(token = 'test-token-pp'): Promise<{
  db: Database.Database;
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const db = createDatabase(':memory:');
  const app = createApp({ db, token, ssePollMs: 50, loomBin: ['true'] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected address shape');
  return {
    db,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

let db: Database.Database;
let baseUrl: string;
let close: () => Promise<void>;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-web-pp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  ({ db, baseUrl, close } = await launch());
});

afterEach(async () => {
  await close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

const TOKEN = { 'x-loom-token': 'test-token-pp' };

describe('loom-web — publish_pending epic status', () => {
  it('[AC1] /api/status returns status=publish_pending for a recoverable epic', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-pp1', 'Recoverable epic');
    epics.completePlanning('epic-pp1', 'Recoverable epic');
    epics.publishPending('epic-pp1', 'loom/finalize/epic-pp1-abc1234', 'push rejected');

    const res = await fetch(`${baseUrl}/api/status`, { headers: TOKEN });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { epics: Array<{ id: string; status: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-pp1');
    assert.ok(epic, 'epic-pp1 must be present in /api/status');
    assert.equal(epic!.status, 'publish_pending', '/api/status must return publish_pending status');
  });

  it('[AC1] /api/epics/:id returns status=publish_pending', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-pp2', 'Another recoverable');
    epics.completePlanning('epic-pp2', 'Another recoverable');
    epics.publishPending('epic-pp2', 'loom/finalize/epic-pp2-abc1234', 'remote disallowed');

    const res = await fetch(`${baseUrl}/api/epics/epic-pp2`, { headers: TOKEN });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: string; status: string };
    assert.equal(body.status, 'publish_pending', '/api/epics/:id must return publish_pending status');
  });

  it('[AC2] publish_pending is NOT the same as failed in the API response', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-pp3', 'Publish pending check');
    epics.completePlanning('epic-pp3', 'Publish pending check');
    epics.publishPending('epic-pp3', 'loom/finalize/epic-pp3-abc1234', 'push rejected');

    const res = await fetch(`${baseUrl}/api/status`, { headers: TOKEN });
    const body = (await res.json()) as { epics: Array<{ id: string; status: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-pp3');
    assert.ok(epic, 'epic-pp3 must appear in status');
    assert.notEqual(epic!.status, 'failed', 'publish_pending must NOT be rendered as failed');
  });

  it('[AC3 regression] failed epic still returns status=failed', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-fail', 'Will fail');
    epics.completePlanning('epic-fail', 'Will fail');
    epics.fail('epic-fail', 'catastrophic error');

    const res = await fetch(`${baseUrl}/api/status`, { headers: TOKEN });
    const body = (await res.json()) as { epics: Array<{ id: string; status: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-fail');
    assert.ok(epic, 'failed epic must appear in status');
    assert.equal(epic!.status, 'failed', 'failed epic must stay as failed');
  });

  it('[AC3 regression] rejected epic still returns status=rejected', async () => {
    const epics = new EpicStore(db);
    epics.beginPlanning('epic-rej', 'Will be rejected');
    epics.completePlanning('epic-rej', 'Will be rejected');
    epics.reject('epic-rej', 'not useful');

    const res = await fetch(`${baseUrl}/api/status`, { headers: TOKEN });
    const body = (await res.json()) as { epics: Array<{ id: string; status: string }> };
    const epic = body.epics.find((e) => e.id === 'epic-rej');
    assert.ok(epic, 'rejected epic must appear in status');
    assert.equal(epic!.status, 'rejected', 'rejected epic must stay as rejected');
  });
});
