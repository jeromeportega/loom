import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPathSafety } from '../guardrails/pathSafety.js';

// checkPathSafety guards the RAW SHELL surface, so it targets only null bytes,
// control chars, and file: URIs — the classes dangerous at that layer. Percent
// encodings are deliberately NOT checked (shell tools take args literally; see
// pathSafety.ts) — the safe-set below proves they now pass.

// ─── null-byte rule ──────────────────────────────────────────────────────────

describe('checkPathSafety — null-byte rule', () => {
  it('rejects a token containing \\x00', () => {
    const r = checkPathSafety('foo\x00bar');
    assert.equal(r.safe, false);
    if (!r.safe) {
      assert.equal(r.rule, 'null-byte');
      assert.ok(r.reason.length > 0);
    }
  });
});

// ─── control-char rule ───────────────────────────────────────────────────────

describe('checkPathSafety — control-char rule', () => {
  for (const [name, tok] of [['C0 start', '\x01abc'], ['C0 mid', 'abc\x1fdef'], ['DEL', 'abc\x7f']] as const) {
    it(`rejects a token with a ${name} control character`, () => {
      const r = checkPathSafety(tok);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'control-char');
    });
  }
});

// ─── file-scheme rule (all forms — the epic-098 re-gate exploit) ────────────────

describe('checkPathSafety — file-scheme rule', () => {
  // The original `://`-only rule missed `file:/` (single slash), which curl
  // normalizes to `file:///` and reads. ALL forms must be rejected.
  for (const tok of [
    'file:///etc/passwd',   // authority form
    'file:/etc/passwd',     // single-slash (RFC-8089) — the bypass
    'file:etc/passwd',      // opaque form
    'FILE:/etc/passwd',     // case-insensitive
    'file:/Users/v/.ssh/id_rsa',
    ' file:/etc/passwd',    // leading whitespace (quoted arg) must not slip the anchor
  ]) {
    it(`rejects ${JSON.stringify(tok)}`, () => {
      const r = checkPathSafety(tok);
      assert.equal(r.safe, false, `${tok} must be rejected`);
      if (!r.safe) assert.equal(r.rule, 'file-scheme');
    });
  }
});

// ─── rule ordering (first-match-wins) ──────────────────────────────────────────

describe('checkPathSafety — rule ordering', () => {
  it('null-byte precedes control-char', () => {
    const r = checkPathSafety('a\x00\x01b');
    if (!r.safe) assert.equal(r.rule, 'null-byte');
  });
  it('control-char precedes file-scheme (a control byte in a file: token → control-char)', () => {
    const r = checkPathSafety('file:\x01/etc');
    if (!r.safe) assert.equal(r.rule, 'control-char');
  });
});

// ─── safe set — NO false positives ─────────────────────────────────────────────

describe('checkPathSafety — safe set (no false positives)', () => {
  const SAFE = [
    // plain paths
    'src/foo.ts', './a/b', '../within/ok', '..', 'a.b.c', 'filename.txt', 'dir/sub/',
    // remote URL operands — benign, must pass (not file:)
    'https://github.com/o/r', 'ssh://git@host/x', 'git://host/x.git',
    // percent-encodings are NO LONGER flagged (deliberate re-scope): these are
    // literal to the shell and were false positives before.
    '%2e%2e/secret', '..%2fsecret', 'report%2e2024.txt', 'a%20b', '100%.md', 'x=%2F%2Fy',
    // "file" as a substring, not a scheme
    'my-file.txt', 'profile://not-a-scheme-prefix'.replace('profile', 'notfile'),
    'the file:// docs', // does not START with file:
  ];
  for (const tok of SAFE) {
    it(`allows ${JSON.stringify(tok)}`, () => {
      assert.equal(checkPathSafety(tok).safe, true, `${tok} must be safe`);
    });
  }
});

// ─── documented gaps (out of scope by design — see pathSafety.ts) ──────────────
// These are NOT blocked and that is a deliberate threat-model decision: percent /
// unicode / overlong traversal only matters where a path is DECODED+RESOLVED
// (the read-scope/cross-repo resolveArg layer handles real `../`), not at this raw
// shell-token layer. Asserting they are `safe:true` makes the boundary explicit —
// if a future change wants to defend one, it flips a documented line.
describe('checkPathSafety — documented out-of-scope gaps', () => {
  for (const tok of ['%25252f', '..\\..\\secret', '%c0%ae%c0%afsecret', '．．／secret']) {
    it(`does not block ${JSON.stringify(tok)} (resolution-layer concern, by design)`, () => {
      assert.equal(checkPathSafety(tok).safe, true);
    });
  }
});

// ─── module purity ─────────────────────────────────────────────────────────────

describe('checkPathSafety — pure module', () => {
  it('compiled module requires no fs and calls no path.resolve', () => {
    // Read the COMPILED artifact next to this test in dist/ — the thing that
    // actually runs. A pure module has zero requires and no fs/path resolution.
    const compiled = fs.readFileSync(
      path.resolve(__dirname, '../guardrails/pathSafety.js'),
      'utf8'
    );
    assert.ok(!/require\(['"](node:)?fs['"]\)/.test(compiled), 'must not require fs');
    assert.ok(!/\.resolve\(/.test(compiled), 'must not call path.resolve');
  });
});
