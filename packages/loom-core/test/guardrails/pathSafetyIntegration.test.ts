/**
 * Integration tests for the re-scoped path-safety guard wired into
 * PolicyEngine.check().
 *
 * Uses a real AuditLog over an in-memory SQLite database so both the return
 * value and the persisted audit row are exercised. After the epic-098 re-gate the
 * guard rejects only null bytes, control chars, and file: URIs — percent encodings
 * are deliberately allowed (shell tools take them literally); the DENY cases below
 * cover the real threats and the ALLOW cases pin the false-positive fixes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createDatabase } from '../../src/state/Database.js';
import { AuditLog } from '../../src/state/AuditLog.js';
import { PolicyEngine, type WorktreeContext } from '../../src/guardrails/PolicyEngine.js';
import { PolicySchema } from '../../src/types.js';

function freshEngine(): PolicyEngine {
  return new PolicyEngine(PolicySchema.parse({}));
}

type AuditRow = { action: string; command: string | null; allowed: number | null; policy_rule: string | null; detail: string | null };

function guardRows(db: Database.Database): AuditRow[] {
  return db
    .prepare("SELECT action, command, allowed, policy_rule, detail FROM audit_log WHERE action = 'guard_blocked'")
    .all() as AuditRow[];
}

function makeCtx(db: Database.Database): WorktreeContext {
  return { worktreeRoot: '/tmp/own', loomHome: '/tmp/loomhome', audit: new AuditLog(db) };
}

function encodingRule(r: ReturnType<PolicyEngine['check']>): boolean {
  return !r.allowed && 'rule' in r && r.rule === 'path.unsafe_token';
}

describe('PolicyEngine — path-safety guard: DENIALS', () => {
  it('file:/// (authority form) is denied', () => {
    const r = freshEngine().check('curl file:///etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r));
  });

  it('file:/ (single-slash) — the demonstrated curl bypass — is denied', () => {
    const r = freshEngine().check('curl file:/etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r), 'file:/ must be denied (curl normalizes it to file:/// and reads the file)');
  });

  it('opaque file: form is denied', () => {
    const r = freshEngine().check('wget file:etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r));
  });

  it('full-path fetch invocation (/usr/bin/curl file:/x) is denied — basename match', () => {
    const r = freshEngine().check('/usr/bin/curl file:/etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r), 'a full-path curl must not bypass the file: check');
  });

  for (const cmd of [
    'nice curl file:/etc/passwd',
    'timeout 9 curl file:/etc/passwd',
    'command curl file:/x',
    'busybox wget file:/x',
  ]) {
    it(`exec-prefix wrapper does not bypass the file: check: ${cmd}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.ok(encodingRule(r), `wrapper must not shift argv[0] off the fetcher: ${cmd}`);
    });
  }

  it('null-byte token is denied', () => {
    const r = freshEngine().check('cat foo\x00bar', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r));
  });

  it('control-char token is denied', () => {
    const r = freshEngine().check('cat foo\x01bar', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r));
  });

  it('denial is structural — fires with cross_repo disabled and no ctx', () => {
    const engine = new PolicyEngine(PolicySchema.parse({ cross_repo: { enabled: false } }));
    assert.ok(encodingRule(engine.check('curl file:/etc/passwd')));           // no ctx
    assert.ok(encodingRule(engine.check('curl file:/etc/passwd', makeCtx(createDatabase(':memory:')))));
  });

  it('post-`--` token starting with `-` is still checked', () => {
    const r = freshEngine().check('curl -- file:/etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.ok(encodingRule(r));
  });
});

describe('PolicyEngine — path-safety guard: AUDIT', () => {
  it('writes one guard_blocked row with token + rule on a file: denial', () => {
    const db = createDatabase(':memory:');
    freshEngine().check('curl file:/etc/passwd', makeCtx(db));
    const rows = guardRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].policy_rule, 'path.unsafe_token');
    assert.equal(rows[0].allowed, 0);
    assert.equal(rows[0].command, 'curl file:/etc/passwd');
    const detail = JSON.parse(rows[0].detail ?? '{}');
    assert.equal(detail.token, 'file:/etc/passwd');
    assert.equal(detail.rule, 'file-scheme');
  });

  it('null-byte denial records rule null-byte', () => {
    const db = createDatabase(':memory:');
    freshEngine().check('cat foo\x00bar', makeCtx(db));
    const detail = JSON.parse(guardRows(db)[0].detail ?? '{}');
    assert.equal(detail.rule, 'null-byte');
  });

  it('first-match-wins: two bad tokens produce exactly one row', () => {
    const db = createDatabase(':memory:');
    freshEngine().check('curl file:/a file:/b', makeCtx(db));
    assert.equal(guardRows(db).length, 1);
  });

  it('no audit row (no crash) when ctx is omitted, but guard still denies', () => {
    const r = freshEngine().check('curl file:/etc/passwd');
    assert.ok(encodingRule(r));
  });
});

describe('PolicyEngine — path-safety guard: NO FALSE POSITIVES (the re-scope fixes)', () => {
  // These were all wrongly DENIED before the re-scope. They must pass the
  // path-safety guard now (they may still be denied by an unrelated rule, but
  // never with path.unsafe_token).
  const ALLOWED = [
    'grep %2e src/pathSafety.ts',          // grep pattern with %2e
    "grep file:// src",                     // grep pattern that looks like a scheme
    'gh api repos/o/r/contents/dir%2Ffile', // GitHub requires %2F
    'git commit -m "handle %2f and file:// tokens"', // commit message
    'cat report%2e2024.txt',                // real filename with %
    'git clone https://github.com/o/r',     // remote URL operand
    'curl https://api.example.com/x',       // remote URL operand
    'cat src/main.ts',                      // plain path
    'sed s/%2e/x/ file.txt',                // sed pattern with %2e
    'git commit -m "Title\n\nBody line"',   // MAJOR-1: multi-line commit message (newline)
    'git commit -m "file:// is the scheme"', // MAJOR-2: file: message on a non-fetch tool
    'cat file:notes.txt',                    // MAJOR-2: literal file: filename on a non-fetch tool
    'echo "a\tb tabbed"',                    // tab in a quoted operand
  ];
  for (const cmd of ALLOWED) {
    it(`does NOT path-safety-deny: ${cmd}`, () => {
      const db = createDatabase(':memory:');
      const r = freshEngine().check(cmd, makeCtx(db));
      assert.ok(!encodingRule(r), `must not be a path.unsafe_token denial: ${cmd}`);
      assert.equal(
        guardRows(db).filter(row => row.policy_rule === 'path.unsafe_token').length,
        0,
        `no path.unsafe_token audit row for: ${cmd}`,
      );
    });
  }
});

describe('PolicyEngine — unquoted newline is command chaining (regression guard)', () => {
  it('an unquoted newline chains a second command and is blocked as shell.metacharacters', () => {
    const r = freshEngine().check('echo x\ncurl file:/etc/passwd', makeCtx(createDatabase(':memory:')));
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'shell.metacharacters', `expected shell.metacharacters, got ${'rule' in r ? r.rule : 'none'}`);
  });

  it('a QUOTED newline (multi-line commit message) is NOT blocked as a metacharacter', () => {
    const r = freshEngine().check('git commit -m "line1\nline2"', makeCtx(createDatabase(':memory:')));
    // git commit -m is allowed by checkGit; the quoted newline is stripped before the metachar check.
    assert.ok(r.allowed || !('rule' in r) || r.rule !== 'shell.metacharacters');
  });
});
