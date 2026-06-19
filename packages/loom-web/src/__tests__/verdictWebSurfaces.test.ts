/**
 * Tests for intake-verdict surfacing on the web API surfaces (story-020-004).
 *
 * AC: EpicStatus and EpicDetail expose intake_verdict?
 * AC: verdict present → rendered as object in /api/status and /api/epics/:id
 * AC: verdict absent (null) → rendered as null, not a default/fabricated class
 * AC: read-only — no planning/execution branch on the value
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, type IntakeVerdict } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
import type { EpicStatus, EpicDetail } from '../shared/types.js';

const TOKEN = 'verdict-test-token';
const HEADERS = { 'x-loom-token': TOKEN };

const SAMPLE_VERDICT: IntakeVerdict = {
  type: 'bug',
  size: 'story',
  confidence: 'high',
  rationale: 'A known regression affecting existing users.',
};

let db: Database.Database;
let baseUrl: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-verdict-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  db = createDatabase(':memory:');
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-verdict-proj-'));
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

describe('loom-web — intake_verdict on /api/status (EpicStatus)', () => {
  it('exposes intake_verdict when verdict is present', async () => {
    const store = new EpicStore(db);
    store.create('epic-001', 'A new feature');
    store.recordIntakeVerdict('epic-001', SAMPLE_VERDICT);

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };
    const epic = epics.find((e) => e.id === 'epic-001');
    assert.ok(epic, 'epic must be present in status');
    assert.deepEqual(epic.intake_verdict, SAMPLE_VERDICT);
  });

  it('exposes intake_verdict: null when no verdict recorded', async () => {
    new EpicStore(db).create('epic-002', 'No verdict epic');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };
    const epic = epics.find((e) => e.id === 'epic-002');
    assert.ok(epic, 'epic must be present in status');
    assert.equal(epic.intake_verdict, null, 'intake_verdict must be null, not a default class');
    // Must not be a string/fabricated fallback
    assert.notEqual(typeof epic.intake_verdict, 'string');
  });
});

describe('loom-web — intake_verdict on /api/epics/:id (EpicDetail)', () => {
  it('exposes intake_verdict when verdict is present', async () => {
    const store = new EpicStore(db);
    store.create('epic-003', 'Detail with verdict');
    store.recordIntakeVerdict('epic-003', SAMPLE_VERDICT);

    const res = await fetch(`${baseUrl}/api/epics/epic-003`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const detail = (await res.json()) as EpicDetail;
    assert.deepEqual(detail.intake_verdict, SAMPLE_VERDICT);
  });

  it('exposes intake_verdict: null when no verdict recorded', async () => {
    new EpicStore(db).create('epic-004', 'Detail without verdict');

    const res = await fetch(`${baseUrl}/api/epics/epic-004`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const detail = (await res.json()) as EpicDetail;
    assert.equal(detail.intake_verdict, null, 'intake_verdict must be null, not a default class');
  });

  it('read-only contract: fetching verdict detail changes no epic state', async () => {
    const store = new EpicStore(db);
    store.create('epic-005', 'Read-only check');
    store.recordIntakeVerdict('epic-005', SAMPLE_VERDICT);

    // Capture epic state before
    const before = store.get('epic-005');

    await fetch(`${baseUrl}/api/epics/epic-005`, { headers: HEADERS });

    // State after must be identical — no planning or execution changes
    const after = store.get('epic-005');
    assert.equal(after?.status, before?.status, 'status must not change after verdict fetch');
    assert.equal(after?.updated_at, before?.updated_at, 'updated_at must not change after verdict fetch');
  });
});
