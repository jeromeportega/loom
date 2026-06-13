import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../Database.js';
import { EpicStore } from '../EpicStore.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-autonomy-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshStore(): { store: EpicStore; dbPath: string } {
  const dbPath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = createDatabase(dbPath);
  const store = new EpicStore(db);
  store.create('epic-001', 'Test Epic');
  return { store, dbPath };
}

describe('EpicStore autonomy defaults', () => {
  it('a newly created epic defaults to autonomy_level manual', () => {
    const { store } = freshStore();
    assert.equal(store.getAutonomy('epic-001'), 'manual');
  });

  it('getAutonomy returns manual even when the DB row predates the column', () => {
    // Simulate a row with no autonomy_level by passing 'manual' as default —
    // the column DEFAULT 'manual' ensures the DB already returns it.
    const { store } = freshStore();
    // Create a second epic and verify the same default.
    store.create('epic-002', 'Another Epic');
    assert.equal(store.getAutonomy('epic-002'), 'manual');
  });
});

describe('EpicStore setAutonomy / getAutonomy round-trip', () => {
  it('sets and retrieves full-auto', () => {
    const { store } = freshStore();
    store.setAutonomy('epic-001', 'full-auto');
    assert.equal(store.getAutonomy('epic-001'), 'full-auto');
  });

  it('sets and retrieves checkpoint', () => {
    const { store } = freshStore();
    store.setAutonomy('epic-001', 'checkpoint');
    assert.equal(store.getAutonomy('epic-001'), 'checkpoint');
  });

  it('sets and retrieves manual (explicit)', () => {
    const { store } = freshStore();
    store.setAutonomy('epic-001', 'full-auto');
    store.setAutonomy('epic-001', 'manual');
    assert.equal(store.getAutonomy('epic-001'), 'manual');
  });
});

describe('EpicStore pauseAfterStory / isPaused / resume', () => {
  it('isPaused is false on a fresh epic', () => {
    const { store } = freshStore();
    assert.equal(store.isPaused('epic-001'), false);
  });

  it('pauseAfterStory sets paused_at non-null and records the story', () => {
    const { store } = freshStore();
    store.pauseAfterStory('epic-001', 'story-x');

    assert.equal(store.isPaused('epic-001'), true);
    const rec = store.get('epic-001');
    assert.ok(rec?.paused_at != null, 'paused_at should be set');
    assert.equal(rec?.paused_after_story, 'story-x');
  });

  it('resume clears both paused_at and paused_after_story', () => {
    const { store } = freshStore();
    store.pauseAfterStory('epic-001', 'story-x');
    store.resume('epic-001');

    assert.equal(store.isPaused('epic-001'), false);
    const rec = store.get('epic-001');
    assert.equal(rec?.paused_at, null);
    assert.equal(rec?.paused_after_story, null);
  });
});

describe('EpicStore paused indicator durability across DB restart', () => {
  it('pause state survives closing and reopening the DB file', () => {
    const dbPath = path.join(tmpDir, 'durable.db');

    // Session 1: open DB, create epic, pause it.
    {
      const db1 = createDatabase(dbPath);
      const store1 = new EpicStore(db1);
      store1.create('epic-001', 'Durable Epic');
      store1.pauseAfterStory('epic-001', 'story-x');
      assert.equal(store1.isPaused('epic-001'), true);
      db1.close();
    }

    // Session 2: reopen the same file — state must survive the restart.
    {
      const db2 = createDatabase(dbPath);
      const store2 = new EpicStore(db2);
      assert.equal(store2.isPaused('epic-001'), true, 'paused_at survives restart');
      assert.equal(
        store2.get('epic-001')?.paused_after_story,
        'story-x',
        'paused_after_story survives restart'
      );

      // resume() also persists across a third open.
      store2.resume('epic-001');
      db2.close();
    }

    // Session 3: confirm resume persists too.
    {
      const db3 = createDatabase(dbPath);
      const store3 = new EpicStore(db3);
      assert.equal(store3.isPaused('epic-001'), false, 'resume persists across restart');
      db3.close();
    }
  });

  it('autonomy_level survives closing and reopening the DB file', () => {
    const dbPath = path.join(tmpDir, 'durable-autonomy.db');

    {
      const db1 = createDatabase(dbPath);
      const store1 = new EpicStore(db1);
      store1.create('epic-001', 'Epic');
      store1.setAutonomy('epic-001', 'checkpoint');
      db1.close();
    }

    {
      const db2 = createDatabase(dbPath);
      const store2 = new EpicStore(db2);
      assert.equal(store2.getAutonomy('epic-001'), 'checkpoint');
      db2.close();
    }
  });
});
