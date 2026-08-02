import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPathSafety } from '../guardrails/pathSafety.js';

// ─── encoding constants ───────────────────────────────────────────────────────

// Percent-encoded dot forms (lowercase, uppercase, double-encoded)
const DOT_ENCS = ['%2e', '%2E', '%252e', '%252E'];

// Percent-encoded separator forms — forward slash and backslash, single and double-encoded
const SEP_ENCS = ['%2f', '%2F', '%252f', '%252F', '%5c', '%5C', '%255c', '%255C'];

// URL schemes for scheme-prepend mutations
const SCHEMES = ['file://', 'http://', 'https://', 'ftp://', 'data://', 'sftp://'];

// Suffixes appended to encoded prefixes to form complete path-traversal tokens.
// These are plain strings with no encodings of their own.
const SUFFIXES = [
  'secret', 'config', 'passwd', 'id_rsa', 'env',
  '.env', 'credentials', 'tokens', 'key.pem', 'private',
  'shadow', 'hosts', 'a/b', 'path/to/file', 'data',
];

// Contexts for null-byte injection — plain strings injected into to exercise
// \x00 at every token offset, and %00/%2500 prefix/suffix forms
const NULL_CONTEXTS = [
  'secret', 'config', 'passwd', 'data', 'token',
  'filename.txt', 'path', 'resource', 'key', 'value',
];

// ─── safe set ────────────────────────────────────────────────────────────────

// checkPathSafety is scoped to *encoded* traversal bypasses only — literal `..`
// and `../within/ok` are intentionally safe here.  Any future extension to block
// literal path-traversal should move these entries to a separate denied corpus
// rather than removing them, so the design contract remains explicit.
const SAFE_SET = [
  'src/foo.ts',
  './a/b',
  '../within/ok',  // literal slash — not an encoded separator
  '..',            // bare double-dot — no encoding, not in scope for this guard
  'a.b.c',
  'filename.txt',
] as const;

// ─── mutation generation (index-driven, no Math.random()) ────────────────────

function generateMutations(): string[] {
  const mutations: string[] = [];

  // Class 1 — encoded-dot mutations (4 × 4 × 15 × 9 = 2,160)
  //
  // Cross-product of two encoded-dot forms × every suffix, first with a literal
  // slash separator, then with each of the eight encoded-separator forms.
  // Every resulting token contains at least one %2e/%2E/%252e/%252E and therefore
  // fires the encoded-dot rule (first match wins).
  for (const d1 of DOT_ENCS) {
    for (const d2 of DOT_ENCS) {
      for (const s of SUFFIXES) {
        mutations.push(`${d1}${d2}/${s}`);          // literal slash
        for (const sep of SEP_ENCS) {
          mutations.push(`${d1}${d2}${sep}${s}`);   // encoded separator
        }
      }
    }
  }

  // Class 2 — encoded-separator only, depths 1–5 (8 × 15 × 5 = 600)
  //
  // Tokens of the form ..%2f..%2f..%2fsecret — literal dots with encoded
  // separators. No encoded dot, so the encoded-sep rule fires.
  for (const sep of SEP_ENCS) {
    for (const s of SUFFIXES) {
      for (let depth = 1; depth <= 5; depth++) {
        let token = '';
        for (let d = 0; d < depth; d++) token += `..${sep}`;
        mutations.push(token + s);
      }
    }
  }

  // Class 3 — URL-scheme prepend (6 × 15 = 90)
  for (const scheme of SCHEMES) {
    for (const s of SUFFIXES) {
      mutations.push(`${scheme}${s}`);
    }
  }

  // Class 4 — null-byte injection at every character offset + encoded-null forms
  //
  // For each context string of length L we push L+1 mutations with a literal
  // \x00 (covers position 0, every mid-token position, and end-of-token), plus
  // prefix/suffix variants of %00 and %2500.  This keeps the generation
  // deterministic: the offset is the loop index, not a random number.
  for (const ctx of NULL_CONTEXTS) {
    for (let pos = 0; pos <= ctx.length; pos++) {
      mutations.push(`${ctx.slice(0, pos)}\x00${ctx.slice(pos)}`);
    }
    mutations.push(`%00${ctx}`, `${ctx}%00`, `%2500${ctx}`, `${ctx}%2500`);
  }

  return mutations;
}

