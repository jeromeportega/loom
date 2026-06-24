/**
 * Unit tests for planner id formatting and the shared global counter (story-059-002).
 *
 * Covers:
 *  - storyId(): zero-pad formatting
 *  - idNumber(): parses both 'epic-NNN' and 'story-NNN'; 0 on unknown input
 *  - epicNumber(): back-compat regression — same values as before, delegating through idNumber
 *  - Planner.nextEpicId(): counts story-NNN rows so the counter can never reuse a number (NFR-4)
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, resetDatabaseForTest } from '../../state/Database.js';
import { EpicStore } from '../../state/EpicStore.js';
import { Planner } from '../Planner.js';
import { storyId, idNumber, epicNumber, epicId } from '../paths.js';

// ─── storyId() ────────────────────────────────────────────────────────────────

describe('storyId() — zero-pad formatting', () => {
  it('storyId(3) === "story-003"', () => {
    assert.equal(storyId(3), 'story-003');
  });

  it('storyId(1) === "story-001"', () => {
    assert.equal(storyId(1), 'story-001');
  });

  it('storyId(47) === "story-047"', () => {
    assert.equal(storyId(47), 'story-047');
  });

  it('storyId(100) === "story-100"', () => {
    assert.equal(storyId(100), 'story-100');
  });

  it('storyId(999) === "story-999"', () => {
    assert.equal(storyId(999), 'story-999');
  });

  it('storyId(1000) === "story-1000" (no truncation for large numbers)', () => {
    assert.equal(storyId(1000), 'story-1000');
  });

  it('storyId(0) === "story-000"', () => {
    assert.equal(storyId(0), 'story-000');
  });
});

// ─── idNumber() ───────────────────────────────────────────────────────────────

describe('idNumber() — parses both epic-NNN and story-NNN', () => {
  it('idNumber("epic-047") === 47', () => {
    assert.equal(idNumber('epic-047'), 47);
  });

  it('idNumber("story-047") === 47', () => {
    assert.equal(idNumber('story-047'), 47);
  });

  it('idNumber("epic-001") === 1', () => {
    assert.equal(idNumber('epic-001'), 1);
  });

  it('idNumber("story-001") === 1', () => {
    assert.equal(idNumber('story-001'), 1);
  });

  it('idNumber("epic-999") === 999', () => {
    assert.equal(idNumber('epic-999'), 999);
  });

  it('idNumber("story-999") === 999', () => {
    assert.equal(idNumber('story-999'), 999);
  });

  it('idNumber("garbage") === 0', () => {
    assert.equal(idNumber('garbage'), 0);
  });

  it('idNumber("") === 0', () => {
    assert.equal(idNumber(''), 0);
  });

  it('idNumber(null) === 0 (no throw)', () => {
    assert.doesNotThrow(() => idNumber(null));
    assert.equal(idNumber(null), 0);
  });

  it('idNumber(undefined) === 0 (no throw)', () => {
    assert.doesNotThrow(() => idNumber(undefined));
    assert.equal(idNumber(undefined), 0);
  });

  it('idNumber("epic-") === 0 (no digit group)', () => {
    assert.equal(idNumber('epic-'), 0);
  });

  it('idNumber("story-") === 0 (no digit group)', () => {
    assert.equal(idNumber('story-'), 0);
  });

  it('idNumber("EPIC-001") === 0 (case sensitive)', () => {
    assert.equal(idNumber('EPIC-001'), 0);
  });

  it('idNumber("epic-abc") === 0 (non-numeric)', () => {
    assert.equal(idNumber('epic-abc'), 0);
  });

  it('round-trip: idNumber(epicId(N)) === N for representative values', () => {
    for (const n of [1, 47, 100, 999]) {
      assert.equal(idNumber(epicId(n)), n, `round-trip failed for N=${n}`);
    }
  });

  it('round-trip: idNumber(storyId(N)) === N for representative values', () => {
    for (const n of [1, 47, 100, 999]) {
      assert.equal(idNumber(storyId(n)), n, `round-trip failed for N=${n}`);
    }
  });
});

// ─── epicNumber() back-compat ─────────────────────────────────────────────────

describe('epicNumber() — back-compat regression guard (same values as before)', () => {
  it('epicNumber("epic-047") === 47', () => {
    assert.equal(epicNumber('epic-047'), 47);
  });

  it('epicNumber("epic-001") === 1', () => {
    assert.equal(epicNumber('epic-001'), 1);
  });

  it('epicNumber("epic-999") === 999', () => {
    assert.equal(epicNumber('epic-999'), 999);
  });

  it('epicNumber("story-047") === 0 (back-compat: story- prefix not counted)', () => {
    assert.equal(epicNumber('story-047'), 0);
  });

  it('epicNumber("garbage") === 0', () => {
    assert.equal(epicNumber('garbage'), 0);
  });

  it('epicNumber("") === 0', () => {
    assert.equal(epicNumber(''), 0);
  });
});

// ─── Planner.nextEpicId counter (NFR-4) ──────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  resetDatabaseForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-planner-identity-'));
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb() {
  return openDatabase(path.join(tmpDir, '.loom'));
}

describe('Planner.nextEpicId — counter uses idNumber across both prefixes (NFR-4)', () => {
  it('empty DB → first id is epic-001', () => {
    const db = makeDb();
    assert.equal(Planner.nextEpicId(db), 'epic-001');
  });

  it('CRITICAL: story-047 row alone → nextEpicId returns epic-048 (no number reuse)', () => {
    const db = makeDb();
    const store = new EpicStore(db);
    store.createStandalone('story-047', 'Standalone story');
    const next = Planner.nextEpicId(db);
    assert.equal(
      next,
      'epic-048',
      'nextEpicId must see story-047 and skip 47, otherwise a future epic reuses the number'
    );
  });

  it('mixed rows (epic-003, story-047) → nextEpicId returns epic-048', () => {
    const db = makeDb();
    const store = new EpicStore(db);
    store.create('epic-003', 'Regular epic');
    store.createStandalone('story-047', 'Standalone story');
    assert.equal(Planner.nextEpicId(db), 'epic-048');
  });

  it('story-047 row archived → still counted (archived rows are visible)', () => {
    const db = makeDb();
    const store = new EpicStore(db);
    store.createStandalone('story-047', 'Archived standalone');
    store.archive('story-047');
    assert.equal(Planner.nextEpicId(db), 'epic-048', 'archived story row must still count');
  });

  it('epic-003 alone → nextEpicId returns epic-004', () => {
    const db = makeDb();
    new EpicStore(db).create('epic-003', 'Just an epic');
    assert.equal(Planner.nextEpicId(db), 'epic-004');
  });

  it('story-003 and epic-003 cannot coexist (same number, different prefix = collision guard)', () => {
    const db = makeDb();
    const store = new EpicStore(db);
    store.create('epic-003', 'Epic');
    store.createStandalone('story-003', 'Standalone');
    // Both rows exist; counter sees max=3 from either, next = 4
    assert.equal(Planner.nextEpicId(db), 'epic-004');
  });
});
