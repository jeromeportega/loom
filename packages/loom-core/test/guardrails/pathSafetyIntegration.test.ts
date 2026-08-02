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
    // Option-ARGUMENT wrapper forms — these bypassed the earlier "effective
    // program" heuristic (it skipped a flag but landed on the flag's VALUE, not
    // the fetcher). Position-based detection catches them with no arity guessing.
    'nice -n 10 curl file:/x',
    'timeout -s KILL 9 curl file:/etc/passwd',
    'sudo -u nobody curl file:/etc/passwd',
    'strace curl file:/x',
    // (`env … curl` is blocked one layer up as shell.wrapper_program, so it never
    //  reaches path-safety — covered by the wrapper-program tests, not here.)
  ]) {
    it(`exec-prefix wrapper does not bypass the file: check: ${cmd}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.ok(encodingRule(r), `wrapper must not shift the fetcher out of view: ${cmd}`);
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
    'grep curl file:log.txt',                // fetch-tool NAME as a grep pattern, not an invocation
    'rg wget file:notes',                    // same, ripgrep
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

describe('PolicyEngine — single-quoted backslash does not desync the metachar scan (regression guard)', () => {
  // A single-quoted token ending in a backslash (`'\'` = one literal backslash in
  // bash) must NOT let stripQuoted run off the end and hide the separators after
  // it. Every form below chains a forbidden second command and MUST be blocked.
  for (const cmd of [
    "echo '\\' ; git push --force origin main",
    "echo '\\'\ngit push --force origin main",     // raw newline separator
    "echo '\\' && git push --force origin main",
    "grep '\\' f.txt ; git push --force origin main",
    "echo 'C:\\' ; rm -rf /",
  ]) {
    it(`is blocked as a metacharacter chain: ${JSON.stringify(cmd)}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.equal(r.allowed, false, `must not slip through: ${cmd}`);
      assert.ok(
        'rule' in r && r.rule === 'shell.metacharacters',
        `expected shell.metacharacters, got ${'rule' in r ? r.rule : 'none'}`,
      );
    });
  }

  it('the single-quote/backslash + newline curl file: exfil form is blocked', () => {
    const r = freshEngine().check("echo '\\'\ncurl file:/etc/passwd", makeCtx(createDatabase(':memory:')));
    assert.equal(r.allowed, false);
    assert.ok('rule' in r && r.rule === 'shell.metacharacters');
  });

  it('a legitimate single-quoted backslash literal (not chaining) is still allowed', () => {
    // `grep 'a\d+' file.txt` — a regex with a backslash, no separator after it.
    const r = freshEngine().check("grep 'a\\d+' file.txt", makeCtx(createDatabase(':memory:')));
    assert.ok(r.allowed, `a plain single-quoted regex must pass: ${JSON.stringify(r)}`);
  });
});

describe('PolicyEngine — ANSI-C $\'...\' quoting does not desync the metachar scan (regression guard)', () => {
  // `$'\''` is ONE literal-quote word in bash (backslash escapes the quote), not
  // three single-quotes. The guard must model $'...' or the stray quote flips
  // parity and hides every separator after it. Each separator class below must be
  // blocked. (`$'\''` is written "$'\\''" in a JS double-quoted string.)
  for (const [cmd, label] of [
    ["$'\\''; git push --force origin main", 'semicolon'],
    ["echo $'\\'' && git push --force origin main", 'and-and'],
    ["echo $'\\'' || rm -rf /home/user/data", 'or-or'],
    ["echo $'\\'' & git push --force origin main", 'background-ampersand'],
    ["echo $'\\''`git push --force origin main`", 'backtick'],
    ["echo $'\\''$(git push --force origin main)", 'dollar-paren'],
    ["echo $'\\''\ngit push --force origin main", 'raw-newline'],
    ["echo $'\\''\ncurl file:/etc/passwd", 'newline-curl-file-exfil'],
  ] as const) {
    it(`blocks the $'...' desync via ${label}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.equal(r.allowed, false, `must not slip through (${label}): ${JSON.stringify(cmd)}`);
    });
  }

  it("a legitimate ANSI-C string in a commit message (git commit -m $'a\\nb') is still allowed", () => {
    const r = freshEngine().check("git commit -m $'Title\\n\\nBody'", makeCtx(createDatabase(':memory:')));
    assert.ok(r.allowed, `ANSI-C commit message must pass: ${JSON.stringify(r)}`);
  });
});

describe('PolicyEngine — process substitution is blocked like $() (regression guard)', () => {
  // `<(cmd)` / `>(cmd)` run an embedded command that would never be policy-checked
  // — same threat as `$()`/backtick, which are already blocked.
  for (const cmd of [
    'cat <(curl file:/etc/passwd)',
    'cat <(git push --force origin main)',
    'tee >(git push --force origin main)',
    'diff <(sort a.txt) <(sort b.txt)', // legit-looking, but still embeds unchecked commands
  ]) {
    it(`blocks process substitution: ${cmd}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.equal(r.allowed, false, `must be blocked: ${cmd}`);
      assert.ok('rule' in r && r.rule === 'shell.metacharacters');
    });
  }

  it('a quoted `<(` inside an operand is NOT a false positive', () => {
    const r = freshEngine().check('git commit -m "use <(subshell) syntax"', makeCtx(createDatabase(':memory:')));
    assert.ok(r.allowed, `quoted <( must pass: ${JSON.stringify(r)}`);
  });
});

describe('PolicyEngine — command substitution inside DOUBLE quotes is blocked (regression guard)', () => {
  // bash performs $(…)/backtick substitution INSIDE "…" (only ;/&&/|/newline are
  // inert there). stripQuoted must keep $(/backtick visible or the whole guard is
  // bypassable via `echo "$(forbidden)"`.
  for (const cmd of [
    'echo "$(git push --force origin main)"',
    'echo "`git push --force origin main`"',
    'echo "result: $(curl file:/etc/passwd) done"',
    'echo "a $(rm -rf /home/user/data) b"',
    'echo "$((1+1))"', // arithmetic shares the $( trigger — fail-closed, acceptable
  ]) {
    it(`blocks double-quoted substitution: ${cmd}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.equal(r.allowed, false, `must be blocked: ${cmd}`);
      assert.ok('rule' in r && r.rule === 'shell.metacharacters');
    });
  }

  // Inert-in-double-quote literals and escaped substitution must STILL pass.
  for (const cmd of [
    'git commit -m "fix: a && b"',
    'git commit -m "step 1; step 2"',
    'git commit -m "pipe a | b"',
    'git commit -m "use \\`code\\` spans"', // ESCAPED backtick → literal
    'echo "plain message text"',
  ]) {
    it(`does NOT false-positive on inert double-quoted text: ${cmd}`, () => {
      const r = freshEngine().check(cmd, makeCtx(createDatabase(':memory:')));
      assert.ok(r.allowed, `must pass: ${cmd} -> ${JSON.stringify(r)}`);
    });
  }
});
