import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkPathSafety } from '../guardrails/pathSafety.js';

/**
 * Adversarial corpus for checkPathSafety, RE-SCOPED after the epic-098 gate.
 *
 * The prior version was a 2000-mutation percent-encoding fuzzer — but the gate
 * showed (a) shell tools don't decode `%2e`, so that was a false-positive
 * generator, and (b) a fuzzer assembled from the code's own match alphabet only
 * proves self-consistency, not security. This corpus instead:
 *   - fuzzes the classes actually defended (file: URIs in every form, null bytes
 *     and control chars at varied offsets) and asserts each is DENIED — including
 *     `file:/` (single slash), the demonstrated curl bypass;
 *   - asserts a realistic SAFE set is not flagged (no false positives);
 *   - carries an explicit DOCUMENTED-GAP corpus (triple-encoding, backslash,
 *     overlong UTF-8, homoglyphs) asserting they are NOT blocked — a tracked
 *     threat-model decision (resolution-layer concern), not a silent hole.
 * Deterministic (index-driven, no Math.random).
 */

// ─── file: URI fuzzer ──────────────────────────────────────────────────────────
// Cross scheme-casing × slash-count (0..3) × target path. curl treats all of
// these as the same local read, so all must be denied.
const FILE_CASINGS = ['file', 'FILE', 'File', 'fIlE'];
const SLASHES = ['', '/', '//', '///'];
const TARGETS = ['etc/passwd', 'Users/v/.ssh/id_rsa', 'a', '.env', 'root/.aws/credentials'];

const fileTokens: string[] = [];
for (const c of FILE_CASINGS) {
  for (const s of SLASHES) {
    for (const t of TARGETS) {
      fileTokens.push(`${c}:${s}${t}`);
    }
  }
}

// ─── null-byte / control-char injection at varied offsets ───────────────────────
const CONTROL_BYTES = ['\x00', '\x01', '\x08', '\x0a', '\x1f', '\x7f'];
const HOSTS = ['path/to/file', 'x', 'a/b/c'];
const controlTokens: string[] = [];
for (const byte of CONTROL_BYTES) {
  for (const ctx of HOSTS) {
    for (let pos = 0; pos <= ctx.length; pos++) {
      controlTokens.push(ctx.slice(0, pos) + byte + ctx.slice(pos));
    }
  }
}

const denyCorpus = [...fileTokens, ...controlTokens];

describe('pathSafetyFuzz — corpus size', () => {
  it('generates a non-trivial deterministic corpus', () => {
    assert.ok(new Set(denyCorpus).size >= 100, `expected >= 100 distinct tokens, got ${new Set(denyCorpus).size}`);
  });
});

describe('pathSafetyFuzz — every file: form is denied (incl. the file:/ bypass)', () => {
  it('all file: tokens return safe:false with rule file-scheme', () => {
    for (const t of fileTokens) {
      const r = checkPathSafety(t);
      assert.equal(r.safe, false, `file: token passed: ${JSON.stringify(t)}`);
      if (!r.safe) assert.equal(r.rule, 'file-scheme', `wrong rule for ${JSON.stringify(t)}`);
    }
  });

  it('the exact demonstrated bypass file:/etc/passwd is denied', () => {
    assert.equal(checkPathSafety('file:/etc/passwd').safe, false);
  });
});

describe('pathSafetyFuzz — null/control injection is denied', () => {
  it('all control-injected tokens return safe:false', () => {
    for (const t of controlTokens) {
      assert.equal(checkPathSafety(t).safe, false, `control token passed: ${JSON.stringify(t)}`);
    }
  });
});

describe('pathSafetyFuzz — safe set not flagged (no false positives)', () => {
  const SAFE = [
    'src/foo.ts', './a/b', '../within/ok', '..', 'a.b.c', 'filename.txt', 'dir/sub/',
    'https://github.com/o/r', 'ssh://git@host/x',
    '%2e%2e/secret', '..%2fsecret', 'report%2e2024.txt', 'a%20b',
    'my-file.txt', 'the file:// scheme docs',
  ];
  it('every safe path returns safe:true', () => {
    for (const t of SAFE) {
      assert.equal(checkPathSafety(t).safe, true, `false positive: ${JSON.stringify(t)}`);
    }
  });
});

describe('pathSafetyFuzz — documented out-of-scope gaps (tracked, not silent)', () => {
  // Deliberately NOT defended at this layer (see pathSafety.ts). If this flips to
  // safe:false, someone tightened the guard — update the doc decision with it.
  const GAPS = ['%25252f', '%25252e', '..\\..\\secret', '%c0%ae%c0%afsecret', '．．／secret', '..∕secret'];
  it('gap tokens are NOT blocked (resolution-layer concern by design)', () => {
    for (const t of GAPS) {
      assert.equal(checkPathSafety(t).safe, true, `gap token unexpectedly blocked: ${JSON.stringify(t)}`);
    }
  });
});
