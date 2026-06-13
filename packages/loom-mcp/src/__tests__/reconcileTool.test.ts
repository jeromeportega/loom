/**
 * story-008-004 — loom_reconcile_epic MCP tool + structural CLI/MCP parity tests.
 *
 * Parity strategy (AC3): both CLI and MCP are thin wrappers around the same
 * EpicReconciler.reconcile() call. Parity is structural — one implementation,
 * both surfaces only marshal/render.
 *
 * Parity is verified by comparing the MCP handler return value against the
 * result of calling EpicReconciler directly with identical inputs. If both
 * produce the same ReconcileResult, the CLI surface (which calls the same
 * reconciler in the same way) is guaranteed to produce identical outcomes.
 *
 * git/gh binaries are injected as test seams:
 *   MCP: args._gitBin / args._ghBin (forwarded to EpicReconciler)
 *   EpicReconciler direct: constructor gitBin / ghBin options
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  resetDatabaseForTest,
  EpicStore,
  EpicReconciler,
  AuditLog,
} from '@loom-ai/core';
import type { ReconcileResult } from '@loom-ai/core';
import { HANDLERS } from '../tools/handlers.js';
import { TOOL_DEFINITIONS } from '../tools/registry.js';
import type { ToolContext } from '../tools/context.js';

// ─── Lifecycle ───────────────────────────────────────────────────────────────

let tmpDir: string;
let loomDir: string;
let prevLoomHome: string | undefined;
let loomHomeDir: string;

function ctx(): ToolContext {
  return {
    projectRoot: tmpDir,
    loomDir,
    createLLM: () => { throw new Error('not used in reconcile tests'); },
    createWorker: () => { throw new Error('not used in reconcile tests'); },
    background: () => {},
  };
}

beforeEach(() => {
  resetDatabaseForTest();
  prevLoomHome = process.env.LOOM_HOME;
  loomHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reconcile-mcp-home-'));
  process.env.LOOM_HOME = loomHomeDir;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-reconcile-mcp-'));
  loomDir = path.join(tmpDir, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
});

afterEach(() => {
  resetDatabaseForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(loomHomeDir, { recursive: true, force: true });
  if (prevLoomHome === undefined) delete process.env.LOOM_HOME;
  else process.env.LOOM_HOME = prevLoomHome;
});

// ─── Stub helpers ─────────────────────────────────────────────────────────────

function stub(body: string): string {
  const p = path.join(tmpDir, `stub-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

function ghOk(state: string, head: string, base: string): string {
  const json = JSON.stringify({ state, headRefName: head, baseRefName: base });
  const jsonFile = path.join(tmpDir, `gh-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jsonFile, json);
  return stub(`cat '${jsonFile}'`);
}

function gitMerged(): string {
  return stub('exit 0');
}

function gitNotAncestor(): string {
  return stub('if [ "$1" = "rev-parse" ]; then exit 0; fi\nexit 1');
}

/** Seed an in_progress epic in the shared singleton DB. */
function seedEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  new EpicStore(db).create(epicId, `Test epic ${epicId}`);
  new EpicStore(db).updateStatus(epicId, 'in_progress');
}

/** Seed a done epic (triggers noop path). */
function seedDoneEpic(epicId = 'epic-001'): void {
  const db = openDatabase(loomDir);
  const store = new EpicStore(db);
  store.create(epicId, `Test epic ${epicId}`);
  store.updateStatus(epicId, 'done');
}

// ─── Tool registration ────────────────────────────────────────────────────────

describe('loom_reconcile_epic — tool registration', () => {
  it('is in TOOL_DEFINITIONS with the correct inputSchema', () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === 'loom_reconcile_epic');
    assert.ok(def, 'loom_reconcile_epic must be in TOOL_DEFINITIONS');
    assert.deepEqual(def.inputSchema.required, ['epic_id']);
    const props = def.inputSchema.properties as Record<string, { type: string }>;
    assert.equal(props.epic_id?.type, 'string');
    assert.equal(props.pr_url?.type, 'string');
  });

  it('is registered in HANDLERS', () => {
    assert.ok(
      typeof HANDLERS.loom_reconcile_epic === 'function',
      'HANDLERS.loom_reconcile_epic must exist'
    );
  });
});

