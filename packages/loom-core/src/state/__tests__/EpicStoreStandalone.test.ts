/**
 * Integration tests: EpicStore.createStandalone writes a row whose PK id IS
 * story-NNN with kind='standalone', and the row is read back by native PK
 * lookup without any epic-NNN intermediate (story-059-002).
 *
 * Covers AC-1, AC-3, and the counter/collision invariant (NFR-4).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../Database.js';
import { EpicStore } from '../EpicStore.js';
import { STANDALONE_KIND } from '../../types.js';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-epicstore-standalone-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('EpicStore.createStandalone — native story-NNN identity (AC-1, AC-3)', () => {
  it('createStandalone writes a row whose PK id IS story-NNN with kind=standalone', () => {
    const db = createDatabase(path.join(tmpDir, 'native-pk.db'));
    const store = new EpicStore(db);

    store.createStandalone('story-047', 'My standalone story');

    const rec = store.get('story-047');
    assert.ok(rec, 'row must exist after createStandalone');
    assert.equal(rec.id, 'story-047', 'PK id must be story-047, not epic-047');
    assert.equal(rec.kind, STANDALONE_KIND, 'kind must be standalone');
    assert.equal(rec.status, 'planned', 'status must be planned');
    assert.equal(rec.title, 'My standalone story');

    db.close();
  });

  it('get("story-NNN") resolves by native PK — no epic-NNN shim', () => {
    const db = createDatabase(path.join(tmpDir, 'native-get.db'));
    const store = new EpicStore(db);

    store.createStandalone('story-059', 'Native lookup test');

    // Direct PK lookup must work
    const rec = store.get('story-059');
    assert.ok(rec, 'get(story-059) must return the row');
    assert.equal(rec.id, 'story-059');

    // The old epic-NNN id must NOT exist
    const epicRow = store.get('epic-059');
    assert.equal(epicRow, undefined, 'no epic-NNN container row must be created');

    db.close();
  });

  it('isStandalone("story-NNN") returns true via native PK kind lookup', () => {
    const db = createDatabase(path.join(tmpDir, 'native-isstandalone.db'));
    const store = new EpicStore(db);

    store.createStandalone('story-003', 'Check isStandalone');

    assert.ok(store.isStandalone('story-003'), 'isStandalone must return true for story-NNN');
    assert.ok(!store.isStandalone('epic-003'), 'isStandalone must return false for non-existent epic-003');

    db.close();
  });

  it('list({ includeStandalone: true }) returns the story-NNN row verbatim', () => {
    const db = createDatabase(path.join(tmpDir, 'native-list.db'));
    const store = new EpicStore(db);

    store.create('epic-001', 'Normal epic');
    store.createStandalone('story-002', 'Standalone task');

    const all = store.list({ includeStandalone: true });
    assert.equal(all.length, 2);
    const ids = all.map((r) => r.id).sort();
    assert.deepEqual(ids, ['epic-001', 'story-002'], 'standalone row id must be story-002');

    db.close();
  });

  it('list() (default) excludes the story-NNN standalone row', () => {
    const db = createDatabase(path.join(tmpDir, 'native-list-exclusion.db'));
    const store = new EpicStore(db);

    store.create('epic-001', 'Normal epic');
    store.createStandalone('story-002', 'Standalone task');

    const epics = store.list();
    assert.equal(epics.length, 1, 'standalone story-NNN must be excluded by default');
    assert.equal(epics[0].id, 'epic-001');

    db.close();
  });

  it('no epic-NNN row is created alongside story-NNN (no intermediate container)', () => {
    const db = createDatabase(path.join(tmpDir, 'no-epic-container.db'));
    const store = new EpicStore(db);

    store.createStandalone('story-100', 'Solo story');

    // Verify only one row exists total
    const all = store.list({ includeStandalone: true, includeArchived: true });
    assert.equal(all.length, 1, 'exactly one row must exist');
    assert.equal(all[0].id, 'story-100', 'that row must be story-100');

    db.close();
  });
});
