import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../state/Database.js';
import { AuditLog } from '../state/AuditLog.js';
import { EpicStore } from '../state/EpicStore.js';
import { AgentStore } from '../state/AgentStore.js';
import type Database from 'better-sqlite3';

/**
 * Inserts an `agents` row with the exact id we need to test the LIKE/length
 * guard in `getByStory` — bypasses `AgentStore.create()`'s random suffix so
 * the test controls the agent_id shape under audit.
 */
function seedAgent(db: Database.Database, id: string, storyId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO agents (id, epic_id, story_id, status, updated_at) VALUES (?, 'epic-001', ?, 'done', ?)"
  ).run(id, storyId, now);
}

let loomDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-al-'));
  loomDir = path.join(tmp, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
});

describe('AuditLog.getByStory — story-id prefix guard (v0.5.0)', () => {
  it('returns rows for an exact story_id match across agent_id and command shapes', () => {
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-001-abcdef01', 'story-001-001');
    seedAgent(db, 'agent-story-001-001-12345678', 'story-001-001');
    seedAgent(db, 'agent-story-001-002-deadbeef', 'story-001-002');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-001-abcdef01', action: 'dispatch' });
    audit.record({ agent_id: 'agent-story-001-001-12345678', action: 'completion' });
    audit.record({
      action: 'epic_integration_attempt',
      command: 'story-001-001',
    });
    audit.record({ agent_id: 'agent-story-001-002-deadbeef', action: 'dispatch' });

    const rows = audit.getByStory('story-001-001');
    const actions = rows.map((r) => r.action).sort();
    assert.deepEqual(
      actions,
      ['completion', 'dispatch', 'epic_integration_attempt'],
      'matches every attempt + the rolling-integrator command row'
    );
  });

  it('does NOT match a story_id that is a prefix of another (length guard)', () => {
    // The bug: `LIKE 'agent-story-001-%'` matches `agent-story-001-002-<hex>`.
    // With the length guard, `story-001` only matches `agent-story-001-<8hex>`
    // — a (well-formed) agent whose storyId is exactly `story-001`. The
    // `story-001-002` agents stay invisible to this query.
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-002-abcdef01', 'story-001-002');
    seedAgent(db, 'agent-story-001-002-deadbeef', 'story-001-002');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-002-abcdef01', action: 'dispatch' });
    audit.record({ agent_id: 'agent-story-001-002-deadbeef', action: 'completion' });

    const rows = audit.getByStory('story-001');
    assert.equal(rows.length, 0, 'no rows leak in from sibling stories whose id starts the same');
  });

  it('positive control: a well-formed agent-<story-001>-<8hex> row DOES match story-001', () => {
    // Belt-and-suspenders for the length guard: the prior test shows we don't
    // bleed sibling stories in, but we also must not over-restrict the
    // legitimate match. A bare `story-001` story (well-formed, just shorter
    // than the loom-canonical `story-NNN-MMM`) with one own agent_id should
    // be returned by `getByStory('story-001')`.
    const db = openDatabase(loomDir);
    new EpicStore(db).create('epic-001', 'Epic 1');
    seedAgent(db, 'agent-story-001-deadbeef', 'story-001');
    const audit = new AuditLog(db);
    audit.record({ agent_id: 'agent-story-001-deadbeef', action: 'dispatch' });
    const rows = audit.getByStory('story-001');
    assert.equal(rows.length, 1, 'well-formed agent_id matches its own storyId');
  });

  it('command=<storyId> rows are picked up even when no agent_id matches', () => {
    const audit = new AuditLog(openDatabase(loomDir));
    audit.record({
      action: 'epic_rolling_merge_conflict',
      command: 'story-005-006',
    });
    const rows = audit.getByStory('story-005-006');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'epic_rolling_merge_conflict');
  });
});