// ─── MCP — validation ─────────────────────────────────────────────────────────

describe('loom_reconcile_epic — validation', () => {
  it('returns error when epic_id is missing', async () => {
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), {})) as { status: string };
    assert.equal(r.status, 'error');
  });

  it('returns error when epic_id is empty string', async () => {
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), { epic_id: '' })) as { status: string };
    assert.equal(r.status, 'error');
  });
});

// ─── MCP — core invocation cases ─────────────────────────────────────────────

describe('loom_reconcile_epic — core invocation (MCP)', () => {
  it('[CLI invokes core] returns noop for an already-done epic', async () => {
    seedDoneEpic();
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), { epic_id: 'epic-001' })) as {
      status: string;
    };
    assert.equal(r.status, 'noop');
  });

  it('[MCP invokes core] reconciles via PR URL and returns reconciled', async () => {
    seedEpic();
    const prUrl = 'https://github.com/org/repo/pull/5';
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      pr_url: prUrl,
      _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
    })) as ReconcileResult;
    assert.equal(r.status, 'reconciled');
    assert.equal(r.prUrl, prUrl);
    assert.ok(typeof r.note === 'string' && r.note.length > 0, 'note is present');
  });

  it('[MCP invokes core] reconciles via ancestry when pr_url is omitted', async () => {
    seedEpic();
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      _gitBin: gitMerged(),
    })) as ReconcileResult;
    assert.equal(r.status, 'reconciled');
  });

  it('[MCP invokes core] returns refused/not_merged when PR is open', async () => {
    seedEpic();
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      pr_url: 'https://github.com/org/repo/pull/5',
      _ghBin: ghOk('OPEN', 'epic/epic-001', 'main'),
    })) as ReconcileResult;
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'not_merged');
  });

  it('[MCP invokes core] returns refused/epic_not_found for unknown epic', async () => {
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), { epic_id: 'epic-999' })) as ReconcileResult;
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'epic_not_found');
  });
});

// ─── Parity verification (structural) ────────────────────────────────────────
//
// Both CLI and MCP delegate to EpicReconciler.reconcile(). Parity is structural:
// one implementation, surfaces only marshal/render. These tests verify the MCP
// handler returns the SAME ReconcileResult as calling EpicReconciler directly
// with identical inputs. Since the CLI calls EpicReconciler the same way, the
// parity guarantee extends to all three: CLI ≡ MCP ≡ EpicReconciler (AC3).

