/**
 * Integration tests for GET /api/agents/:id/log[?from=<int>].
 *
 * Exercises the full HTTP↔filesystem seam: a real Express handler, a real
 * AgentStore, and a real WorkerLogStore writing to a temp loomdir. Tests run
 * against a live HTTP server on an ephemeral port so auth, routing, and header
 * emission are all verified end-to-end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';

const TOKEN = 'test-token-123';
const AUTH = { 'x-loom-token': TOKEN };

/** Ephemeral server with a real temp loomdir so WorkerLogStore can read logs. */
async function launch(): Promise<{
  db: Database.Database;
  baseUrl: string;
  projectRoot: string;
  loomdir: string;
  close: () => Promise<void>;
}> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-log-test-'));
  const loomdir = path.join(projectRoot, '.loom');
  fs.mkdirSync(path.join(loomdir, 'logs'), { recursive: true });

  const db = createDatabase(':memory:');
  const app = createApp({ db, token: TOKEN, projectRoot, loomBin: ['true'] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected addr');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    db,
    baseUrl,
    projectRoot,
    loomdir,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => {
          fs.rmSync(projectRoot, { recursive: true, force: true });
          err ? reject(err) : resolve();
        })
      ),
  };
}

/** Writes a log file and updates agents.log_bytes to match. */
function seedLog(
  db: Database.Database,
  loomdir: string,
  agentId: string,
  storyId: string,
  content: string
): number {
  const logBytes = Buffer.byteLength(content, 'utf8');
  fs.writeFileSync(path.join(loomdir, 'logs', `${storyId}.log`), content, 'utf8');
  new AgentStore(db).updateLogTail(agentId, content.slice(-4096), logBytes);
  return logBytes;
}

describe('GET /api/agents/:id/log — unknown id → 404 (path-traversal guard)', () => {
  it('returns 404 for an id with no matching agent', async () => {
    const { baseUrl, close } = await launch();
    try {
      const res = await fetch(`${baseUrl}/api/agents/no-such-agent/log`, { headers: AUTH });
      assert.equal(res.status, 404);
    } finally {
      await close();
    }
  });
});

describe('GET /api/agents/:id/log — full fetch', () => {
  it('returns the complete log body, text/plain Content-Type, and correct X-Log-Length', async () => {
    const { db, baseUrl, loomdir, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');

      const content = 'line 1\nline 2\nline 3\n';
      const logBytes = seedLog(db, loomdir, a.id, a.story_id, content);

      const res = await fetch(`${baseUrl}/api/agents/${a.id}/log`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
      assert.equal(res.headers.get('x-log-length'), String(logBytes));
      assert.equal(await res.text(), content);
    } finally {
      await close();
    }
  });
});

describe('GET /api/agents/:id/log — from-offset fetch', () => {
  it('?from=N returns exactly the bytes after offset N', async () => {
    const { db, baseUrl, loomdir, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');

      const content = 'hello world\n';
      const logBytes = seedLog(db, loomdir, a.id, a.story_id, content);
      const from = 6; // byte offset after 'hello '

      const res = await fetch(`${baseUrl}/api/agents/${a.id}/log?from=${from}`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-log-length'), String(logBytes));
      assert.equal(await res.text(), 'world\n');
    } finally {
      await close();
    }
  });

  it('?from=0 is identical to no from (full fetch)', async () => {
    const { db, baseUrl, loomdir, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');

      const content = 'full content\n';
      seedLog(db, loomdir, a.id, a.story_id, content);

      const resNoFrom = await fetch(`${baseUrl}/api/agents/${a.id}/log`, { headers: AUTH });
      const resFrom0 = await fetch(`${baseUrl}/api/agents/${a.id}/log?from=0`, { headers: AUTH });
      assert.equal(await resNoFrom.text(), content);
      assert.equal(await resFrom0.text(), content);
    } finally {
      await close();
    }
  });
});

describe('GET /api/agents/:id/log — boundary: from === log_bytes', () => {
  it('returns 200 with empty body and X-Log-Length still set', async () => {
    const { db, baseUrl, loomdir, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');

      const content = 'some content\n';
      const logBytes = seedLog(db, loomdir, a.id, a.story_id, content);

      const res = await fetch(`${baseUrl}/api/agents/${a.id}/log?from=${logBytes}`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-log-length'), String(logBytes));
      assert.equal(await res.text(), '');
    } finally {
      await close();
    }
  });
});

describe('GET /api/agents/:id/log — concurrent append tolerated', () => {
  it('reads are bounded to agents.log_bytes and never over-read appended bytes', async () => {
    const { db, baseUrl, loomdir, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');

      const content = 'initial content\n';
      const logBytes = seedLog(db, loomdir, a.id, a.story_id, content);

      // Append extra bytes AFTER the pointer is recorded — simulates a concurrent writer.
      fs.appendFileSync(
        path.join(loomdir, 'logs', `${a.story_id}.log`),
        'extra bytes appended after pointer\n',
        'utf8'
      );

      const res = await fetch(`${baseUrl}/api/agents/${a.id}/log`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-log-length'), String(logBytes));
      // Must return only the pointer-consistent prefix, not the extra bytes.
      assert.equal(await res.text(), content);
    } finally {
      await close();
    }
  });
});

describe('GET /api/agents/:id/log — missing log file', () => {
  it('returns empty 200 body with X-Log-Length: 0 when no log file exists', async () => {
    const { db, baseUrl, close } = await launch();
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Log story');
      // No log file written; log_bytes stays NULL (read as 0).

      const res = await fetch(`${baseUrl}/api/agents/${a.id}/log`, { headers: AUTH });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-log-length'), '0');
      assert.equal(await res.text(), '');
    } finally {
      await close();
    }
  });
});
