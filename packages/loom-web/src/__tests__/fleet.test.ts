/**
 * Integration tests for:
 *   - GET /api/fleet     — fleet board endpoint (story-003-005)
 *   - SSE epic payload   — autonomy_level / paused fields (story-003-005)
 *
 * Uses the same patterns as server.test.ts: a minimal Express app is spun
 * up on an ephemeral port, each test gets its own fresh in-memory SQLite DB.
 * `registerFleetRoutes` is mounted directly (index.ts does not mount it yet;
 * that wiring lands in story-003-006).
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
} from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { requireToken } from '../server/auth.js';
import { eventStreamHandler } from '../server/events.js';
import { registerFleetRoutes, aggregateEpicCost } from '../server/routes/fleet.js';
import type { FleetCard } from '../shared/fleet.js';

const TOKEN = 'fleet-test-token';
const HEADERS = { 'x-loom-token': TOKEN };

/** SSE helper: reads events from a stream until the predicate matches. */
async function readUntilEvent(
  body: ReadableStream<Uint8Array>,
  predicate: (event: string, data: unknown) => boolean,
  timeoutMs = 3000
): Promise<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = '';
      let dataStr = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataStr += line.slice(6);
      }
      if (!event) continue;
      let data: unknown;
      try { data = JSON.parse(dataStr); } catch { continue; }
      if (predicate(event, data)) {
        try { await reader.cancel(); } catch {}
        return { event, data };
      }
    }
  }
  try { await reader.cancel(); } catch {}
  throw new Error(`SSE event not seen within ${timeoutMs}ms`);
}

/**
 * Reads ALL SSE events for a fixed duration, returns those that matched
 * the event name. Used for "absence of event" assertions.
 */
async function collectEventsForMs(
  body: ReadableStream<Uint8Array>,
  eventName: string,
  durationMs: number
): Promise<unknown[]> {
  const collected: unknown[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + durationMs;

  const loop = async () => {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let result: { value: Uint8Array | undefined; done: boolean };
      try {
        result = await Promise.race([
          reader.read() as Promise<{ value: Uint8Array | undefined; done: boolean }>,
          new Promise<{ value: undefined; done: false }>(r =>
            setTimeout(() => r({ value: undefined, done: false }), remaining)
          ),
        ]);
      } catch {
        break;
      }
      if (result.done) break;
      if (result.value == null) break;
      buf += decoder.decode(result.value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        let ev = '';
        let dataStr = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr += line.slice(6);
        }
        if (ev === eventName) {
          try { collected.push(JSON.parse(dataStr)); } catch {}
        }
      }
    }
  };

  await loop();
  try { await reader.cancel(); } catch {}
  return collected;
}

// ─── Test app factory ────────────────────────────────────────────────────────

interface LaunchResult {
  db: Database.Database;
  epicStore: EpicStore;
  agentStore: AgentStore;
  baseUrl: string;
  close: () => Promise<void>;
}