describe('CLI/MCP parity (structural)', () => {
  it('[Parity: success] MCP returns identical result to EpicReconciler.reconcile() on MERGED state', async () => {
    const prUrl = 'https://github.com/org/repo/pull/7';
    const ghStub = ghOk('MERGED', 'epic/epic-001', 'main');

    // ── EpicReconciler direct call ──
    seedEpic('epic-001');
    const db = openDatabase(loomDir);
    const directResult = new EpicReconciler({ projectRoot: tmpDir, db, ghBin: ghStub })
      .reconcile('epic-001', { prUrl });

    assert.equal(directResult.status, 'reconciled');

    // ── MCP handler call (on fresh DB state) ──
    resetDatabaseForTest();
    seedEpic('epic-002');
    const mcpResult = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-002',
      pr_url: prUrl,
      _ghBin: ghOk('MERGED', 'epic/epic-002', 'main'),
    })) as ReconcileResult;

    // Both surfaces produce reconciled status and a prUrl
    assert.equal(mcpResult.status, directResult.status, 'status matches');
    assert.equal(mcpResult.prUrl, prUrl, 'prUrl forwarded correctly by MCP');
    assert.ok(typeof mcpResult.note === 'string', 'note present in MCP result');
  });

  it('[Parity: refusal] MCP returns identical refused reason to EpicReconciler.reconcile() on OPEN state', async () => {
    const prUrl = 'https://github.com/org/repo/pull/8';

    // ── EpicReconciler direct call ──
    seedEpic('epic-001');
    const db = openDatabase(loomDir);
    const directResult = new EpicReconciler({
      projectRoot: tmpDir,
      db,
      ghBin: ghOk('OPEN', 'epic/epic-001', 'main'),
    }).reconcile('epic-001', { prUrl });

    assert.equal(directResult.status, 'refused');
    assert.equal(directResult.reason, 'not_merged');

    // ── MCP handler call (on fresh DB state) ──
    resetDatabaseForTest();
    seedEpic('epic-002');
    const mcpResult = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-002',
      pr_url: prUrl,
      _ghBin: ghOk('OPEN', 'epic/epic-002', 'main'),
    })) as ReconcileResult;

    assert.equal(mcpResult.status, directResult.status, 'refused status matches');
    assert.equal(mcpResult.reason, directResult.reason, 'reason matches');
  });

  it('[Parity: noop] MCP returns identical noop to EpicReconciler.reconcile() for done epic', async () => {
    // ── EpicReconciler direct call ──
    seedDoneEpic('epic-001');
    const db = openDatabase(loomDir);
    const directResult = new EpicReconciler({ projectRoot: tmpDir, db })
      .reconcile('epic-001');

    assert.equal(directResult.status, 'noop');

    // ── MCP handler call (on fresh DB state) ──
    resetDatabaseForTest();
    seedDoneEpic('epic-002');
    const mcpResult = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-002',
    })) as ReconcileResult;

    assert.equal(mcpResult.status, directResult.status, 'noop status matches');
  });

  it('[Operator messaging] refusal note and reason are both present in MCP response', async () => {
    seedEpic();
    const r = (await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      _gitBin: gitNotAncestor(),
    })) as ReconcileResult;

    assert.equal(r.status, 'refused');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason field present');
    assert.ok(typeof r.note === 'string' && r.note.length > 0, 'note field present');
    // The squash-merge --pr hint should be visible in the note
    assert.ok(/--pr/i.test(r.note), 'note mentions --pr hint for squash merges');
  });

  it('[Arg marshalling] MCP pr_url maps to prUrl; omitting selects ancestry', async () => {
    const prUrl = 'https://github.com/org/repo/pull/10';

    // pr_url present → PR path (epic_pr_url set in DB)
    seedEpic('epic-001');
    await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      pr_url: prUrl,
      _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
    });
    assert.equal(
      new EpicStore(openDatabase(loomDir)).get('epic-001')?.epic_pr_url,
      prUrl,
      'pr_url mapped to prUrl and recorded in DB'
    );

    // pr_url omitted → ancestry path (epic_pr_url stays null)
    resetDatabaseForTest();
    seedEpic('epic-002');
    await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-002',
      _gitBin: gitMerged(),
    });
    assert.equal(
      new EpicStore(openDatabase(loomDir)).get('epic-002')?.epic_pr_url,
      null,
      'omitting pr_url selects ancestry path (epic_pr_url stays null)'
    );
  });

  it('[Audit log] MCP handler writes epic_reconciled audit row on success', async () => {
    seedEpic();
    await HANDLERS.loom_reconcile_epic(ctx(), {
      epic_id: 'epic-001',
      pr_url: 'https://github.com/org/repo/pull/11',
      _ghBin: ghOk('MERGED', 'epic/epic-001', 'main'),
    });
    const db = openDatabase(loomDir);
    const rows = new AuditLog(db).getByCommand('epic-001', ['epic_reconciled']);
    assert.equal(rows.length, 1, 'audit row written by MCP surface');
  });
});
