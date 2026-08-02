/**
 * Integration tests for the adversarial-encoding path guard wired into
 * PolicyEngine.check() (story-098-002).
 *
 * Uses a real AuditLog over an in-memory SQLite database so both the return
 * value and the persisted audit row are exercised in every relevant case.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { AuditLog } from '../../src/state/AuditLog.js';
import { PolicyEngine, type WorktreeContext } from '../../src/guardrails/PolicyEngine.js';
import { PolicySchema } from '../../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshEngine(): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({}));
}

type AuditRow = {
  id: number;
  action: string;
  command: string | null;
  allowed: number | null;
  policy_rule: string | null;
  detail: string | null;
};

function queryAuditRows(db: Database.Database, action: string): AuditRow[] {
  return db
    .prepare('SELECT id, action, command, allowed, policy_rule, detail FROM audit_log WHERE action = ?')
    .all(action) as AuditRow[];
}

function makeCtx(db: Database.Database): WorktreeContext {
  return {
    worktreeRoot: '/tmp/own',
    loomHome: '/tmp/loomhome',
    audit: new AuditLog(db),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PolicyEngine — encoding guard integration (story-098-002)', () => {
  let db: Database.Database;

  before(() => {
    db = createDatabase(':memory:');
  });

  it('percent-encoded dot-traversal is denied with rule path.unsafe_encoding', () => {
    const engine = freshEngine();
    const r = engine.check('cat %2e%2e%2fsecret', makeCtx(db));
    assert.equal(r.allowed, false, 'must be denied');
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding', `unexpected rule: ${'rule' in r ? r.rule : 'none'}`);
    assert.ok('reason' in r && typeof r.reason === 'string' && r.reason.length > 0, 'reason must be non-empty string');
  });

  it('encoded-separator variant is denied', () => {
    const engine = freshEngine();
    const r = engine.check('cat ..%2fsecret', makeCtx(db));
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding');
  });

  it('file-URI scheme is denied', () => {
    const engine = freshEngine();
    const r = engine.check('cat file:///etc/passwd', makeCtx(db));
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding');
  });

  it('null-byte variant is denied', () => {
    const engine = freshEngine();
    const r = engine.check('cat foo\x00bar', makeCtx(db));
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding');
  });

  it('audit row is written with correct fields on denial', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    const rawCmd = 'cat %2e%2e%2fsecret';
    engine.check(rawCmd, ctx);

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1, 'exactly one guard_blocked row must be written');
    const row = rows[0];
    assert.equal(row.action, 'guard_blocked');
    assert.equal(row.policy_rule, 'path.unsafe_encoding');
    assert.equal(row.allowed, 0, 'allowed must be 0 (false)');
    assert.equal(row.command, rawCmd);

    const detail = JSON.parse(row.detail ?? '{}');
    assert.equal(detail.token, '%2e%2e%2fsecret', 'detail.token must be the offending token');
    assert.equal(detail.rule, 'encoded-dot', 'detail.rule must match checkPathSafety rule');
  });

  it('audit row NOT written when ctx is omitted — guard still denies', () => {
    const engine = freshEngine();

    // No ctx — denial must still fire without crashing (the `?.` guard in
    // PolicyEngine prevents a TypeError on undefined ctx.audit.record).
    const r = engine.check('cat %2e%2e/secret');
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding');
  });

  it('tokens after -- end-of-options marker are checked even when starting with -', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    // `-%2e%2e%2fsecret` starts with `-` but appears after `--`, so it is a
    // positional argument — the encoding guard must not skip it.
    const r = engine.check('cat -- -%2e%2e%2fsecret', ctx);
    assert.equal(r.allowed, false, 'post-separator token must be denied');
    assert.ok(
      'rule' in r && r.rule === 'path.unsafe_encoding',
      `expected path.unsafe_encoding, got: ${'rule' in r ? r.rule : 'none'}`,
    );

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1, 'one audit row must be written for the post-separator token');
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, '-%2e%2e%2fsecret');
  });

  it('flags are not inspected — --stat token does not cause denial', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    // --stat is a flag (starts with -); src/foo.ts is safe
    const r = engine.check('git diff --stat src/foo.ts', ctx);
    // Must not be a path.unsafe_encoding denial
    if (!r.allowed) {
      assert.ok(
        !('rule' in r) || r.rule !== 'path.unsafe_encoding',
        `--stat flag must not trigger encoding guard, got rule: ${'rule' in r ? r.rule : 'none'}`,
      );
    }
    const rows = queryAuditRows(localDb, 'guard_blocked');
    const encodingRows = rows.filter(row => row.policy_rule === 'path.unsafe_encoding');
    assert.equal(encodingRows.length, 0, 'no encoding guard rows must be written for safe flags');
  });

  it('first-match-wins: two bad tokens produce exactly one audit row', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    // Two adversarial tokens — only the first should be recorded
    engine.check('cat %2e%2e%2fsecret file:///etc/passwd', ctx);

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1, 'exactly one audit row for the first bad token');
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, '%2e%2e%2fsecret', 'row must be for the first token');
  });

  it('safe path command passes encoding guard (passes through to subsequent checks)', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    // src/main.ts is safe — encoding guard must not short-circuit it
    const r = engine.check('cat src/main.ts', ctx);
    // Whatever downstream produces, it must NOT be path.unsafe_encoding
    if (!r.allowed) {
      assert.ok(
        !('rule' in r) || r.rule !== 'path.unsafe_encoding',
        `safe path must not be denied by encoding guard, got rule: ${'rule' in r ? r.rule : 'none'}`,
      );
    }
    const rows = queryAuditRows(localDb, 'guard_blocked');
    const encodingRows = rows.filter(row => row.policy_rule === 'path.unsafe_encoding');
    assert.equal(encodingRows.length, 0, 'encoding guard must not produce rows for safe paths');
  });

  it('encoding guard fires regardless of policy.yaml knobs', () => {
    // Construct engine with cross_repo_enabled false and other knobs
    const policy = PolicySchema.parse({ cross_repo: { enabled: false } });
    const engine = new PolicyEngine(policy);
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);

    const r = engine.check('cat %2e%2e%2fsecret', ctx);
    assert.equal(r.allowed, false, 'encoding guard must fire regardless of policy knobs');
    assert.ok('rule' in r && r.rule === 'path.unsafe_encoding');
  });

  it('encoded-separator token audit row detail contains correct token and rule', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    engine.check('cat ..%2fsecret', ctx);

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, '..%2fsecret');
    assert.equal(detail.rule, 'encoded-sep');
  });

  it('file-URI scheme audit row detail contains correct token and rule', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    engine.check('cat file:///etc/passwd', ctx);

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, 'file:///etc/passwd');
    assert.equal(detail.rule, 'url-scheme');
  });

  it('null-byte token audit row detail contains correct token and rule', () => {
    const localDb = createDatabase(':memory:');
    const ctx = makeCtx(localDb);
    const engine = freshEngine();

    engine.check('cat foo\x00bar', ctx);

    const rows = queryAuditRows(localDb, 'guard_blocked');
    assert.equal(rows.length, 1);
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, 'foo\x00bar');
    assert.equal(detail.rule, 'null-byte');
  });
});
