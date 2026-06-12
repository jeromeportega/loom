import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AgentStore } from '../state/AgentStore.js';
import { EpicStore } from '../state/EpicStore.js';

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-as-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
});

describe('AgentStore — listLatestByEpic / listHistoryByStory (v0.5.0)', () => {
  it('collapses retries to the latest attempt per story_id', async () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agents = new AgentStore(db);
    const older = agents.create('epic-001', 'story-001-001', 'one');
    agents.updateStatus(older.id, 'blocked');
    await new Promise((r) => setTimeout(r, 5));
    const newer = agents.create('epic-001', 'story-001-001', 'one');
    agents.updateStatus(newer.id, 'done');

    const latest = agents.listLatestByEpic('epic-001');
    assert.equal(latest.length, 1, 'one row per story_id');
    assert.equal(latest[0].id, newer.id, 'newer attempt wins on updated_at');

    const history = agents.listHistoryByStory('story-001-001');
    assert.equal(history.length, 2, 'history holds every attempt');
    assert.equal(history[0].id, newer.id, 'history is newest-first');
    assert.equal(history[1].id, older.id);
  });

  it('tie-breaks two attempts with identical updated_at deterministically (no duplicate rows)', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    const agents = new AgentStore(db);

    // Same-millisecond writes are realistic in tight bulk loops. Without the
    // id tie-break, the `MAX(updated_at)` subquery returns BOTH rows — the
    // status renderer then shows one story twice. Force the collision by
    // updating two distinct agents to an identical timestamp.
    const a = agents.create('epic-001', 'story-001-001', 'one');
    const b = agents.create('epic-001', 'story-001-001', 'one');
    db.prepare(
      "UPDATE agents SET updated_at = '2026-06-09T12:00:00.000Z' WHERE id IN (?, ?)"
    ).run(a.id, b.id);

    const latest = agents.listLatestByEpic('epic-001');
    assert.equal(
      latest.length,
      1,
      'tie-break collapses same-timestamp duplicates to ONE row'
    );
    // The chosen row is deterministic: lexicographically largest id (MAX(id)
    // of the tied pair). Verify it's whichever of (a, b) sorts last.
    const expected = a.id > b.id ? a.id : b.id;
    assert.equal(latest[0].id, expected, 'tie-break picks MAX(id) of the tied pair');
  });
});