async function launchFleet(ssePollMs = 50, projectRoot = '/test/project'): Promise<LaunchResult> {
  const db = createDatabase(':memory:');
  const epicStore = new EpicStore(db);
  const agentStore = new AgentStore(db);

  const app = express();
  app.use(express.json());
  app.use('/api', requireToken({ token: TOKEN }));

  registerFleetRoutes(app, { epicStore, agentStore, db, projectRoot });
  app.get('/api/events', eventStreamHandler({ db, pollMs: ssePollMs }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };

  return {
    db,
    epicStore,
    agentStore,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

// ─── Test state ──────────────────────────────────────────────────────────────

let srv: LaunchResult;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

beforeEach(async () => {
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-fleet-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  srv = await launchFleet();
});

afterEach(async () => {
  await srv.close();
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── GET /api/fleet — card shape ────────────────────────────────────────────

describe('GET /api/fleet — auth', () => {
  it('returns 401 without the token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/fleet`);
    assert.equal(res.status, 401);
  });

  it('returns 200 with the token', async () => {
    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/fleet — card shape', () => {
  it('returns an empty array when no epics exist', async () => {
    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const cards = (await res.json()) as FleetCard[];
    assert.deepEqual(cards, []);
  });

  it('returns a FleetCard with status, stories, cost, blockers, autonomy_level, paused', async () => {
    const { epicStore, agentStore, db } = srv;
    epicStore.create('epic-001', 'Add auth system');
    epicStore.updateStatus('epic-001', 'in_progress');
    const a1 = agentStore.create('epic-001', 'story-001', 'Login route');
    const a2 = agentStore.create('epic-001', 'story-002', 'JWT signing');
    agentStore.updateStatus(a1.id, 'done');
    agentStore.updateStatus(a2.id, 'running');
    agentStore.setUsage(a1.id, { tokens_input: 100, tokens_output: 200, cost_usd: 0.05, request_count: 2 });

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const cards = (await res.json()) as FleetCard[];
    assert.equal(cards.length, 1);

    const card = cards[0];
    assert.equal(card.epic_id, 'epic-001');
    assert.equal(card.title, 'Add auth system');
    assert.equal(card.status, 'in_progress');
    assert.equal(card.autonomy_level, 'manual');
    assert.equal(card.paused, false);
    assert.equal(card.project_root, '/test/project');

    // stories derived from listLatestByEpic — per-story dedup
    assert.equal(card.stories.length, 2);
    const storyIds = card.stories.map(s => s.story_id).sort();
    assert.deepEqual(storyIds, ['story-001', 'story-002']);
    const s1 = card.stories.find(s => s.story_id === 'story-001');
    assert.equal(s1?.status, 'done');
    const s2 = card.stories.find(s => s.story_id === 'story-002');
    assert.equal(s2?.status, 'running');

    // cost equals a direct aggregateEpicCost call (the "reused verbatim" assertion)
    const epic = epicStore.get('epic-001')!;
    const allAgents = agentStore.listByEpic('epic-001');
    const expectedCost = aggregateEpicCost(epic, allAgents);
    assert.deepEqual(card.cost, expectedCost);
  });

  it('stories in listLatestByEpic are deduplicated — retry collapses to latest', async () => {
    const { epicStore, agentStore } = srv;
    epicStore.create('epic-001', 'retry test');
    const older = agentStore.create('epic-001', 'story-001', 's1');
    agentStore.updateStatus(older.id, 'blocked');
    await new Promise(r => setTimeout(r, 5));
    const newer = agentStore.create('epic-001', 'story-001', 's1');
    agentStore.updateStatus(newer.id, 'done');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const [card] = (await res.json()) as FleetCard[];
    assert.equal(card.stories.length, 1, 'one story after dedup');
    assert.equal(card.stories[0].status, 'done', 'latest status wins');
  });
});

// ─── Blocker count ───────────────────────────────────────────────────────────

describe('GET /api/fleet — blocker count', () => {
  it('blockers = 0 when no stories are blocked or failed', async () => {
    const { epicStore, agentStore } = srv;
    epicStore.create('epic-001', 'healthy epic');
    const a = agentStore.create('epic-001', 'story-001', 'done story');
    agentStore.updateStatus(a.id, 'done');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const [card] = (await res.json()) as FleetCard[];
    assert.equal(card.blockers, 0);
  });

  it('counts blocked and failed stories as blockers, not done/running', async () => {
    const { epicStore, agentStore } = srv;
    epicStore.create('epic-001', 'mixed statuses');
    const a1 = agentStore.create('epic-001', 'story-001', 'done');
    const a2 = agentStore.create('epic-001', 'story-002', 'blocked');
    const a3 = agentStore.create('epic-001', 'story-003', 'failed');
    const a4 = agentStore.create('epic-001', 'story-004', 'running');
    agentStore.updateStatus(a1.id, 'done');
    agentStore.updateStatus(a2.id, 'blocked');
    agentStore.updateStatus(a3.id, 'failed');
    agentStore.updateStatus(a4.id, 'running');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const [card] = (await res.json()) as FleetCard[];
    assert.equal(card.blockers, 2, 'blocked + failed = 2');
  });

  it('all-blocked: all stories are blockers', async () => {
    const { epicStore, agentStore } = srv;
    epicStore.create('epic-001', 'all blocked');
    const a1 = agentStore.create('epic-001', 'story-001', 'b1');
    const a2 = agentStore.create('epic-001', 'story-002', 'b2');
    agentStore.updateStatus(a1.id, 'blocked');
    agentStore.updateStatus(a2.id, 'blocked');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const [card] = (await res.json()) as FleetCard[];
    assert.equal(card.blockers, 2);
  });
});

// ─── Cross-epic attribution ───────────────────────────────────────────────────

describe('GET /api/fleet — cross-epic attribution', () => {
  it('two epics in one DB: each card contains only its own stories (no bleed)', async () => {
    const { epicStore, agentStore } = srv;

    epicStore.create('epic-alpha', 'Alpha project');
    epicStore.create('epic-beta', 'Beta project');

    const a1 = agentStore.create('epic-alpha', 'story-A-001', 'Alpha story 1');
    const a2 = agentStore.create('epic-alpha', 'story-A-002', 'Alpha story 2');
    const b1 = agentStore.create('epic-beta',  'story-B-001', 'Beta story 1');
    const b2 = agentStore.create('epic-beta',  'story-B-002', 'Beta story 2');
    agentStore.updateStatus(a1.id, 'done');
    agentStore.updateStatus(a2.id, 'running');
    agentStore.updateStatus(b1.id, 'blocked');
    agentStore.updateStatus(b2.id, 'pending');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const cards = (await res.json()) as FleetCard[];
    assert.equal(cards.length, 2);

    const alpha = cards.find(c => c.epic_id === 'epic-alpha');
    const beta  = cards.find(c => c.epic_id === 'epic-beta');
    assert.ok(alpha, 'alpha card exists');
    assert.ok(beta,  'beta card exists');

    // Zero bleed: alpha stories contain only story-A-* ids
    const alphaIds = alpha!.stories.map(s => s.story_id);
    assert.ok(alphaIds.includes('story-A-001'), 'A-001 in alpha');
    assert.ok(alphaIds.includes('story-A-002'), 'A-002 in alpha');
    assert.ok(!alphaIds.includes('story-B-001'), 'B-001 not in alpha');
    assert.ok(!alphaIds.includes('story-B-002'), 'B-002 not in alpha');

    // Zero bleed: beta stories contain only story-B-* ids
    const betaIds = beta!.stories.map(s => s.story_id);
    assert.ok(betaIds.includes('story-B-001'), 'B-001 in beta');
    assert.ok(betaIds.includes('story-B-002'), 'B-002 in beta');
    assert.ok(!betaIds.includes('story-A-001'), 'A-001 not in beta');
    assert.ok(!betaIds.includes('story-A-002'), 'A-002 not in beta');
  });

  it('shared story_id string across epics: filtering is by epic_id, not story_id', async () => {
    // Both epics have a story with the SAME story_id string. The fleet
    // endpoint must attribute each agent to its epic via epic_id, not
    // by the story_id. This proves the structural guarantee: no shared
    // accumulator, always filtered by epic_id.
    const { epicStore, agentStore } = srv;

    epicStore.create('epic-alpha', 'Alpha');
    epicStore.create('epic-beta',  'Beta');

    // SAME story_id in both epics — the shared-accumulator bug would
    // attribute this story to whichever epic processes it last.
    const aAgent = agentStore.create('epic-alpha', 'story-shared', 'Alpha version');
    const bAgent = agentStore.create('epic-beta',  'story-shared', 'Beta version');
    agentStore.updateStatus(aAgent.id, 'done');
    agentStore.updateStatus(bAgent.id, 'failed');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    const cards = (await res.json()) as FleetCard[];
    assert.equal(cards.length, 2);

    const alpha = cards.find(c => c.epic_id === 'epic-alpha');
    const beta  = cards.find(c => c.epic_id === 'epic-beta');
    assert.ok(alpha && beta);

    assert.equal(alpha!.stories.length, 1);
    assert.equal(alpha!.stories[0].story_id, 'story-shared');
    assert.equal(alpha!.stories[0].status, 'done', 'alpha has the done version');

    assert.equal(beta!.stories.length, 1);
    assert.equal(beta!.stories[0].story_id, 'story-shared');
    assert.equal(beta!.stories[0].status, 'failed', 'beta has the failed version');

    // Blockers: alpha has 0 (done is not a blocker); beta has 1 (failed is a blocker)
    assert.equal(alpha!.blockers, 0);
    assert.equal(beta!.blockers, 1);
  });
});

// ─── Edge case: epic with no agents ─────────────────────────────────────────

describe('GET /api/fleet — empty/edge', () => {
  it('epic with no agents returns a card with empty stories, zero cost, zero blockers', async () => {
    const { epicStore } = srv;
    epicStore.create('epic-empty', 'Newly planned epic');

    const res = await fetch(`${srv.baseUrl}/api/fleet`, { headers: HEADERS });
    assert.equal(res.status, 200);
    const [card] = (await res.json()) as FleetCard[];
    assert.ok(card, 'card exists');
    assert.equal(card.epic_id, 'epic-empty');
    assert.deepEqual(card.stories, []);
    assert.equal(card.blockers, 0);
    assert.equal(card.cost.worker_tokens, 0);
    assert.equal(card.cost.worker_cost_usd, 0);
    assert.equal(card.cost.agents, 0);
  });
});

// ─── SSE epic payload widening ───────────────────────────────────────────────

describe('SSE epic payload — autonomy_level and paused fields', () => {
  it('epic SSE event includes autonomy_level and paused fields (default values)', async () => {
    const { epicStore, baseUrl } = srv;

    const res = await fetch(`${baseUrl}/api/events?token=${TOKEN}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    // Create epic AFTER opening stream so we observe the change.
    setTimeout(() => epicStore.create('epic-001', 'SSE payload test'), 30);

    const { data } = await readUntilEvent(
      res.body!,
      (ev, d) => ev === 'epic' && (d as { id: string }).id === 'epic-001'
    );

    const d = data as {
      id: string;
      status: string;
      autonomy_level?: string;
      paused?: boolean;
    };

    // The widened payload must include autonomy_level and paused.
    assert.equal(d.autonomy_level, 'manual', 'autonomy_level defaults to manual');
    assert.equal(d.paused, false, 'paused defaults to false');
  });
});

// ─── Per-project SSE scoping ─────────────────────────────────────────────────

describe('SSE per-project scoping', () => {
  it('project A SSE does not receive project B events (separate DB)', async () => {
    const { epicStore, baseUrl } = srv;

    // DB B is a completely separate in-memory DB — not connected to the server.
    const dbB = createDatabase(':memory:');
    const epicStoreB = new EpicStore(dbB);

    // Open SSE connection (scoped to server's DB A).
    const res = await fetch(`${baseUrl}/api/events?token=${TOKEN}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    // Add an epic to DB B. Since the SSE handler only polls DB A, this
    // should NEVER appear in the stream.
    epicStoreB.create('epic-B-001', 'Project B epic — should not appear');

    // Collect epic events for several poll cycles (ssePollMs=50, so 300ms = ~6 polls).
    const epicEvents = await collectEventsForMs(res.body!, 'epic', 300);

    const ids = epicEvents.map((e) => (e as { id: string }).id);
    assert.ok(
      !ids.includes('epic-B-001'),
      `project B's epic must not appear in project A SSE stream; got ids: ${ids.join(',')}`
    );

    // Now add an epic to DB A — it MUST appear.
    epicStore.create('epic-A-001', 'Project A epic — must appear');

    const { data } = await readUntilEvent(
      // Note: we already consumed the initial stream body above in
      // collectEventsForMs. Open a fresh SSE connection for this assertion.
      (await fetch(`${baseUrl}/api/events?token=${TOKEN}`)).body!,
      (ev, d) => ev === 'epic' && (d as { id: string }).id === 'epic-A-001'
    );
    assert.equal((data as { id: string }).id, 'epic-A-001');

    dbB.close();
  });
});