// Build the corpus once at module load so all describe/it blocks share the same array.
const MUTATION_FLOOR = 2_000;
const mutations = generateMutations();

// ─── floor assertion ─────────────────────────────────────────────────────────

describe('pathSafetyFuzz — mutation floor', () => {
  it(`corpus contains at least ${MUTATION_FLOOR} mutations`, () => {
    assert.ok(
      mutations.length >= MUTATION_FLOOR,
      `expected >= ${MUTATION_FLOOR} mutations, got ${mutations.length}`,
    );
  });
});

// ─── main corpus assertion ────────────────────────────────────────────────────

describe('pathSafetyFuzz — every encoded-attack mutation is rejected', () => {
  it('all mutations return { safe: false }', () => {
    for (let i = 0; i < mutations.length; i++) {
      const token = mutations[i];
      const r = checkPathSafety(token);
      assert.equal(
        r.safe,
        false,
        `mutation[${i}] expected safe=false: ${JSON.stringify(token.slice(0, 60))}`,
      );
    }
  });
});

// ─── encoding-coverage sub-assertions ────────────────────────────────────────
// These targeted checks verify that specific hex-case and double-encoded forms
// are present in the corpus AND are individually rejected, without relying solely
// on the main loop sweep above.

describe('pathSafetyFuzz — encoded-dot case coverage', () => {
  it('corpus includes %2e (lowercase) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%2e'));
    assert.ok(slice.length > 0, 'no %2e variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false, `%2e token passed: ${JSON.stringify(t)}`);
    }
  });

  it('corpus includes %2E (uppercase) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%2E'));
    assert.ok(slice.length > 0, 'no %2E variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false, `%2E token passed: ${JSON.stringify(t)}`);
    }
  });

  it('corpus includes %252e (double-encoded lowercase) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%252e'));
    assert.ok(slice.length > 0, 'no %252e variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %252E (double-encoded uppercase) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%252E'));
    assert.ok(slice.length > 0, 'no %252E variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });
});

describe('pathSafetyFuzz — encoded-sep case coverage', () => {
  it('corpus includes %2f (lowercase slash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%2f'));
    assert.ok(slice.length > 0, 'no %2f variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %2F (uppercase slash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%2F'));
    assert.ok(slice.length > 0, 'no %2F variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %252f (double-encoded slash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%252f'));
    assert.ok(slice.length > 0, 'no %252f variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %252F (double-encoded uppercase slash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%252F'));
    assert.ok(slice.length > 0, 'no %252F variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %5c (lowercase backslash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%5c'));
    assert.ok(slice.length > 0, 'no %5c variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %5C (uppercase backslash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%5C'));
    assert.ok(slice.length > 0, 'no %5C variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %255c (double-encoded backslash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%255c'));
    assert.ok(slice.length > 0, 'no %255c variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });

  it('corpus includes %255C (double-encoded uppercase backslash) variants, all rejected', () => {
    const slice = mutations.filter(m => m.includes('%255C'));
    assert.ok(slice.length > 0, 'no %255C variants found');
    for (const t of slice.slice(0, 20)) {
      assert.equal(checkPathSafety(t).safe, false);
    }
  });
});

describe('pathSafetyFuzz — null-byte injection at varied offsets', () => {
  it('\\x00 at position 0 produces rule: null-byte', () => {
    const token = '\x00secret';
    const r = checkPathSafety(token);
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'null-byte');
  });

  it('\\x00 at mid-token produces rule: null-byte', () => {
    const token = 'sec\x00ret';
    const r = checkPathSafety(token);
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'null-byte');
  });

  it('\\x00 at end-of-token produces rule: null-byte', () => {
    const token = 'secret\x00';
    const r = checkPathSafety(token);
    assert.equal(r.safe, false);
    if (!r.safe) assert.equal(r.rule, 'null-byte');
  });

  it('corpus includes \\x00 injected at every offset for each NULL_CONTEXT', () => {
    for (const ctx of NULL_CONTEXTS) {
      for (let pos = 0; pos <= ctx.length; pos++) {
        const token = `${ctx.slice(0, pos)}\x00${ctx.slice(pos)}`;
        const r = checkPathSafety(token);
        assert.equal(
          r.safe,
          false,
          `null at offset ${pos} in ${JSON.stringify(ctx)} should be unsafe`,
        );
        if (!r.safe) {
          assert.equal(r.rule, 'null-byte', `expected rule=null-byte, got ${r.rule}`);
        }
      }
    }
  });
});

