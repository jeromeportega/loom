/**
 * Tests for standalone story presentation on the loom-web API surfaces
 * (epic-047, story-047-004 — updated for epic-059 native story-NNN identity).
 *
 * AC1 — /api/status includes standalone stories as story-NNN with kind='standalone'.
 * AC2 — /api/status never includes the internal container epic-NNN for standalone.
 * AC3 — Normal epic rendering in /api/status is unchanged (epic regression).
 * AC4 — /api/epics/:id/traces and /api/agents/:id/audit do not throw for
 *        story-NNN rows.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, EpicStore, AgentStore, AuditLog, DecisionTraceStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { createApp } from '../server/index.js';
import type { EpicStatus } from '../shared/types.js';

const TOKEN = 'standalone-test-token';
const HEADERS = { 'x-loom-token': TOKEN };

let db: Database.Database;
let baseUrl: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;
let projectRoot: string;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-home-'));
  process.env.LOOM_HOME = loomHomeDir;

  db = createDatabase(':memory:');
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-standalone-proj-'));
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

// ─── AC1 + AC2: standalone story framing in /api/status ──────────────────────

describe('loom-web /api/status — standalone story framing', () => {
  it('[AC1] standalone story appears with kind=standalone and story-NNN as id', async () => {
    const epicStore = new EpicStore(db);
    epicStore.createStandalone('story-047', 'Fix the flaky test');
    const agentStore = new AgentStore(db);
    agentStore.create('story-047', 'story-047', 'Fix the flaky test');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone, 'Standalone entry must be present in /api/status with kind=standalone');
    assert.equal(standalone.id, 'story-047', 'Standalone id must be the stored story-NNN id');
  });

  it('[AC2] epic-047 id must not appear — standalone is stored as story-047', async () => {
    const epicStore = new EpicStore(db);
    epicStore.createStandalone('story-047', 'Standalone task');
    new AgentStore(db).create('story-047', 'story-047', 'Standalone task');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    assert.ok(
      !epics.some((e) => e.id === 'epic-047'),
      'epic-047 must not appear in status — standalone rows use story-NNN ids'
    );
  });

  it('[AC1] standalone with no agent yet still surfaces without error', async () => {
    new EpicStore(db).createStandalone('story-048', 'Pre-dispatch task');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone, 'Pre-dispatch standalone must appear in status');
    assert.equal(standalone.id, 'story-048', 'Pre-dispatch standalone must use story-NNN id');
  });
});

// ─── AC3: normal epic rendering unchanged ────────────────────────────────────

describe('loom-web /api/status — normal epic regression (AC3)', () => {
  it('normal epic appears with its epic-NNN id and no kind field', async () => {
    new EpicStore(db).create('epic-001', 'Normal multi-story epic');
    const agents = new AgentStore(db);
    agents.create('epic-001', 'story-001-001', 'First story');
    agents.create('epic-001', 'story-001-002', 'Second story');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    const epic = epics.find((e) => e.id === 'epic-001');
    assert.ok(epic, 'Normal epic must appear with epic-001 id');
    assert.equal(epic.kind, undefined, 'Normal epic must not have a kind field');
    assert.equal(epic.stories.total, 2, 'Normal epic must count its two stories');
  });

  it('mix of normal epic and standalone both appear correctly in /api/status', async () => {
    new EpicStore(db).create('epic-001', 'Normal epic');
    new AgentStore(db).create('epic-001', 'story-001-001', 'Normal story');
    new EpicStore(db).createStandalone('story-002', 'Standalone task');
    new AgentStore(db).create('story-002', 'story-002', 'Standalone task');

    const res = await fetch(`${baseUrl}/api/status`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const { epics } = (await res.json()) as { epics: EpicStatus[] };

    // Normal epic present
    const normalEpic = epics.find((e) => e.id === 'epic-001');
    assert.ok(normalEpic, 'Normal epic must appear with its epic id');
    assert.equal(normalEpic.kind, undefined, 'Normal epic must not have kind field');

    // Standalone present with its native story-NNN id
    const standalone = epics.find((e) => e.kind === 'standalone');
    assert.ok(standalone, 'Standalone must appear with kind=standalone');
    assert.equal(standalone.id, 'story-002', 'Standalone id must be the stored story-NNN id');

    // The story-002 id must not also appear as an epic-002
    assert.ok(!epics.some((e) => e.id === 'epic-002'), 'epic-002 must not appear');
  });
});

// ─── AC4: trace/audit rendering for parentless story-NNN agent ───────────────

describe('loom-web — trace/audit for parentless story-NNN agent (AC4)', () => {
  it('[traces] /api/agents/:id/traces does not throw for a story-NNN agent', async () => {
    const epicStore = new EpicStore(db);
    epicStore.createStandalone('story-047', 'Standalone');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-047', 'story-047', 'Standalone');
    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'story-047',
      story_id: 'story-047',
      kind: 'thinking',
      rationale: 'Reasoning for the standalone story.',
    });

    const res = await fetch(`${baseUrl}/api/agents/${agent.id}/traces`, { headers: HEADERS });
    assert.equal(res.status, 200, 'Must return 200 for story-NNN agent traces');
    const body = (await res.json()) as { traces: Array<{ story_id: string }> };
    assert.ok(Array.isArray(body.traces), 'traces must be an array');
    assert.ok(
      body.traces.some((t) => t.story_id === 'story-047'),
      'Must return traces for the story id'
    );
  });

  it('[audit] /api/agents/:id/audit does not throw for a story-NNN agent', async () => {
    const epicStore = new EpicStore(db);
    epicStore.createStandalone('story-047', 'Standalone');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-047', 'story-047', 'Standalone');
    const auditLog = new AuditLog(db);
    auditLog.record({
      agent_id: agent.id,
      action: 'worker_started',
      command: 'story-047',
    });

    const res = await fetch(`${baseUrl}/api/agents/${agent.id}/audit`, { headers: HEADERS });
    assert.equal(res.status, 200, 'Must return 200 for story-NNN agent audit');
    const body = (await res.json()) as { entries: Array<{ action: string }> };
    assert.ok(Array.isArray(body.entries), 'entries must be an array');
    assert.ok(
      body.entries.some((e) => e.action === 'worker_started'),
      'Must return audit entries for the story-NNN agent'
    );
  });

  it('[epic traces] /api/epics/:id/traces works for the story-NNN id directly', async () => {
    const epicStore = new EpicStore(db);
    epicStore.createStandalone('story-047', 'Standalone');
    const agentStore = new AgentStore(db);
    const agent = agentStore.create('story-047', 'story-047', 'Standalone');
    const traceStore = new DecisionTraceStore(db);
    traceStore.record({
      agent_id: agent.id,
      epic_id: 'story-047',
      story_id: 'story-047',
      kind: 'thinking',
      rationale: 'Epic-scoped trace for standalone.',
    });

    const res = await fetch(`${baseUrl}/api/epics/story-047/traces`, { headers: HEADERS });
    assert.equal(res.status, 200, 'story-NNN id must work for epic-scoped trace fetch');
    const body = (await res.json()) as { traces: Array<{ story_id: string }> };
    assert.ok(Array.isArray(body.traces), 'traces must be an array');
    assert.ok(
      body.traces.some((t) => t.story_id === 'story-047'),
      'Must return traces with story-NNN story_id'
    );
  });
});
