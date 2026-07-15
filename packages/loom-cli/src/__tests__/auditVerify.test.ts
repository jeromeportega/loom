/**
 * Integration tests for `loom audit verify`.
 *
 * Covers:
 * - [AC1] Happy path: intact chain exits 0 with "Chain intact" message
 * - [AC2] Failure path: tampered row exits 1 with "Chain broken" error
 * - [AC3] --json: VerifyChainResult shape, ONLY JSON on stdout, exit codes
 * - [AC4] Help: verifySpec examples, not-initialized exit 1
 * - [AC5] Docs gate: verifySpec in collectSpecs(), name == "audit verify"
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { createDatabase, AuditLog, resetDatabaseForTest } from '@loom-ai/core';
import { runAuditVerify, verifySpec } from '../commands/audit.js';
import { applySpec } from '../describe/applySpec.js';
import { capture } from './testUtils.js';
import { collectSpecs } from '../describe/registry.js';

let repo: string;
let prevCwd: string;

beforeEach(() => {
  resetDatabaseForTest();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-verify-test-'));
  const loomDir = path.join(repo, '.loom');
  fs.mkdirSync(loomDir, { recursive: true });
  // Set loom_home inside the temp repo for test isolation
  fs.writeFileSync(
    path.join(loomDir, 'policy.yaml'),
    `version: 1\nloom_home: ${path.join(repo, '.loom-home')}\n`
  );
  prevCwd = process.cwd();
  process.chdir(repo);
});

afterEach(() => {
  resetDatabaseForTest();
  process.chdir(prevCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ─── [AC1] intact chain ───────────────────────────────────────────────────────

describe('loom audit verify — intact chain [AC1]', () => {
  it('exits 0 and prints "Chain intact" with hashed row count', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'test_action_1' });
    audit.record({ action: 'test_action_2' });
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo }));
    assert.strictEqual(result.exitCode, null, 'should not call process.exit on intact chain');
    const out = result.logs.join('\n');
    assert.ok(out.includes('Chain intact'), `expected "Chain intact" in output: ${out}`);
    assert.ok(out.includes('2'), `expected row count in output: ${out}`);
    assert.strictEqual(result.errors.length, 0, 'should not print errors');
  });

  it('exits 0 with 0 hashed rows when DB has only legacy (unhashed) entries', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.prepare("INSERT INTO audit_log (action) VALUES ('legacy_action')").run();
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo }));
    assert.strictEqual(result.exitCode, null, '0 hashed rows is still ok:true');
    const out = result.logs.join('\n');
    assert.ok(out.includes('0'), `expected "0" in output: ${out}`);
    assert.ok(out.includes('Chain intact'), `expected "Chain intact" in output: ${out}`);
  });

  it('exits 0 with empty DB (no rows)', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo }));
    assert.strictEqual(result.exitCode, null, 'empty DB is ok:true');
    assert.ok(result.logs.join('\n').includes('Chain intact'));
  });
});

// ─── [AC2] broken chain ───────────────────────────────────────────────────────

describe('loom audit verify — broken chain [AC2]', () => {
  it('exits 1 and prints "Chain broken" with the tampered row ID', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'legit_action_1' });
    audit.record({ action: 'legit_action_2' });

    const rows = db.prepare('SELECT id FROM audit_log ORDER BY id ASC').all() as { id: number }[];
    const firstId = rows[0].id;
    db.prepare("UPDATE audit_log SET action = 'tampered_action' WHERE id = ?").run(firstId);
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo }));
    assert.strictEqual(result.exitCode, 1, 'should exit 1 when chain is broken');
    const err = result.errors.join('\n');
    assert.ok(err.includes('Chain broken'), `expected "Chain broken" in stderr: ${err}`);
    assert.ok(err.includes(String(firstId)), `expected row ID ${firstId} in stderr: ${err}`);
  });
});

// ─── [AC3] --json output contract ────────────────────────────────────────────

describe('loom audit verify --json [AC3]', () => {
  it('emits VerifyChainResult JSON for intact chain and exits 0', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'json_test_action' });
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, null, 'intact chain should not call process.exit');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line');

    const payload = JSON.parse(result.logs[0]) as {
      ok: boolean;
      hashedRows: number;
      legacyRows: number;
      fromId: number | null;
      toId: number | null;
    };
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.hashedRows, 1);
    assert.strictEqual(payload.legacyRows, 0);
    assert.strictEqual(typeof payload.fromId, 'number');
    assert.strictEqual(typeof payload.toId, 'number');
  });

  it('emits VerifyChainResult JSON with ok:false and brokenAtId, exits 1', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'action_1' });
    audit.record({ action: 'action_2' });

    const rows = db.prepare('SELECT id FROM audit_log ORDER BY id ASC').all() as { id: number }[];
    const firstId = rows[0].id;
    db.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = ?").run(firstId);
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, 1, 'broken chain must exit 1 even with --json');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line');

    const payload = JSON.parse(result.logs[0]) as {
      ok: boolean;
      brokenAtId: number;
      reason: string;
    };
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.brokenAtId, firstId);
    assert.ok(typeof payload.reason === 'string' && payload.reason.length > 0);
  });

  it('--json stdout is ONLY parseable JSON (no extra text)', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'json_only_test' });
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.logs.length, 1, 'exactly one log line');
    assert.doesNotThrow(() => JSON.parse(result.logs[0]), 'the single log line must be valid JSON');
  });
});

// ─── [AC4] help and not-initialized ──────────────────────────────────────────

describe('loom audit verify — help and uninitialized [AC4]', () => {
  it('exits 1 with error when loom not initialized', async () => {
    fs.unlinkSync(path.join(repo, '.loom', 'policy.yaml'));
    const result = await capture(() => runAuditVerify({ projectRoot: repo }));
    assert.strictEqual(result.exitCode, 1, 'should exit 1 when not initialized');
    assert.ok(
      result.errors.some((e) => e.includes('loom init')),
      `expected init hint in errors: ${result.errors.join('\n')}`
    );
  });

  it('verifySpec has at least one example with "loom audit verify"', () => {
    assert.ok(verifySpec.examples.length >= 1, 'verifySpec must have at least one example');
    assert.ok(
      verifySpec.examples.some((e) => e.command.includes('loom audit verify')),
      'at least one example must reference "loom audit verify"'
    );
  });

  it('Commander helpInformation() contains --json flag and command description', () => {
    // Commander 12 helpInformation() returns core help (description + options).
    // addHelpText callbacks only fire via outputHelp() — check the spec examples separately.
    const auditCmd = new Command('audit');
    const verifyCmd = applySpec(auditCmd.command('verify'), verifySpec);
    const help = verifyCmd.helpInformation();
    assert.ok(help.includes('--json'), `help must include --json option: ${help}`);
    assert.ok(
      help.includes('Verify the tamper-evidence hash chain'),
      `help must include command description: ${help}`
    );
  });
});

// ─── [AC5] docs gate ─────────────────────────────────────────────────────────

describe('loom audit verify — docs gate [AC5]', () => {
  it('verifySpec.name is "audit verify"', () => {
    assert.strictEqual(verifySpec.name, 'audit verify');
  });

  it('verifySpec is registered in collectSpecs()', () => {
    const specs = collectSpecs();
    const found = specs.find((s) => s.name === 'audit verify');
    assert.ok(found, '"audit verify" must appear in collectSpecs()');
  });

  it('verifySpec --json option is present with changesOutputShape:true', () => {
    const jsonOpt = verifySpec.options.find((o) => o.name === '--json');
    assert.ok(jsonOpt, 'verifySpec must have a --json option');
    assert.strictEqual(jsonOpt.changesOutputShape, true);
  });

  it('verifySpec exitCodes include exit 0 (intact) and exit 1 (broken)', () => {
    const codes = verifySpec.exitCodes.map((ec) => ec.code);
    assert.ok(codes.includes(0), 'exitCodes must include 0 (intact)');
    assert.ok(codes.includes(1), 'exitCodes must include 1 (broken/not-init)');
  });
});
