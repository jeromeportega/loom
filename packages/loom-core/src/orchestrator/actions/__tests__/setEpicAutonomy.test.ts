import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase } from '../../../state/Database.js';
import { EpicStore } from '../../../state/EpicStore.js';
import { AuditLog } from '../../../state/AuditLog.js';
import { setEpicAutonomy, EpicNotFoundError } from '../setEpicAutonomy.js';
import type { AutonomyLevel } from '../../../types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-setautonomy-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshDeps(): { epicStore: EpicStore; auditLog: AuditLog } {
  const db = createDatabase(path.join(tmpDir, `${process.hrtime.bigint().toString()}.db`));
  const epicStore = new EpicStore(db);
  const auditLog = new AuditLog(db);
  epicStore.create('epic-001', 'Test Epic');
  return { epicStore, auditLog };
}

describe('setEpicAutonomy — happy path', () => {
  it('returns { id, autonomy_level } on success', () => {
    const deps = freshDeps();
    const result = setEpicAutonomy(deps, 'epic-001', 'full-auto', 'web');
    assert.deepEqual(result, { id: 'epic-001', autonomy_level: 'full-auto' });
  });

  it('persists the level so getAutonomy reflects the new value', () => {
    const deps = freshDeps();
    setEpicAutonomy(deps, 'epic-001', 'checkpoint', 'web');
    assert.equal(deps.epicStore.getAutonomy('epic-001'), 'checkpoint');
  });

  it('overwrites a previous level', () => {
    const deps = freshDeps();
    setEpicAutonomy(deps, 'epic-001', 'full-auto', 'web');
    setEpicAutonomy(deps, 'epic-001', 'manual', 'web');
    assert.equal(deps.epicStore.getAutonomy('epic-001'), 'manual');
  });
});

describe('setEpicAutonomy — audit row', () => {
  for (const actor of ['web', 'mcp'] as const) {
    it(`writes an autonomy_set audit row for actor=${actor}`, () => {
      const deps = freshDeps();
      const level: AutonomyLevel = 'full-auto';
      setEpicAutonomy(deps, 'epic-001', level, actor);
      const rows = deps.auditLog.getByCommand('epic-001');
      const row = rows.find((r) => r.action === 'autonomy_set');
      assert.ok(row, 'autonomy_set audit row must exist');
      assert.equal(row.command, 'epic-001');
      const detail = JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
      assert.equal(detail.level, level);
      assert.equal(detail.actor, actor);
    });
  }

  it('writes exactly one audit row per call', () => {
    const deps = freshDeps();
    setEpicAutonomy(deps, 'epic-001', 'full-auto', 'web');
    const rows = deps.auditLog.getByCommand('epic-001').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 1);
  });

  it('writes no audit row when the epic is unknown', () => {
    const deps = freshDeps();
    try {
      setEpicAutonomy(deps, 'epic-999', 'full-auto', 'web');
    } catch {
      // expected
    }
    const rows = deps.auditLog.getByCommand('epic-999').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 0);
  });
});

describe('setEpicAutonomy — unknown epic', () => {
  it('throws EpicNotFoundError for an unknown id', () => {
    const deps = freshDeps();
    assert.throws(
      () => setEpicAutonomy(deps, 'epic-999', 'full-auto', 'web'),
      (err: unknown) => err instanceof EpicNotFoundError
    );
  });

  it('leaves autonomy unchanged for other epics when unknown id is used', () => {
    const deps = freshDeps();
    try {
      setEpicAutonomy(deps, 'epic-999', 'full-auto', 'web');
    } catch {
      // expected
    }
    assert.equal(deps.epicStore.getAutonomy('epic-001'), 'manual');
  });
});

describe('setEpicAutonomy — identical effect for both actors', () => {
  it('produces same persisted value and same audit row shape for web vs mcp', () => {
    const dbPath1 = path.join(tmpDir, 'db1.db');
    const dbPath2 = path.join(tmpDir, 'db2.db');
    const db1 = createDatabase(dbPath1);
    const db2 = createDatabase(dbPath2);
    const epic1 = new EpicStore(db1);
    const audit1 = new AuditLog(db1);
    const epic2 = new EpicStore(db2);
    const audit2 = new AuditLog(db2);
    epic1.create('epic-001', 'E1');
    epic2.create('epic-001', 'E1');

    const r1 = setEpicAutonomy({ epicStore: epic1, auditLog: audit1 }, 'epic-001', 'checkpoint', 'web');
    const r2 = setEpicAutonomy({ epicStore: epic2, auditLog: audit2 }, 'epic-001', 'checkpoint', 'mcp');

    // Same return shape
    assert.equal(r1.id, r2.id);
    assert.equal(r1.autonomy_level, r2.autonomy_level);

    // Same persisted value
    assert.equal(epic1.getAutonomy('epic-001'), epic2.getAutonomy('epic-001'));

    // Same audit row shape (except actor field)
    const row1Detail = JSON.parse(
      audit1.getByCommand('epic-001').find((r) => r.action === 'autonomy_set')?.detail ?? '{}'
    ) as Record<string, unknown>;
    const row2Detail = JSON.parse(
      audit2.getByCommand('epic-001').find((r) => r.action === 'autonomy_set')?.detail ?? '{}'
    ) as Record<string, unknown>;
    assert.equal(row1Detail.level, row2Detail.level);
    assert.equal(row1Detail.actor, 'web');
    assert.equal(row2Detail.actor, 'mcp');
  });
});
