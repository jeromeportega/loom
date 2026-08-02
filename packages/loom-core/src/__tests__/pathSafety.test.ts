import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkPathSafety } from '../guardrails/pathSafety.js';

// ─── null-byte rule ──────────────────────────────────────────────────────────

describe('checkPathSafety — null-byte rule', () => {
  it('rejects token containing \\x00', () => {
    const r = checkPathSafety('foo\x00bar');
    assert.equal(r.safe, false);
    if (!r.safe) {
      assert.equal(r.rule, 'null-byte');
      assert.ok(r.reason.length > 0, 'reason must be a non-empty string');
    }
  });
});

// ─── control-char rule ───────────────────────────────────────────────────────

describe('checkPathSafety — control-char rule', () => {
  it('rejects token with \\x01 at start (not null byte)', () => {
    const r = checkPathSafety('\x01abc');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'control-char');
  });

  it('rejects token with \\x1f at end (not null byte)', () => {
    const r = checkPathSafety('abc\x1f');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'control-char');
  });

  it('rejects token with DEL \\x7f (not null byte)', () => {
    const r = checkPathSafety('abc\x7f');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'control-char');
  });
});

// ─── encoded-dot rule ────────────────────────────────────────────────────────

describe('checkPathSafety — encoded-dot rule', () => {
  it('rejects %2e%2e/secret (lowercase)', () => {
    const r = checkPathSafety('%2e%2e/secret');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-dot');
  });

  it('rejects %2E%2E/secret (uppercase, case-insensitive)', () => {
    const r = checkPathSafety('%2E%2E/secret');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-dot');
  });

  it('rejects %252e%252e/secret (double-encoded)', () => {
    const r = checkPathSafety('%252e%252e/secret');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-dot');
  });
});

// ─── encoded-sep rule ────────────────────────────────────────────────────────

describe('checkPathSafety — encoded-sep rule', () => {
  it('rejects ..%2fsecret (encoded forward slash, lowercase)', () => {
    const r = checkPathSafety('..%2fsecret');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });

  it('rejects ..%5csecret (encoded backslash, lowercase)', () => {
    const r = checkPathSafety('..%5csecret');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });

  it('rejects %2F (uppercase forward slash)', () => {
    const r = checkPathSafety('%2F');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });

  it('rejects %5C (uppercase backslash)', () => {
    const r = checkPathSafety('%5C');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });

  it('rejects %252f (double-encoded forward slash)', () => {
    const r = checkPathSafety('%252f');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });

  it('rejects %255c (double-encoded backslash)', () => {
    const r = checkPathSafety('%255c');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-sep');
  });
});

// ─── encoded-null rule ───────────────────────────────────────────────────────

describe('checkPathSafety — encoded-null rule', () => {
  it('rejects %00 (percent-encoded null)', () => {
    const r = checkPathSafety('%00');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-null');
  });

  it('rejects %2500 (double-encoded null)', () => {
    const r = checkPathSafety('%2500');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-null');
  });

  it('rejects %00 with suffix', () => {
    const r = checkPathSafety('%00suffix');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-null');
  });
});

// ─── url-scheme rule ─────────────────────────────────────────────────────────

describe('checkPathSafety — url-scheme rule', () => {
  it('rejects file:///etc/passwd', () => {
    const r = checkPathSafety('file:///etc/passwd');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'url-scheme');
  });

  it('rejects http://evil.com/path', () => {
    const r = checkPathSafety('http://evil.com/path');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'url-scheme');
  });

  it('rejects https://x.com', () => {
    const r = checkPathSafety('https://x.com');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'url-scheme');
  });

  it('allows foo/bar (starts with f but is not a URI scheme)', () => {
    const r = checkPathSafety('foo/bar');
    assert.equal(r.safe, true);
  });
});

// ─── safe set ────────────────────────────────────────────────────────────────

describe('checkPathSafety — safe set (false-positive guard)', () => {
  const safeTokens = [
    'src/foo.ts',
    './a/b',
    '../within/ok',
    '..',
    'a.b.c',
    'filename.txt',
    'dir/sub/',
  ];

  for (const token of safeTokens) {
    it(`allows: ${JSON.stringify(token)}`, () => {
      const r = checkPathSafety(token);
      assert.equal(r.safe, true, `expected safe=true for token ${JSON.stringify(token)}`);
    });
  }
});

// ─── four demonstrated-gap tokens ────────────────────────────────────────────

describe('checkPathSafety — demonstrated-gap tokens', () => {
  it('rejects %2e%2e%2fsecret', () => {
    const r = checkPathSafety('%2e%2e%2fsecret');
    assert.equal(r.safe, false);
  });

  it('rejects ..%2fsecret', () => {
    const r = checkPathSafety('..%2fsecret');
    assert.equal(r.safe, false);
  });

  it('rejects file:///etc/passwd', () => {
    const r = checkPathSafety('file:///etc/passwd');
    assert.equal(r.safe, false);
  });

  it('rejects foo\\x00bar (null-byte variant)', () => {
    const r = checkPathSafety('foo\x00bar');
    assert.equal(r.safe, false);
  });
});

// ─── rule ordering (first-match-wins) ────────────────────────────────────────

describe('checkPathSafety — rule ordering', () => {
  it('token with \\x00 AND %2e returns rule: null-byte (first-match-wins)', () => {
    const r = checkPathSafety('foo\x00%2e');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'null-byte');
  });

  it('token with %2e AND %2f returns rule: encoded-dot (encoded-dot fires before encoded-sep)', () => {
    const r = checkPathSafety('%2e%2f');
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'encoded-dot');
  });
});

// ─── static module guard ─────────────────────────────────────────────────────

describe('checkPathSafety — static module guard', () => {
  it('compiled pathSafety.js contains no fs require and no path.resolve', () => {
    // At runtime __dirname is dist/__tests__/; the compiled module is one level up
    const compiled = path.join(__dirname, '..', 'guardrails', 'pathSafety.js');
    const src = fs.readFileSync(compiled, 'utf8');
    assert.ok(!/require.*['"].*fs['"]/.test(src), 'must not require fs');
    assert.ok(!/path\.resolve/.test(src), 'must not call path.resolve');
  });
});
