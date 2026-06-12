import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, dedupeKey, dedupeFindings } from '../../src/review/dedupe.js';
import type { Finding, Severity } from '../../src/findings/schema.js';
import { SOURCE } from '../../src/findings/sources.js';

function f(
  file: string,
  line: number | undefined,
  description: string,
  severity: Severity = 'medium',
  source: string = SOURCE.ADVERSARIAL,
): Finding {
  return {
    severity,
    category: 'test',
    location: line === undefined ? { file } : { file, line },
    description,
    source,
  };
}

describe('normalize', () => {
  it('lowercases', () => {
    assert.equal(normalize('Missing NULL Check'), 'missing null check');
  });

  it('collapses runs of whitespace to a single space', () => {
    assert.equal(normalize('a\t\n   b     c'), 'a b c');
  });

  it('strips punctuation but keeps letters, numbers, and spaces', () => {
    assert.equal(normalize('Hello,   World!! (foo) #42.'), 'hello world foo 42');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalize('   padded   '), 'padded');
  });

  it('preserves Unicode letters and numbers (\\p{L}/\\p{N})', () => {
    assert.equal(normalize('Café ñ 123'), 'café ñ 123');
  });

  it('makes case/spacing/punctuation variants identical', () => {
    const a = normalize('Missing null check');
    const b = normalize('missing   null   check!!!');
    const c = normalize('MISSING NULL CHECK.');
    assert.equal(a, b);
    assert.equal(b, c);
  });
});

describe('dedupeKey', () => {
  it('is `${file}|${line ?? ""}|${normalize(description)}`', () => {
    assert.equal(dedupeKey(f('src/a.ts', 10, 'Boom!')), 'src/a.ts|10|boom');
  });

  it('uses an empty string for a missing line', () => {
    assert.equal(dedupeKey(f('src/a.ts', undefined, 'Boom')), 'src/a.ts||boom');
  });

  it('does not collapse a line-pinned finding with an unlocated one', () => {
    assert.notEqual(
      dedupeKey(f('src/a.ts', 10, 'same')),
      dedupeKey(f('src/a.ts', undefined, 'same')),
    );
  });
});

describe('dedupeFindings', () => {
  it('collapses same (file, line) + identical-after-normalization descriptions into one', () => {
    const out = dedupeFindings([
      f('src/a.ts', 10, 'Missing null check', 'high', SOURCE.ADVERSARIAL),
      f('src/a.ts', 10, 'missing   null check!!!', 'high', SOURCE.EDGE_CASE),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].location.file, 'src/a.ts');
    assert.equal(out[0].location.line, 10);
  });

  it('keeps the most severe finding when duplicates disagree on severity', () => {
    const out = dedupeFindings([
      f('src/a.ts', 5, 'same issue', 'medium', SOURCE.CODE_REVIEW),
      f('src/a.ts', 5, 'same issue', 'blocker', SOURCE.ADVERSARIAL),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, 'blocker');
    assert.equal(out[0].source, SOURCE.ADVERSARIAL);
  });

  it('does NOT collapse findings on different lines', () => {
    const out = dedupeFindings([
      f('src/a.ts', 10, 'same issue'),
      f('src/a.ts', 11, 'same issue'),
    ]);
    assert.equal(out.length, 2);
  });

  it('does NOT collapse findings in different files', () => {
    const out = dedupeFindings([
      f('src/a.ts', 10, 'same issue'),
      f('src/b.ts', 10, 'same issue'),
    ]);
    assert.equal(out.length, 2);
  });

  it('preserves first-seen order of the surviving keys', () => {
    const out = dedupeFindings([
      f('src/z.ts', 1, 'first'),
      f('src/a.ts', 2, 'second'),
      f('src/z.ts', 1, 'FIRST'), // dupe of #0
    ]);
    assert.deepEqual(
      out.map((x) => x.description),
      ['first', 'second'],
    );
  });
});
