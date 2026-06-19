/**
 * Integration tests for the SSE event stream (events.ts).
 *
 * Verifies the durable-offset emission contract:
 *   - On connect, emittedOffset[agentId] is seeded to agents.log_bytes so
 *     history is never replayed.
 *   - When log_bytes advances, an 'output' event is emitted with {from, bytes}
 *     keyed to the absolute durable offset.
 *   - A 'hello' event with a stable epoch is emitted on every connection.
 *
 * Tests spin a real Express server with an in-process fetch-based SSE consumer
 * so auth, routing, and SSE framing are all exercised end-to-end.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createDatabase, EpicStore, AgentStore } from '@loom-ai/core';
import type Database from 'better-sqlite3';
import { eventStreamHandler } from '../server/events.js';

/** Minimal server that mounts just the SSE handler with no auth. */
async function launchEventsServer(
  db: Database.Database,
  loomdir: string,
  pollMs = 50
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.get('/events', eventStreamHandler({ db, loomdir, pollMs }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('bad addr');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    ),
  };
}

/** Write (or replace) a log file and record agents.log_bytes. */
function seedLog(
  db: Database.Database,
  loomdir: string,
  agentId: string,
  storyId: string,
  content: string
): number {
  const logBytes = Buffer.byteLength(content, 'utf8');
  fs.mkdirSync(path.join(loomdir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(loomdir, 'logs', `${storyId}.log`), content, 'utf8');
  new AgentStore(db).updateLogTail(agentId, content.slice(-4096), logBytes);
  return logBytes;
}

/** Append bytes to an existing log file and advance log_bytes. */
function appendLog(
  db: Database.Database,
  loomdir: string,
  agentId: string,
  storyId: string,
  append: string
): number {
  fs.mkdirSync(path.join(loomdir, 'logs'), { recursive: true });
  const filePath = path.join(loomdir, 'logs', `${storyId}.log`);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const full = existing + append;
  const logBytes = Buffer.byteLength(full, 'utf8');
  fs.writeFileSync(filePath, full, 'utf8');
  new AgentStore(db).updateLogTail(agentId, full.slice(-4096), logBytes);
  return logBytes;
}

/** Promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collects SSE events from `url` until `ctrl.signal` is aborted.
 * Returns collected events in order.
 */
async function startSSEStream(
  url: string,
  ctrl: AbortController
): Promise<{ event: string; data: string }[]> {
  const collected: { event: string; data: string }[] = [];
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.body) return collected;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        collected.push({ event, data });
      }
    }
  } catch {
    // AbortError on ctrl.abort() — expected.
  }
  return collected;
}

