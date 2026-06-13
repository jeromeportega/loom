import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
  AuditLog,
  createDatabase,
  setEpicAutonomy,
} from '@loom-ai/core';
import { HANDLERS } from '../tools/handlers.js';
import { TOOL_DEFINITIONS } from '../tools/registry.js';
import type { ToolContext } from '../tools/context.js';

let loomDir: string;
let tmpDir: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

function ctx(): ToolContext {
  return {
    projectRoot: tmpDir,
    loomDir,
    createLLM: () => { throw new Error('not used in setAutonomy tests'); },
    createWorker: () => { throw new Error('not used in setAutonomy tests'); },
    background: () => {},
  };
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-setautonomy-mcp-'));
  loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  // Seed the DB and pre-create an epic.
  const db = openDatabase(loomDir);
  new EpicStore(db).create('epic-001', 'Test Epic');
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

describe('loom_set_autonomy — tool definition', () => {
  it('is registered in TOOL_DEFINITIONS', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'loom_set_autonomy');
    assert.ok(def, 'loom_set_autonomy must be in TOOL_DEFINITIONS');
    assert.deepEqual(def.inputSchema.required, ['epic_id', 'level']);
  });

  it('is registered in HANDLERS', () => {
    assert.ok(typeof HANDLERS.loom_set_autonomy === 'function', 'HANDLERS.loom_set_autonomy must exist');
  });
});

describe('loom_set_autonomy — happy path', () => {
  it('returns { id, autonomy_level } on success', async () => {
    const r = (await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'full-auto' })) as {
      id: string;
      autonomy_level: string;
    };
    assert.equal(r.id, 'epic-001');
    assert.equal(r.autonomy_level, 'full-auto');
  });

  it('persists the level so getAutonomy reflects the new value', async () => {
    await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'checkpoint' });
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).getAutonomy('epic-001'), 'checkpoint');
  });

  it('writes an autonomy_set audit row with actor=mcp', async () => {
    await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'full-auto' });
    const db = openDatabase(loomDir);
    const rows = new AuditLog(db).getByCommand('epic-001').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}') as Record<string, unknown>;
    assert.equal(detail.level, 'full-auto');
    assert.equal(detail.actor, 'mcp');
  });
});

describe('loom_set_autonomy — validation', () => {
  it('returns an error for an invalid level', async () => {
    const r = (await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'turbo' })) as {
      status: string;
      message: string;
    };
    assert.equal(r.status, 'error');
    const db = openDatabase(loomDir);
    assert.equal(new EpicStore(db).getAutonomy('epic-001'), 'manual');
  });

  it('returns an error for a missing level', async () => {
    const r = (await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('returns an error for a missing epic_id', async () => {
    const r = (await HANDLERS.loom_set_autonomy(ctx(), { level: 'full-auto' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('writes no audit row on validation failure', async () => {
    await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'turbo' });
    const db = openDatabase(loomDir);
    const rows = new AuditLog(db).getByCommand('epic-001').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 0);
  });
});

describe('loom_set_autonomy — unknown epic', () => {
  it('returns an error for an unknown epic id', async () => {
    const r = (await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-999', level: 'full-auto' })) as {
      status: string;
    };
    assert.equal(r.status, 'error');
  });

  it('writes no audit row for an unknown epic', async () => {
    await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-999', level: 'full-auto' });
    const db = openDatabase(loomDir);
    const rows = new AuditLog(db).getByCommand('epic-999').filter((r) => r.action === 'autonomy_set');
    assert.equal(rows.length, 0);
  });
});

describe('loom_set_autonomy — identical effect as web route', () => {
  it('produces the same persisted level and audit row shape as setEpicAutonomy with actor=web', async () => {
    // MCP surface
    await HANDLERS.loom_set_autonomy(ctx(), { epic_id: 'epic-001', level: 'checkpoint' });
    const db = openDatabase(loomDir);
    const mcpLevel = new EpicStore(db).getAutonomy('epic-001');
    const mcpAuditRow = new AuditLog(db)
      .getByCommand('epic-001')
      .find((r) => r.action === 'autonomy_set');
    assert.ok(mcpAuditRow);
    const mcpDetail = JSON.parse(mcpAuditRow.detail ?? '{}') as Record<string, unknown>;

    // Direct core action (web actor) on a separate DB
    const db2 = createDatabase(path.join(tmpDir, 'db2.db'));
    const es2 = new EpicStore(db2);
    const al2 = new AuditLog(db2);
    es2.create('epic-001', 'Test Epic');
    setEpicAutonomy({ epicStore: es2, auditLog: al2 }, 'epic-001', 'checkpoint', 'web');
    const webLevel = es2.getAutonomy('epic-001');
    const webAuditRow = al2.getByCommand('epic-001').find((r) => r.action === 'autonomy_set');
    assert.ok(webAuditRow);
    const webDetail = JSON.parse(webAuditRow.detail ?? '{}') as Record<string, unknown>;

    // Same persisted level
    assert.equal(mcpLevel, webLevel);
    // Same audit action and level; only actor differs
    assert.equal(mcpAuditRow.action, webAuditRow.action);
    assert.equal(mcpDetail.level, webDetail.level);
    assert.equal(mcpDetail.actor, 'mcp');
    assert.equal(webDetail.actor, 'web');
  });
});
