/**
 * story-059-006 — Native web reads and removal of resolveEpicRow shim.
 *
 * Covers:
 * - rollupEpics emits standalone story-NNN id verbatim (no reframing branch)
 * - GET /api/epics/story-NNN returns 200 via direct PK lookup
 * - POST /api/epics/story-NNN/approve resolves by direct lookup and mutates
 * - Shim removal: resolveEpicRow.ts is gone; no import site remains
 * - Boundary: legacy epic-NNN standalone URL 404s (no fallback, per ADR-005)
 * - Normal epic-NNN detail still loads (regression guard)
 * - Unknown id 404s
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, AuditLog } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
import type { EpicStatus, EpicDetail } from '../shared/types.js';

const TOKEN = 'native-story-nnn-token';
const HEADERS = { 'x-loom-token': TOKEN };

let db: Database.Database;
let baseUrl: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let projectRoot: string;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-native-story-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  db = createDatabase(':memory:');
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-native-story-proj-'));
  fs.mkdirSync(path.join(projectRoot, '.loom', 'logs'), { recursive: true });
  const app = createApp({ db, token: TOKEN, projectRoot, loomBin: ['true'] });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('unexpected server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => {
        fs.rmSync(projectRoot, { recursive: true, force: true });
        err ? reject(err) : resolve();
      })
    );
});

afterEach(async () => {
  await closeServer();
  db.close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── rollupEpics: story-NNN emitted verbatim, no reframing ───────────────────

describe('rollupEpics (GET /api/status) — native story-NNN id', () => {
  it('standalone story appears with id=story-NNN verbatim and kind=standalone', async () => {
    new EpicStore(db).createStandalone('story-059', 'Fix the widget');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone, 'standalone entry must be present');
    assert.equal(standalone.id, 'story-059', 'id must be the stored story-NNN pk verbatim');
    assert.equal(standalone.kind, 'standalone');
  });

  it('standalone story with dispatched agent still emits epic.id verbatim (no agent.story_id derivation)', async () => {
    const store = new EpicStore(db);
    store.createStandalone('story-060', 'Another task');
    store.updateStatus('story-060', 'approved');
    new AgentStore(db).create('story-060', 'story-060', 'Another task');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone);
    assert.equal(standalone.id, 'story-060', 'must emit stored id, not a derived story_id');
    assert.equal(standalone.stories.total, 1, 'must count the single agent');
    // status comes from the epic row, not the agent row
    assert.equal(standalone.status, 'approved', 'status must reflect the stored epic row status');
  });

  it('no epic-NNN id leaks into the list for a standalone story', async () => {
    new EpicStore(db).createStandalone('story-061', 'No leak');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    assert.ok(!epics.some((e) => e.id.startsWith('epic-')), 'no epic-NNN id must appear for a standalone-only db');
  });

  it('normal epic is unchanged alongside a standalone story', async () => {
    new EpicStore(db).create('epic-010', 'Multi-story epic');
    new AgentStore(db).create('epic-010', 'story-010-001', 'Story one');
    new EpicStore(db).createStandalone('story-011', 'Standalone');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const normal = epics.find((e) => e.id === 'epic-010');
    assert.ok(normal, 'normal epic must still appear');
    assert.equal(normal.kind, undefined, 'normal epic must not have kind');

    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone);
    assert.equal(standalone.id, 'story-011');
  });
});

// ─── GET /api/epics/:id — direct PK lookup for story-NNN ─────────────────────

describe('GET /api/epics/:id — story-NNN direct lookup', () => {
  it('returns 200 and the correct detail for a story-NNN id', async () => {
    new EpicStore(db).createStandalone('story-059', 'Fix the widget');

    const res = await fetch(`${baseUrl}/api/epics/story-059`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as EpicDetail;
    assert.equal(body.id, 'story-059', 'detail.id must be story-NNN');
    assert.equal(body.kind, 'standalone', 'detail.kind must be standalone');
    assert.equal(body.title, 'Fix the widget');
  });

  it('returns 200 with agents for a dispatched standalone story', async () => {
    new EpicStore(db).createStandalone('story-059', 'Fix the widget');
    new AgentStore(db).create('story-059', 'story-059', 'Fix the widget');

    const res = await fetch(`${baseUrl}/api/epics/story-059`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as EpicDetail;
    assert.equal(body.id, 'story-059');
    assert.equal(body.agents.length, 1, 'must include the dispatched agent');
  });

  it('returns 404 for a legacy epic-NNN that was a standalone container (no fallback)', async () => {
    // Standalone rows are now stored as story-NNN; there is no epic-NNN row.
    // A GET with the legacy epic-NNN id must 404 — no shim, no fallback (ADR-005).
    const res = await fetch(`${baseUrl}/api/epics/epic-059`, { headers: HEADERS });
    assert.equal(res.status, 404, 'legacy epic-NNN standalone URL must 404 without a fallback');
  });

  it('returns 200 for a normal epic-NNN detail (regression guard)', async () => {
    new EpicStore(db).create('epic-010', 'Normal epic');
    new AgentStore(db).create('epic-010', 'story-010-001', 'Story one');

    const res = await fetch(`${baseUrl}/api/epics/epic-010`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const body = (await res.json()) as EpicDetail;
    assert.equal(body.id, 'epic-010');
    assert.equal(body.kind, undefined, 'normal epic must not have kind');
  });

  it('returns 404 for an entirely unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/epics/story-999`, { headers: HEADERS });
    assert.equal(res.status, 404);
  });
});

// ─── POST /api/epics/:id/approve — mutation via direct PK lookup ──────────────

describe('POST /api/epics/:id/approve — story-NNN mutation', () => {
  it('approves a planned standalone story by direct story-NNN lookup', async () => {
    new EpicStore(db).createStandalone('story-059', 'Fix the widget');

    const res = await fetch(`${baseUrl}/api/epics/story-059/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; epic_id: string };
    assert.equal(body.status, 'dispatching');
    assert.equal(body.epic_id, 'story-059', 'approved epic_id must be the story-NNN id');

    // Confirm DB side-effect
    const row = new EpicStore(db).get('story-059');
    assert.ok(row);
    assert.equal(row.status, 'approved');
  });

  it('returns 404 for POST /api/epics/epic-NNN/approve when no epic-NNN row exists', async () => {
    // Standalone rows live as story-NNN; no epic-NNN row → 404, no fallback.
    const res = await fetch(`${baseUrl}/api/epics/epic-059/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 404);
  });

  it('returns 409 when story is not in planned status (in_progress)', async () => {
    const store = new EpicStore(db);
    store.createStandalone('story-059', 'Already running');
    store.updateStatus('story-059', 'in_progress');

    const res = await fetch(`${baseUrl}/api/epics/story-059/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 409);
  });

  it('returns 409 when story is in done status', async () => {
    const store = new EpicStore(db);
    store.createStandalone('story-059', 'Already done');
    store.updateStatus('story-059', 'done');

    const res = await fetch(`${baseUrl}/api/epics/story-059/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 409);
  });

  it('returns 409 when story is in failed status', async () => {
    const store = new EpicStore(db);
    store.createStandalone('story-059', 'Already failed');
    store.updateStatus('story-059', 'failed');

    const res = await fetch(`${baseUrl}/api/epics/story-059/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 409);
  });

  it('approve of a normal epic-NNN still works (regression guard)', async () => {
    new EpicStore(db).create('epic-010', 'Normal epic');

    const res = await fetch(`${baseUrl}/api/epics/epic-010/approve`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { epic_id: string };
    assert.equal(body.epic_id, 'epic-010');
  });
});

// ─── POST /api/epics/:id/reject — mutation via direct PK lookup ───────────────

describe('POST /api/epics/:id/reject — story-NNN mutation', () => {
  it('rejects a planned standalone story by direct story-NNN lookup', async () => {
    new EpicStore(db).createStandalone('story-059', 'Fix the widget');

    const res = await fetch(`${baseUrl}/api/epics/story-059/reject`, {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'not needed' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; epic_id: string };
    assert.equal(body.status, 'rejected');
    assert.equal(body.epic_id, 'story-059', 'rejected epic_id must be the story-NNN id');

    const row = new EpicStore(db).get('story-059');
    assert.ok(row);
    assert.equal(row.status, 'rejected');
  });

  it('returns 404 for POST /api/epics/epic-NNN/reject when no epic-NNN row exists', async () => {
    const res = await fetch(`${baseUrl}/api/epics/epic-059/reject`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 404);
  });

  it('returns 409 when story is not in planned status (in_progress)', async () => {
    const store = new EpicStore(db);
    store.createStandalone('story-059', 'Already running');
    store.updateStatus('story-059', 'in_progress');

    const res = await fetch(`${baseUrl}/api/epics/story-059/reject`, {
      method: 'POST',
      headers: HEADERS,
    });
    assert.equal(res.status, 409);
  });
});

// ─── Shim removal: resolveEpicRow.ts is deleted ──────────────────────────────

describe('resolveEpicRow shim removal', () => {
  it('resolveEpicRow.ts does not exist in the source server directory', () => {
    // Resolve from process.cwd() (packages/loom-web/) so the path is stable
    // regardless of whether tests run from compiled dist/ or via ts-node.
    const srcShimPath = path.resolve(process.cwd(), 'src/server/resolveEpicRow.ts');
    assert.ok(
      !fs.existsSync(srcShimPath),
      `resolveEpicRow.ts must be deleted (found at ${srcShimPath})`
    );
  });

  it('resolveEpicRow.js does not exist in the dist server directory', () => {
    // Resolve from process.cwd() (packages/loom-web/) — stable across run modes.
    const distShimPath = path.resolve(process.cwd(), 'dist/server/resolveEpicRow.js');
    assert.ok(
      !fs.existsSync(distShimPath),
      `resolveEpicRow.js must not exist in dist (found at ${distShimPath})`
    );
  });
});