describe('events.ts — hello event on connect', () => {
  it('emits a hello event with an epoch string', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const { baseUrl, close } = await launchEventsServer(db, tmpDir);
      try {
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);
        await sleep(150);
        ctrl.abort();
        const events = await streamPromise;

        const hellos = events.filter(e => e.event === 'hello');
        assert.ok(hellos.length >= 1, 'should emit at least one hello');
        const d = JSON.parse(hellos[0].data);
        assert.ok(typeof d.epoch === 'string' && d.epoch.length > 0);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('events.ts — seeding (FR-7): no output for existing log bytes', () => {
  it('does not emit output events for content that existed at connect time', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Test story');
      seedLog(db, tmpDir, a.id, a.story_id, 'existing content here');

      const { baseUrl, close } = await launchEventsServer(db, tmpDir);
      try {
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);
        // Let several poll cycles fire — nothing new should be emitted.
        await sleep(400);
        ctrl.abort();
        const events = await streamPromise;

        const outputForAgent = events.filter(
          e => e.event === 'output' && JSON.parse(e.data).agent_id === a.id
        );
        assert.equal(outputForAgent.length, 0, 'must not replay existing log content');
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('events.ts — tick emission: new bytes emitted with correct from offset', () => {
  it('emits output {from, bytes} when log_bytes advances after seeding', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Test story');

      const initialContent = 'initial bytes';
      const initialBytes = seedLog(db, tmpDir, a.id, a.story_id, initialContent);

      const { baseUrl, close } = await launchEventsServer(db, tmpDir, 50);
      try {
        // 1. Open the SSE connection FIRST.
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);

        // 2. Wait for the seed tick (emittedOffset seeded to initialBytes).
        await sleep(150);

        // 3. Append new content AFTER the seed tick.
        const appendContent = ' appended';
        appendLog(db, tmpDir, a.id, a.story_id, appendContent);

        // 4. Wait for emission ticks.
        await sleep(300);
        ctrl.abort();
        const events = await streamPromise;

        const outputForAgent = events.filter(
          e => e.event === 'output' && JSON.parse(e.data).agent_id === a.id
        );
        assert.ok(outputForAgent.length >= 1, 'should emit output for new bytes');

        const ev = JSON.parse(outputForAgent[0].data);
        assert.equal(ev.from, initialBytes, 'from must equal the seeded offset');
        assert.equal(ev.bytes, appendContent, 'bytes must be only the new content');
        assert.equal(ev.byteLength, Buffer.byteLength(appendContent, 'utf8'), 'byteLength must be UTF-8 byte length');
        assert.equal(ev.agent_id, a.id);
        assert.equal(ev.story_id, a.story_id);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not emit when log_bytes is unchanged between ticks', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Test story');
      seedLog(db, tmpDir, a.id, a.story_id, 'static content');

      const { baseUrl, close } = await launchEventsServer(db, tmpDir, 50);
      try {
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);
        // Several poll cycles; seed fires once, then nothing new.
        await sleep(400);
        ctrl.abort();
        const events = await streamPromise;

        const outputForAgent = events.filter(
          e => e.event === 'output' && JSON.parse(e.data).agent_id === a.id
        );
        assert.equal(outputForAgent.length, 0, 'no output when nothing new');
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits from=0 with full content for a fresh agent with no prior log', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Test story');
      // No log initially — log_bytes stays NULL (maps to 0).

      const { baseUrl, close } = await launchEventsServer(db, tmpDir, 50);
      try {
        // 1. Open SSE connection; seed tick fires with offset=0.
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);
        await sleep(150);

        // 2. Write the first bytes.
        const content = 'first output';
        appendLog(db, tmpDir, a.id, a.story_id, content);

        // 3. Wait for emission.
        await sleep(300);
        ctrl.abort();
        const events = await streamPromise;

        const outputForAgent = events.filter(
          e => e.event === 'output' && JSON.parse(e.data).agent_id === a.id
        );
        assert.ok(outputForAgent.length >= 1, 'expected at least one output event');
        const ev = JSON.parse(outputForAgent[0].data);
        assert.equal(ev.from, 0, 'from must be 0 for a fresh agent');
        assert.equal(ev.bytes, content);
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('events.ts — multiple sequential appends accumulate correctly', () => {
  it('emits consecutive non-overlapping output events as bytes arrive', async () => {
    const db = createDatabase(':memory:');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ev-'));
    try {
      const epics = new EpicStore(db);
      const agents = new AgentStore(db);
      epics.create('epic-001', 'Test epic');
      const a = agents.create('epic-001', 'story-001-001', 'Test story');

      const { baseUrl, close } = await launchEventsServer(db, tmpDir, 50);
      try {
        // 1. Connect first; seed tick fires at offset=0.
        const ctrl = new AbortController();
        const streamPromise = startSSEStream(`${baseUrl}/events`, ctrl);
        await sleep(150);

        // 2. Two sequential appends with a gap between them.
        appendLog(db, tmpDir, a.id, a.story_id, 'chunk1\n');
        await sleep(150);
        appendLog(db, tmpDir, a.id, a.story_id, 'chunk2\n');

        // 3. Collect remaining ticks.
        await sleep(300);
        ctrl.abort();
        const events = await streamPromise;

        const outputEvents = events
          .filter(e => e.event === 'output' && JSON.parse(e.data).agent_id === a.id)
          .map(e => JSON.parse(e.data));

        assert.ok(outputEvents.length >= 2, 'at least two output events expected');

        // Reconstruct full log by applying events in order.
        // Use byte-accurate slice (Buffer) since from/offset are byte offsets.
        let reconstructed = '';
        let offset = 0;
        for (const ev of outputEvents) {
          assert.ok(ev.from <= offset, `from=${ev.from} must not be ahead of offset=${offset}`);
          const overlap = offset - ev.from;
          reconstructed += Buffer.from(ev.bytes, 'utf8').subarray(overlap).toString('utf8');
          offset = ev.from + ev.byteLength;
        }
        assert.equal(reconstructed, 'chunk1\nchunk2\n');
      } finally {
        await close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
