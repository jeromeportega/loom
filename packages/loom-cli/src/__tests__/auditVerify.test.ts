/**
 * Integration tests for `loom audit verify`.
 *
 * Covers:
 * - [AC1] Happy path: intact chain exits 0 with "Chain intact" message
 * - [AC2] Failure path: tampered row exits 1 with "Chain broken" error
 * - [AC3] --json: VerifyChainResult shape, ONLY JSON on stdout, exit codes
 * - [AC4] Help: verifySpec examples, not-initialized exit 1
 * - [AC5] Docs gate: verifySpec in collectSpecs(), name == "audit verify"
 * - [AC6] --json robustness: all four paths emit valid JSON, no process.exit
 * - [AC7] Help contains anchor-limit caveat
 * - [AC8] docs/capabilities.md: no unqualified tamper-proof/compliance/silently-altered; anchor caveat present
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
      help.includes('Verify audit log SHA-256 chain'),
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

// ─── [AC6] --json robustness: all four paths emit valid JSON ─────────────────

describe('loom audit verify --json robustness [AC6]', () => {
  it('--json not-initialized → parseable JSON with reason not-initialized, exit 1', async () => {
    fs.unlinkSync(path.join(repo, '.loom', 'policy.yaml'));
    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, 1, 'should set exitCode 1 when not initialized');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line on stdout');
    assert.strictEqual(result.errors.length, 0, 'no stderr output in --json mode');
    const payload = JSON.parse(result.logs[0]) as { ok: boolean; reason: string };
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, 'not-initialized');
  });

  it('--json internal error (corrupted DB file) → parseable JSON with reason error, exit 1', async () => {
    // Write a non-SQLite file where the DB would be found. better-sqlite3 will
    // throw immediately when it tries to open/parse the file.
    const dbPath = path.join(repo, '.loom', 'loom.db');
    fs.writeFileSync(dbPath, 'THIS IS NOT A VALID SQLITE FILE — CORRUPTED FOR TESTING');

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, 1, 'should set exitCode 1 on internal error');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line on stdout');
    assert.strictEqual(result.errors.length, 0, 'no stderr output in --json mode on error');
    const payload = JSON.parse(result.logs[0]) as { ok: boolean; reason: string; detail?: string };
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, 'error');
    assert.ok(typeof payload.detail === 'string' && payload.detail.length > 0, 'detail should describe the error');
  });

  it('--json ok → parseable JSON with ok:true and VerifyChainResult keys, exit 0', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'ac6_ok_test' });
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, null, 'ok chain should not set exit code');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line');
    const payload = JSON.parse(result.logs[0]) as {
      ok: boolean;
      hashedRows: number;
      legacyRows: number;
      fromId: number | null;
      toId: number | null;
    };
    assert.strictEqual(payload.ok, true);
    assert.ok('hashedRows' in payload, 'must have hashedRows (VerifyChainResult shape)');
    assert.ok('legacyRows' in payload, 'must have legacyRows');
    assert.ok('fromId' in payload, 'must have fromId');
    assert.ok('toId' in payload, 'must have toId');
    assert.ok(!('count' in payload), 'must NOT use the reinvented { ok, count } shape');
  });

  it('--json broken (tail truncation) → parseable JSON with ok:false reason count-mismatch, exit 1', async () => {
    const db = createDatabase(path.join(repo, '.loom', 'loom.db'));
    const audit = new AuditLog(db);
    audit.record({ action: 'chain_row_1' });
    audit.record({ action: 'chain_row_2' });

    // Simulate tail truncation: delete the last audit_log row but leave the
    // anchor's hashed_row_count at 2 — the walk produces 1, anchor says 2.
    const rows = db.prepare('SELECT id FROM audit_log ORDER BY id ASC').all() as { id: number }[];
    const lastId = rows[rows.length - 1].id;
    db.prepare('DELETE FROM audit_log WHERE id = ?').run(lastId);
    db.close();

    const result = await capture(() => runAuditVerify({ projectRoot: repo, json: true }));
    assert.strictEqual(result.exitCode, 1, 'broken chain must set exitCode 1');
    assert.strictEqual(result.logs.length, 1, 'exactly one JSON line');
    const payload = JSON.parse(result.logs[0]) as { ok: boolean; reason: string };
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.reason, 'count-mismatch', `expected count-mismatch, got: ${payload.reason}`);
  });

  it('audit.ts command file has no process.exit() calls', () => {
    // Resolve the source audit.ts relative to this compiled test file.
    // __dirname is dist/__tests__/; source is ../../src/commands/audit.ts
    const srcPath = path.resolve(__dirname, '../../src/commands/audit.ts');
    const content = fs.readFileSync(srcPath, 'utf8');
    const matches = content.match(/process\.exit\s*\(/g) ?? [];
    assert.strictEqual(
      matches.length,
      0,
      `audit.ts must not call process.exit() — found ${matches.length} match(es). Use process.exitCode instead.`
    );
  });
});

// ─── [AC7] help contains anchor-limit caveat ─────────────────────────────────

describe('loom audit verify — help anchor-limit caveat [AC7]', () => {
  it('verifySpec.whenToUse contains the anchor-limit caveat', () => {
    assert.ok(
      verifySpec.whenToUse.includes('audit_chain_head'),
      `verifySpec.whenToUse must mention audit_chain_head caveat: ${verifySpec.whenToUse}`
    );
    assert.ok(
      verifySpec.whenToUse.toLowerCase().includes('full db write access'),
      `verifySpec.whenToUse must mention full DB write access caveat: ${verifySpec.whenToUse}`
    );
  });

  it('Commander helpInformation() contains anchor-limit caveat wording', () => {
    // The caveat is included in verifySpec.summary which maps to cmd.description()
    // and therefore appears in helpInformation().
    const auditCmd = new Command('audit');
    const verifyCmd = applySpec(auditCmd.command('verify'), verifySpec);
    const help = verifyCmd.helpInformation();
    assert.ok(
      help.includes('audit_chain_head'),
      `help output must contain anchor-limit caveat (audit_chain_head): ${help}`
    );
  });
});

// ─── [AC8] docs/capabilities.md wording gate ─────────────────────────────────

describe('loom audit verify — docs/capabilities.md wording [AC8]', () => {
  // __dirname is dist/__tests__/ at runtime; capabilities.md is 4 levels up
  const capPath = path.resolve(__dirname, '../../../../docs/capabilities.md');

  it('no unqualified "tamper-proof" claim', () => {
    const capsMd = fs.readFileSync(capPath, 'utf8');
    // Allow "tamper-evidence" (still valid as a technical term for the mechanism),
    // but "tamper-proof" (the overclaim) must not appear.
    assert.ok(
      !capsMd.includes('tamper-proof'),
      'docs/capabilities.md must not contain unqualified "tamper-proof" claim'
    );
  });

  it('no "compliance" claim in the audit-verify row', () => {
    const capsMd = fs.readFileSync(capPath, 'utf8');
    const verifyRowMatch = capsMd.match(/\|\s*\*\*Audit chain integrity\*\*[^\n]+/);
    if (verifyRowMatch) {
      assert.ok(
        !verifyRowMatch[0].toLowerCase().includes('compliance'),
        `audit verify row must not mention "compliance": ${verifyRowMatch[0]}`
      );
    }
  });

  it('no unqualified "silently altered" claim in the audit-verify row', () => {
    const capsMd = fs.readFileSync(capPath, 'utf8');
    const verifyRowMatch = capsMd.match(/\|\s*\*\*Audit chain integrity\*\*[^\n]+/);
    if (verifyRowMatch) {
      assert.ok(
        !verifyRowMatch[0].includes('silently altered'),
        `audit verify row must not contain unqualified "silently altered": ${verifyRowMatch[0]}`
      );
    }
  });

  it('anchor-limit caveat is present in the audit-verify row', () => {
    const capsMd = fs.readFileSync(capPath, 'utf8');
    const verifyRowMatch = capsMd.match(/\|\s*\*\*Audit chain integrity\*\*[^\n]+/);
    assert.ok(verifyRowMatch, 'audit chain integrity row must exist in capabilities.md');
    assert.ok(
      verifyRowMatch![0].includes('audit_chain_head'),
      `audit verify row must contain the anchor-limit caveat mentioning audit_chain_head: ${verifyRowMatch![0]}`
    );
  });
});