describe('pathSafetyFuzz — encoded-null coverage', () => {
  it('%00 in corpus returns { safe: false, rule: encoded-null }', () => {
    const slice = mutations.filter(m => m.includes('%00') && !m.includes('\x00'));
    assert.ok(slice.length > 0, 'no %00 variants found');
    for (const t of slice.slice(0, 10)) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'encoded-null');
    }
  });

  it('%2500 in corpus returns { safe: false, rule: encoded-null }', () => {
    const slice = mutations.filter(m => m.includes('%2500'));
    assert.ok(slice.length > 0, 'no %2500 variants found');
    for (const t of slice.slice(0, 10)) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'encoded-null');
    }
  });
});

describe('pathSafetyFuzz — url-scheme prepend', () => {
  it('file:// prefix returns { safe: false, rule: url-scheme }', () => {
    const slice = mutations.filter(m => m.startsWith('file://'));
    assert.ok(slice.length > 0, 'no file:// variants found');
    for (const t of slice) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'url-scheme');
    }
  });

  it('http:// prefix returns { safe: false, rule: url-scheme }', () => {
    const slice = mutations.filter(m => m.startsWith('http://'));
    assert.ok(slice.length > 0, 'no http:// variants found');
    for (const t of slice) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'url-scheme');
    }
  });

  it('https:// prefix returns { safe: false, rule: url-scheme }', () => {
    const slice = mutations.filter(m => m.startsWith('https://'));
    assert.ok(slice.length > 0, 'no https:// variants found');
    for (const t of slice) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false);
      if (!r.safe) assert.equal(r.rule, 'url-scheme');
    }
  });
});

// ─── mixed-case hex coverage ──────────────────────────────────────────────────
// Verify that the corpus explicitly contains tokens with both lowercase and
// uppercase hex digits in percent-encoded sequences (e.g., %2e%2F, %5c%2E),
// and that all such tokens are rejected.  This prevents silent corpus shrinkage
// where mixed-case variants might be dropped in a future refactor.

describe('pathSafetyFuzz — mixed-case hex coverage', () => {
  // A mutation has mixed-case hex if it contains at least one lowercase encoded
  // form (%2e, %2f, %5c) AND at least one uppercase encoded form (%2E, %2F, %5C)
  // in the same token.  Class 1 produces these as a direct consequence of
  // iterating d1/d2 across both %2e and %2E forms.
  const mixedCaseSlice = mutations.filter(
    m => /(%2e|%2f|%5c)/.test(m) && /(%2E|%2F|%5C)/.test(m),
  );

  it('corpus contains mixed-case hex variants', () => {
    assert.ok(
      mixedCaseSlice.length >= 50,
      `expected >= 50 mixed-case hex mutations, got ${mixedCaseSlice.length}`,
    );
  });

  it('all mixed-case hex variants are rejected', () => {
    for (const t of mixedCaseSlice) {
      assert.equal(
        checkPathSafety(t).safe,
        false,
        `mixed-case hex token passed: ${JSON.stringify(t.slice(0, 60))}`,
      );
    }
  });
});

// ─── safe set ────────────────────────────────────────────────────────────────

describe('pathSafetyFuzz — safe set not flagged', () => {
  for (const token of SAFE_SET) {
    it(`allows: ${JSON.stringify(token)}`, () => {
      const r = checkPathSafety(token);
      assert.equal(
        r.safe,
        true,
        `expected safe=true for ${JSON.stringify(token)}`,
      );
    });
  }
});
