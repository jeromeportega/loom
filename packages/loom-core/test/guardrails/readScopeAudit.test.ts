/**
 * Integration tests for the read_scope_denied audit log entries (story-067-004).
 *
 * Uses a real better-sqlite3 in-memory database so rows actually land in
 * audit_log — no DB mocks. The AuditLog.record() call inside checkReadScope /
 * checkReadScopeCommand is the write under test.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PolicyEngine, type ReadScopeContext } from '../../src/guardrails/PolicyEngine.js';
import { PolicySchema } from '../../src/types.js';
import { AuditLog } from '../../src/state/AuditLog.js';
import { createDatabase } from '../../src/state/Database.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rsa-${prefix}-`));
  try { return fs.realpathSync(dir); } catch { return dir; }
}

interface AuditRow {
  id: number;
  agent_id: string | null;
  action: string;
  command: string | null;
  allowed: number | null;
  policy_rule: string | null;
  detail: string | null;
}

function makeRealDb() {
  const db = createDatabase(':memory:');
  // FK off so arbitrary agentId strings can be used without seeding agents/epics.
  db.pragma('foreign_keys = OFF');
  const audit = new AuditLog(db);
  const denials = (): AuditRow[] =>
    db
      .prepare(
        "SELECT * FROM audit_log WHERE action = 'read_scope_denied' ORDER BY id ASC",
      )
      .all() as AuditRow[];
  return { audit, denials };
}

function makeEngine(): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({}));
}

// ── Suite 1: checkReadScope — real audit_log ──────────────────────────────────

describe('readScopeAudit — checkReadScope with real audit_log (story-067-004)', () => {
  let worktreeRoot: string;
  let readRoot: string;
  let outsideDir: string;

  before(() => {
    worktreeRoot = makeTmp('wt');
    readRoot = makeTmp('rr');
    outsideDir = makeTmp('out');
    fs.writeFileSync(path.join(worktreeRoot, 'in.ts'), '');
    fs.writeFileSync(path.join(readRoot, 'shared.ts'), '');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '');
  });

  after(() => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(readRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // AC1: blocked out-of-worktree Read writes one row with the required fields
  it('AC1 — blocked out-of-worktree Read writes one read_scope_denied row with required fields', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    const target = path.join(outsideDir, 'secret.txt');
    const result = engine.checkReadScope(target, ctx);

    assert.equal(result.allowed, false);
    const rows = denials();
    assert.equal(rows.length, 1, 'exactly one audit row on denial');

    const row = rows[0];
    assert.equal(row.action, 'read_scope_denied');
    assert.equal(row.allowed, 0);
    assert.equal(row.policy_rule, 'filesystem.allowed_read_root');

    assert.ok(row.detail, 'detail column must be set');
    const detail = JSON.parse(row.detail!);
    assert.ok('tool' in detail, 'detail.tool present');
    assert.ok('requestedPath' in detail, 'detail.requestedPath present');
    assert.ok('resolvedPath' in detail, 'detail.resolvedPath present');
    assert.ok('reason' in detail, 'detail.reason present');
    assert.ok('worktreeRoot' in detail, 'detail.worktreeRoot present');
    assert.ok('readRoot' in detail, 'detail.readRoot present');
    assert.equal(detail.requestedPath, target);
    assert.equal(detail.worktreeRoot, worktreeRoot);
    assert.equal(detail.readRoot, readRoot);
  });

  // AC3 (log-before-return): row is in audit_log the moment checkReadScope returns
  it('AC3 — log-before-return: row present in audit_log synchronously after checkReadScope returns', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    const target = path.join(outsideDir, 'secret.txt');
    const result = engine.checkReadScope(target, ctx);

    // Query synchronously right after return — satisfies Key Invariant #5.
    const rowCountAfterReturn = denials().length;

    assert.equal(result.allowed, false);
    assert.equal(
      rowCountAfterReturn,
      1,
      'row must be written before checkReadScope returns the denial',
    );
  });

  // AC4 (negative control): in-scope read writes NO read_scope_denied row
  it('AC4 — in-scope Read writes no read_scope_denied row (negative control)', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    // worktreeRoot-scoped path is allowed
    const resultWt = engine.checkReadScope(path.join(worktreeRoot, 'in.ts'), ctx);
    assert.equal(resultWt.allowed, true);

    // readRoot-scoped path is also allowed (regression guard: must not be blocked)
    const resultRr = engine.checkReadScope(path.join(readRoot, 'shared.ts'), ctx);
    assert.equal(resultRr.allowed, true);

    assert.equal(denials().length, 0, 'no audit row on allowed reads');
  });

  // AC5: agentId attribution — row carries ctx.agentId
  it('AC5 — agentId set on ctx: audit row agent_id matches', () => {
    const { audit, denials } = makeRealDb();
    const agentId = 'agent-story-067-004-deadbeef';
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit, agentId };
    const engine = makeEngine();

    engine.checkReadScope(path.join(outsideDir, 'secret.txt'), ctx);

    const rows = denials();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, agentId);
  });

  // Negative control for agentId: when agentId is unset, agent_id column is null
  it('no agentId on ctx: audit row agent_id is null', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    engine.checkReadScope(path.join(outsideDir, 'secret.txt'), ctx);

    const rows = denials();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, null);
  });
});

// ── Suite 2: checkReadScopeCommand — real audit_log ───────────────────────────

describe('readScopeAudit — checkReadScopeCommand with real audit_log (story-067-004)', () => {
  let worktreeRoot: string;
  let readRoot: string;
  let outsideDir: string;

  before(() => {
    worktreeRoot = makeTmp('cmd-wt');
    readRoot = makeTmp('cmd-rr');
    outsideDir = makeTmp('cmd-out');
    fs.writeFileSync(path.join(worktreeRoot, 'in.ts'), '');
    fs.writeFileSync(path.join(readRoot, 'shared.ts'), '');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), '');
  });

  after(() => {
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
    fs.rmSync(readRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  // AC2: blocked grep writes one row with required fields
  it('AC2 — blocked out-of-scope grep writes one read_scope_denied row with required fields', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    const outFile = path.join(outsideDir, 'secret.txt');
    const result = engine.checkReadScopeCommand(`grep pattern "${outFile}"`, ctx);

    assert.equal(result.allowed, false);
    const rows = denials();
    assert.equal(rows.length, 1, 'exactly one audit row on denial');

    const row = rows[0];
    assert.equal(row.action, 'read_scope_denied');
    assert.equal(row.allowed, 0);
    assert.equal(row.policy_rule, 'filesystem.allowed_read_root');
    assert.ok(row.command, 'command column must be populated');
    assert.ok(row.command!.includes(outFile), 'command column includes the target path');

    assert.ok(row.detail, 'detail column must be set');
    const detail = JSON.parse(row.detail!);
    assert.equal(detail.tool, 'grep');
    assert.equal(detail.requestedPath, outFile);
    assert.ok('resolvedPath' in detail, 'detail.resolvedPath present');
    assert.ok('reason' in detail, 'detail.reason present');
    assert.ok('worktreeRoot' in detail, 'detail.worktreeRoot present');
    assert.ok('readRoot' in detail, 'detail.readRoot present');
  });

  // AC2b: blocked rg writes one row
  it('AC2b — blocked out-of-scope rg writes one read_scope_denied row', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    const outFile = path.join(outsideDir, 'secret.txt');
    const result = engine.checkReadScopeCommand(`rg pattern "${outFile}"`, ctx);

    assert.equal(result.allowed, false);
    const rows = denials();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'read_scope_denied');
    assert.equal(rows[0].allowed, 0);
    assert.equal(rows[0].policy_rule, 'filesystem.allowed_read_root');
    assert.ok(rows[0].command, 'command column must be populated');
    assert.ok(rows[0].command!.includes(outFile), 'command column includes the target path');
    assert.ok(rows[0].detail, 'detail column must be set');
    const detail = JSON.parse(rows[0].detail!);
    assert.equal(detail.tool, 'rg');
    assert.equal(detail.requestedPath, outFile);
    assert.ok('resolvedPath' in detail, 'detail.resolvedPath present');
  });

  // AC3 (log-before-return): row present the moment checkReadScopeCommand returns
  it('AC3 — log-before-return: row present in audit_log synchronously after checkReadScopeCommand returns', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    // Use grep (verified to produce a denial in AC2) so this test isolates
    // the log-before-return timing invariant from command-recognition correctness.
    const outFile = path.join(outsideDir, 'secret.txt');
    const result = engine.checkReadScopeCommand(`grep pattern "${outFile}"`, ctx);
    const rowCountAfterReturn = denials().length;

    assert.equal(result.allowed, false);
    assert.equal(
      rowCountAfterReturn,
      1,
      'row must be written before checkReadScopeCommand returns the denial',
    );
  });

  // AC4 (negative control): in-scope search writes no row
  it('AC4 — in-scope search writes no read_scope_denied row (negative control)', () => {
    const { audit, denials } = makeRealDb();
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit };
    const engine = makeEngine();

    // worktreeRoot-scoped search is allowed
    const resultWt = engine.checkReadScopeCommand(
      `grep pattern "${path.join(worktreeRoot, 'in.ts')}"`,
      ctx,
    );
    assert.equal(resultWt.allowed, true);

    // readRoot-scoped search is also allowed (regression guard: must not be blocked)
    const resultRr = engine.checkReadScopeCommand(
      `grep pattern "${path.join(readRoot, 'shared.ts')}"`,
      ctx,
    );
    assert.equal(resultRr.allowed, true);

    assert.equal(denials().length, 0, 'no audit row on allowed searches');
  });

  // AC5: agentId attribution on search denial
  it('AC5 — agentId set on ctx: search denial audit row agent_id matches', () => {
    const { audit, denials } = makeRealDb();
    const agentId = 'agent-story-067-004-cafebabe';
    const ctx: ReadScopeContext = { worktreeRoot, readRoot, audit, agentId };
    const engine = makeEngine();

    engine.checkReadScopeCommand(`grep pattern "${path.join(outsideDir, 'secret.txt')}"`, ctx);

    const rows = denials();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, agentId);
  });
});
